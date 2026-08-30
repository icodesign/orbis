import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";

import { describe, expect, it, vi } from "vitest";

import type { OrbisDshHostService } from "./host-service";
import {
  createOrbisHttpRoute,
  type OrbisRawDshEventRecorderPort,
  type OrbisRawDshEventRecordingStatus,
  type OrbisRawDshEventReplayerPort,
} from "./http-api";

class TestResponse extends Writable {
  readonly chunks: Buffer[] = [];
  readonly responseHeaders: Record<string, string> = {};
  responseStatus = 0;

  writeHead(status: number, headers: Record<string, string>): this {
    this.responseStatus = status;
    for (const [name, value] of Object.entries(headers)) {
      this.responseHeaders[name.toLowerCase()] = String(value);
    }
    return this;
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    done();
  }

  body(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

const stoppedStatus: OrbisRawDshEventRecordingStatus = {
  bytes: 123,
  eventCount: 2,
  exportAvailable: true,
  recordingId: "recording-1",
  startedAt: "2026-08-29T01:00:00.000Z",
  state: "stopped",
  stoppedAt: "2026-08-29T01:00:01.000Z",
};

function fakeService(): OrbisDshHostService {
  return {
    status: async () => ({ connection: { state: "connected" } }),
  } as unknown as OrbisDshHostService;
}

function fakeRecorder(
  overrides: Partial<OrbisRawDshEventRecorderPort> = {},
): OrbisRawDshEventRecorderPort {
  return {
    latestExport: vi.fn(async () => undefined),
    start: vi.fn(
      async (): Promise<OrbisRawDshEventRecordingStatus> => ({
        ...stoppedStatus,
        state: "recording",
      }),
    ),
    status: vi.fn(() => stoppedStatus),
    stop: vi.fn(async () => stoppedStatus),
    ...overrides,
  };
}

const idleReplayStatus = {
  eventCount: 0,
  replayedEventCount: 0,
  state: "idle" as const,
};

function fakeReplayer(
  overrides: Partial<OrbisRawDshEventReplayerPort> = {},
): OrbisRawDshEventReplayerPort {
  return {
    cancel: vi.fn(async () => ({ ...idleReplayStatus, state: "cancelled" as const })),
    start: vi.fn(async () => ({ ...idleReplayStatus, state: "waiting" as const })),
    status: vi.fn(() => idleReplayStatus),
    ...overrides,
  };
}

async function invoke(input: {
  readonly host?: string;
  readonly method: string;
  readonly recorder?: OrbisRawDshEventRecorderPort;
  readonly replayer?: OrbisRawDshEventReplayerPort;
  readonly body?: Buffer;
  readonly headers?: Record<string, string>;
  readonly url: string;
}): Promise<TestResponse> {
  const request = Readable.from(
    input.body === undefined ? [] : [input.body],
  ) as unknown as IncomingMessage;
  request.headers = { host: input.host ?? "127.0.0.1:4111", ...input.headers };
  request.method = input.method;
  request.url = input.url;
  const response = new TestResponse();
  await createOrbisHttpRoute(fakeService(), input.recorder, input.replayer).handler(
    request,
    response as unknown as ServerResponse,
  );
  if (!response.writableFinished) await finished(response);
  return response;
}

describe("raw DSH event recording HTTP route", () => {
  it("is absent when the development recorder is disabled", async () => {
    const response = await invoke({ method: "GET", url: "/orbis/recording" });

    expect(response.responseStatus).toBe(404);
    expect(JSON.parse(response.body().toString("utf8"))).toEqual({
      error: "DSH event recording is unavailable",
    });
  });

  it("keeps recorder controls behind the loopback request fence", async () => {
    const start = vi.fn(async () => ({ ...stoppedStatus, state: "recording" as const }));
    const recorder = fakeRecorder({ start });

    const response = await invoke({
      host: "example.test",
      method: "POST",
      recorder,
      url: "/orbis/recording",
    });

    expect(response.responseStatus).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });

  it("exposes status and explicit start/stop lifecycle operations", async () => {
    const start = vi.fn(
      async (): Promise<OrbisRawDshEventRecordingStatus> => ({
        ...stoppedStatus,
        state: "recording",
      }),
    );
    const stop = vi.fn(async () => stoppedStatus);
    const recorder = fakeRecorder({ start, stop });

    const status = await invoke({ method: "GET", recorder, url: "/orbis/recording" });
    const started = await invoke({ method: "POST", recorder, url: "/orbis/recording" });
    const stopped = await invoke({ method: "DELETE", recorder, url: "/orbis/recording" });

    expect(JSON.parse(status.body().toString("utf8"))).toEqual(stoppedStatus);
    expect(started.responseStatus).toBe(200);
    expect(stopped.responseStatus).toBe(200);
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("streams only the recorder-owned latest artifact as an attachment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-http-recording-"));
    try {
      const path = join(directory, "capture.jsonl");
      const bytes = Buffer.from('{"kind":"event","event":{"raw":true}}\n');
      await writeFile(path, bytes);
      const recorder = fakeRecorder({
        latestExport: vi.fn(async () => ({
          bytes: bytes.byteLength,
          filename: 'capture".jsonl',
          path,
        })),
      });

      const response = await invoke({
        method: "GET",
        recorder,
        url: "/orbis/recording/export?ignored=1",
      });

      expect(response.responseStatus).toBe(200);
      expect(response.responseHeaders["content-disposition"]).toBe(
        'attachment; filename="capture_.jsonl"',
      );
      expect(response.responseHeaders["content-type"]).toBe("application/x-ndjson; charset=utf-8");
      expect(response.responseHeaders["cache-control"]).toBe("no-store");
      expect(response.body()).toEqual(await readFile(path));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("raw DSH event replay HTTP route", () => {
  it("is absent outside the development recording environment", async () => {
    const response = await invoke({ method: "GET", url: "/orbis/replay" });

    expect(response.responseStatus).toBe(404);
    expect(JSON.parse(response.body().toString("utf8"))).toEqual({
      error: "DSH event replay is unavailable",
    });
  });

  it("streams the selected JSONL body into the replayer without accepting a server path", async () => {
    const body = Buffer.from('{"kind":"header"}\n');
    let received = Buffer.alloc(0);
    const start = vi.fn(async (input: Parameters<OrbisRawDshEventReplayerPort["start"]>[0]) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.data) chunks.push(Buffer.from(chunk));
      received = Buffer.concat(chunks);
      expect(input.filename).toBe("daily capture.jsonl");
      return { ...idleReplayStatus, state: "waiting" as const };
    });
    const replayer = fakeReplayer({ start });

    const response = await invoke({
      body,
      headers: { "x-orbis-replay-filename": encodeURIComponent("daily capture.jsonl") },
      method: "POST",
      replayer,
      url: "/orbis/replay",
    });

    expect(response.responseStatus).toBe(200);
    expect(received).toEqual(body);
    expect(start).toHaveBeenCalledOnce();
  });

  it("prevents recording and replay from running at the same time", async () => {
    const recorder = fakeRecorder({
      status: vi.fn(() => ({ ...stoppedStatus, state: "recording" as const })),
    });
    const replayer = fakeReplayer();

    const replayResponse = await invoke({
      body: Buffer.from("ignored"),
      method: "POST",
      recorder,
      replayer,
      url: "/orbis/replay",
    });
    expect(replayResponse.responseStatus).toBe(400);
    expect(replayer.start).not.toHaveBeenCalled();

    const activeReplayer = fakeReplayer({
      status: vi.fn(() => ({ ...idleReplayStatus, state: "waiting" as const })),
    });
    const recordingResponse = await invoke({
      method: "POST",
      recorder: fakeRecorder(),
      replayer: activeReplayer,
      url: "/orbis/recording",
    });
    expect(recordingResponse.responseStatus).toBe(400);
  });
});
