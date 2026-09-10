import { createReadStream, readFileSync } from "node:fs";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  OrbisDshRawEventReplayer,
  type OrbisDshRawEventReplayEvent,
  type OrbisDshRawEventReplayTarget,
} from "./raw-dsh-event-replayer";

const RAW_DEVELOPMENT_FIXTURE = new URL(
  "../../../../fixtures/dsh-run-stream-events.jsonl",
  import.meta.url,
);

/**
 * The fixture is a 17 MB Git LFS object. A checkout without LFS — which is
 * `actions/checkout`'s default — leaves a pointer file in its place, so the
 * case below would read the pointer as JSONL and fail for a reason that has
 * nothing to do with the replayer. Skip it there instead, and say why.
 */
function rawDevelopmentFixtureIsPointer(): boolean {
  try {
    const head = readFileSync(RAW_DEVELOPMENT_FIXTURE).subarray(0, 128).toString("utf8");
    return head.startsWith("version https://git-lfs.github.com/spec/v1");
  } catch {
    return true;
  }
}

function recordingLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function recording(
  input: {
    readonly capturedAt?: readonly string[];
    readonly nativeSessionIds?: readonly string[];
    readonly startSeq?: number;
  } = {},
): Buffer {
  const recordingId = "recording-1";
  const startSeq = input.startSeq ?? 3;
  const capturedAt = input.capturedAt ?? ["2026-08-30T01:00:00.000Z", "2026-08-30T01:00:00.010Z"];
  const nativeSessionIds = input.nativeSessionIds ?? ["source-session", "source-session"];
  const prefix = [
    recordingLine({
      format: "orbis-dsh-raw-events",
      kind: "header",
      recordingId,
      startedAt: "2026-08-30T00:59:59.000Z",
      version: 1,
    }),
    ...capturedAt.map((time, index) =>
      recordingLine({
        capturedAt: time,
        event: {
          data: index === 0 ? { turn: 1 } : { reason: { kind: "completed" }, turn: 1 },
          seq: startSeq + index,
          time: Date.parse(time),
          type: index === 0 ? "turn/start" : "turn/end",
        },
        kind: "event",
        nativeSessionId: nativeSessionIds[index],
        recordingId,
        sequence: index + 1,
      }),
    ),
  ].join("");
  const footerBase = {
    eventCount: capturedAt.length,
    kind: "footer",
    recordingId,
    status: "stopped",
    stoppedAt: "2026-08-30T01:00:01.000Z",
  } as const;
  let bytes = Buffer.byteLength(prefix, "utf8");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const footer = recordingLine({ ...footerBase, bytes });
    const next = Buffer.byteLength(prefix + footer, "utf8");
    if (next === bytes) return Buffer.from(prefix + footer);
    bytes = next;
  }
  throw new Error("test recording footer did not converge");
}

function recordingFromEvents(
  events: readonly OrbisDshRawEventReplayEvent[],
  input: {
    readonly capturedAt?: readonly string[];
    readonly nativeSessionIds?: readonly string[];
  } = {},
): Buffer {
  const recordingId = "recording-1";
  const capturedAt =
    input.capturedAt ??
    events.map((_, index) => `2026-08-30T01:00:00.${String(index).padStart(3, "0")}Z`);
  const nativeSessionIds = input.nativeSessionIds ?? events.map(() => "source-session");
  if (capturedAt.length !== events.length || nativeSessionIds.length !== events.length) {
    throw new Error("test recording metadata does not match its event count");
  }
  const prefix = [
    recordingLine({
      format: "orbis-dsh-raw-events",
      kind: "header",
      recordingId,
      startedAt: "2026-08-30T00:59:59.000Z",
      version: 1,
    }),
    ...events.map((event, index) =>
      recordingLine({
        capturedAt: capturedAt[index],
        event: { ...event, time: Date.parse(capturedAt[index]!) },
        kind: "event",
        nativeSessionId: nativeSessionIds[index],
        recordingId,
        sequence: index + 1,
      }),
    ),
  ].join("");
  const footerBase = {
    eventCount: events.length,
    kind: "footer",
    recordingId,
    status: "stopped",
    stoppedAt: "2026-08-30T01:00:01.000Z",
  } as const;
  let bytes = Buffer.byteLength(prefix, "utf8");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const footer = recordingLine({ ...footerBase, bytes });
    const next = Buffer.byteLength(prefix + footer, "utf8");
    if (next === bytes) return Buffer.from(prefix + footer);
    bytes = next;
  }
  throw new Error("test recording footer did not converge");
}

function target(
  options: {
    readonly appendSeqs?: readonly number[];
    readonly initialSeq?: number;
    readonly prefixEvents?: readonly OrbisDshRawEventReplayEvent[];
    readonly prepare?: (events: readonly OrbisDshRawEventReplayEvent[]) => void;
    readonly subscribed?: boolean;
  } = {},
) {
  let subscribed = options.subscribed ?? true;
  const listeners = new Set<(value: boolean) => void>();
  const events: OrbisDshRawEventReplayEvent[] = [];
  const flush = vi.fn(async () => undefined);
  const value: OrbisDshRawEventReplayTarget = {
    announce: vi.fn(),
    stream: vi.fn(),
    append(event) {
      events.push(event);
      return options.appendSeqs?.[events.length - 1] ?? event.seq;
    },
    flush,
    initialSeq: options.initialSeq ?? 3,
    isSubscribed: () => subscribed,
    observeSubscription(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prepare: options.prepare ?? (() => undefined),
    prefixEvents:
      options.prefixEvents ??
      Array.from({ length: options.initialSeq ?? 3 }, (_, seq) => ({
        data: { prefix: seq },
        seq,
        type: "test/prefix",
      })),
    sessionId: "replay-session",
  };
  return {
    events,
    flush,
    setSubscribed(next: boolean) {
      subscribed = next;
      for (const listener of listeners) listener(next);
    },
    target: value,
  };
}

function replayInput(bytes: Buffer, filename = "capture.jsonl") {
  return { data: Readable.from([bytes]), filename };
}

describe("raw DSH event replay", () => {
  it("creates a session, waits for its live app subscriber, and replays in order", async () => {
    const destination = target({ subscribed: false });
    const replayer = new OrbisDshRawEventReplayer(
      { createSession: vi.fn(async () => destination.target) },
      {
        createId: () => "replay-1",
        now: () => new Date("2026-08-30T02:00:00.000Z"),
        sleep: async () => undefined,
      },
    );

    await expect(replayer.start(replayInput(recording()))).resolves.toMatchObject({
      eventCount: 2,
      filename: "capture.jsonl",
      replayId: "replay-1",
      sessionId: "replay-session",
      state: "waiting",
    });
    expect(destination.events).toHaveLength(0);

    destination.setSubscribed(true);
    await expect(replayer.settled()).resolves.toMatchObject({
      replayedEventCount: 2,
      state: "completed",
    });
    expect(destination.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(destination.target.announce).toHaveBeenCalledOnce();
    expect(destination.flush).toHaveBeenCalledOnce();
  });

  it("rejects a recording that cannot continue a fresh session sequence", async () => {
    const destination = target({ initialSeq: 0 });
    const replayer = new OrbisDshRawEventReplayer({
      createSession: async () => destination.target,
    });

    await expect(replayer.start(replayInput(recording()))).rejects.toThrow(
      "recording starts at native seq 3",
    );
    expect(replayer.status()).toMatchObject({ state: "failed" });
    expect(destination.events).toHaveLength(0);
  });

  it("recognizes and skips an identical session-creation prefix captured from seq zero", async () => {
    const prefixEvents = [
      { data: { turn: 1 }, seq: 0, type: "turn/start" },
      { data: { reason: { kind: "completed" }, turn: 1 }, seq: 1, type: "turn/end" },
    ] satisfies readonly OrbisDshRawEventReplayEvent[];
    const destination = target({ initialSeq: 2, prefixEvents });
    const replayer = new OrbisDshRawEventReplayer(
      { createSession: async () => destination.target },
      { sleep: async () => undefined },
    );

    await replayer.start(replayInput(recording({ startSeq: 0 })));
    await expect(replayer.settled()).resolves.toMatchObject({
      eventCount: 2,
      replayedEventCount: 2,
      state: "completed",
    });
    expect(destination.events).toHaveLength(0);
  });

  it("rejects files containing multiple native sessions instead of mixing their histories", async () => {
    const destination = target();
    const createSession = vi.fn(async () => destination.target);
    const replayer = new OrbisDshRawEventReplayer({ createSession });

    await expect(
      replayer.start(
        replayInput(recording({ nativeSessionIds: ["source-session", "other-session"] })),
      ),
    ).rejects.toThrow("exactly one DSH session");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("requires V3 surface replacement coordinates", async () => {
    const createSession = vi.fn(async () => target().target);
    const replayer = new OrbisDshRawEventReplayer({ createSession });
    const event = {
      data: { content: [{ type: "text", text: "replacement" }] },
      seq: 3,
      sourceEventSeqs: [0],
      surfaceOp: {
        end: 0,
        op: "replace",
        start: 0,
      } as unknown as OrbisDshRawEventReplayEvent["surfaceOp"],
      type: "user/message",
    } satisfies OrbisDshRawEventReplayEvent;

    await expect(replayer.start(replayInput(recordingFromEvents([event])))).rejects.toThrow(
      "invalid startSeq",
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects assistant provenance because V3 embeds its source stream", async () => {
    const createSession = vi.fn(async () => target().target);
    const replayer = new OrbisDshRawEventReplayer({ createSession });
    const event = {
      data: { message: { content: [] }, stream: [], step: 1, turn: 1 },
      seq: 3,
      sourceEventSeqs: [0],
      surfaceOp: "append",
      type: "assistant/message",
    } satisfies OrbisDshRawEventReplayEvent;

    await expect(replayer.start(replayInput(recordingFromEvents([event])))).rejects.toThrow(
      "assistant/message cannot carry sourceEventSeqs",
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it("maps V3 source references and replacement coordinates into target sequences", async () => {
    const destination = target({ appendSeqs: [10, 11, 12], initialSeq: 2 });
    const replayer = new OrbisDshRawEventReplayer(
      { createSession: async () => destination.target },
      { sleep: async () => undefined },
    );
    const events = [
      {
        data: { message: { content: [] }, stream: [], step: 1, turn: 1 },
        seq: 2,
        surfaceOp: "append",
        type: "assistant/message",
      },
      {
        data: { content: [{ type: "text", text: "replacement" }] },
        seq: 3,
        surfaceOp: "append",
        type: "user/message",
      },
      {
        data: { content: [{ type: "text", text: "replacement" }] },
        seq: 4,
        sourceEventSeqs: [2, 3],
        surfaceOp: { endSeq: 2, op: "replace", startSeq: 3 },
        type: "user/message",
      },
    ] satisfies readonly OrbisDshRawEventReplayEvent[];

    await replayer.start(replayInput(recordingFromEvents(events)));
    await expect(replayer.settled()).resolves.toMatchObject({
      replayedEventCount: 3,
      state: "completed",
    });
    expect(destination.target.stream).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "end",
        outcome: { kind: "committed", eventType: "assistant/message", seq: 10 },
      }),
    );
    expect(destination.events).toMatchObject([
      { seq: 2, surfaceOp: "append", type: "assistant/message" },
      { seq: 3, surfaceOp: "append", type: "user/message" },
      {
        seq: 4,
        sourceEventSeqs: [10, 11],
        surfaceOp: { endSeq: 10, op: "replace", startSeq: 11 },
        type: "user/message",
      },
    ]);
  });

  it.skipIf(rawDevelopmentFixtureIsPointer())(
    "rejects the pre-V3 fixture instead of silently converting assistant provenance",
    async () => {
      const createSession = vi.fn(async () => target().target);
      const replayer = new OrbisDshRawEventReplayer({ createSession });
      const fixture = createReadStream(RAW_DEVELOPMENT_FIXTURE);

      await expect(
        replayer.start({ data: fixture, filename: "dsh-run-stream-events.jsonl" }),
      ).rejects.toThrow("assistant/message cannot carry sourceEventSeqs");
      expect(createSession).not.toHaveBeenCalled();
    },
    15_000,
  );
});
