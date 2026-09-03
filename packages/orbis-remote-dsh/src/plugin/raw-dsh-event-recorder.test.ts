import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { OrbisDshRawEventRecorder } from "./raw-dsh-event-recorder";

describe("OrbisDshRawEventRecorder", () => {
  test("records raw events in stable JSONL order and snapshots mutation at capture time", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-dsh-raw-events-"));
    const recordingDirectory = join(root, "recordings");
    const clockValues = [
      new Date("2026-08-29T01:02:03.000Z"),
      new Date("2026-08-29T01:02:03.001Z"),
      new Date("2026-08-29T01:02:03.002Z"),
      new Date("2026-08-29T01:02:03.003Z"),
    ];
    try {
      const recorder = new OrbisDshRawEventRecorder(recordingDirectory, {
        createId: () => "recording-1",
        now: () => clockValues.shift() ?? new Date("2026-08-29T01:02:03.004Z"),
      });

      const started = await recorder.start();
      expect(started).toMatchObject({
        eventCount: 0,
        exportAvailable: false,
        recordingId: "recording-1",
        startedAt: "2026-08-29T01:02:03.000Z",
        state: "recording",
      });

      const rawEvent = {
        data: {
          content: "中文\nemoji: 🧪",
          nested: [{ count: 1, value: "保留原始值" }],
        },
        type: "assistant/chunk",
      };
      recorder.capture("native-session-1", rawEvent);
      rawEvent.data.content = "mutated after capture";
      rawEvent.data.nested[0]!.count = 99;
      recorder.capture("native-session-2", {
        data: { authorization: "raw-secret-is-intentionally-not-redacted" },
        type: "tool/state.changed",
      });

      const stopped = await recorder.stop();
      expect(stopped).toMatchObject({
        eventCount: 2,
        exportAvailable: true,
        state: "stopped",
        stoppedAt: "2026-08-29T01:02:03.003Z",
      });

      const exportMetadata = await recorder.latestExport();
      expect(exportMetadata).toMatchObject({
        filename: "recording-1.jsonl",
        path: join(recordingDirectory, "recording-1.jsonl"),
      });
      expect(exportMetadata?.bytes).toBe(stopped.bytes);

      const contents = await readFile(exportMetadata!.path, "utf8");
      const records = contents
        .trim()
        .split("\n")
        .map((line: string) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toHaveLength(4);
      expect(records[0]).toEqual({
        format: "orbis-dsh-raw-events",
        kind: "header",
        recordingId: "recording-1",
        startedAt: "2026-08-29T01:02:03.000Z",
        version: 1,
      });
      expect(records[1]).toEqual({
        capturedAt: "2026-08-29T01:02:03.001Z",
        event: {
          data: {
            content: "中文\nemoji: 🧪",
            nested: [{ count: 1, value: "保留原始值" }],
          },
          type: "assistant/chunk",
        },
        kind: "event",
        nativeSessionId: "native-session-1",
        recordingId: "recording-1",
        sequence: 1,
      });
      expect(records[2]).toEqual({
        capturedAt: "2026-08-29T01:02:03.002Z",
        event: {
          data: { authorization: "raw-secret-is-intentionally-not-redacted" },
          type: "tool/state.changed",
        },
        kind: "event",
        nativeSessionId: "native-session-2",
        recordingId: "recording-1",
        sequence: 2,
      });
      expect(records[3]).toEqual({
        bytes: stopped.bytes,
        eventCount: 2,
        kind: "footer",
        recordingId: "recording-1",
        status: "stopped",
        stoppedAt: "2026-08-29T01:02:03.003Z",
      });
      expect(contents).toContain("raw-secret-is-intentionally-not-redacted");
      expect(Buffer.byteLength(contents, "utf8")).toBe(stopped.bytes);
      // Windows has no Unix mode bits — Node reports 0o666 for any regular
      // file there — so the owner-only guarantee is asserted on POSIX only.
      if (process.platform !== "win32") {
        expect((await stat(exportMetadata!.path)).mode & 0o777).toBe(0o600);
        expect((await stat(dirname(exportMetadata!.path))).mode & 0o777).toBe(0o700);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("waits for all queued events before writing the footer and disposing", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-dsh-raw-events-"));
    try {
      const recorder = new OrbisDshRawEventRecorder(join(root, "recordings"), {
        createId: () => "recording-2",
        now: () => new Date("2026-08-29T02:00:00.000Z"),
      });
      await recorder.start();
      const file = (recorder as unknown as { file: FileHandle }).file;
      const write = vi.spyOn(file, "write");
      for (let index = 0; index < 100; index += 1) {
        recorder.capture("session", { index, text: `event-${index}` });
      }

      await recorder.dispose();
      expect(write).toHaveBeenCalledTimes(2);
      const metadata = await recorder.latestExport();
      expect(metadata).toBeDefined();
      const records = (await readFile(metadata!.path, "utf8"))
        .trim()
        .split("\n")
        .map((line: string) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toHaveLength(102);
      expect(
        records.slice(1, -1).map((record: Record<string, unknown>) => record.sequence),
      ).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
      expect(records.at(-1)).toMatchObject({ eventCount: 100, kind: "footer", status: "stopped" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("enters failed state for an event that cannot be represented in JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-dsh-raw-events-"));
    try {
      const recorder = new OrbisDshRawEventRecorder(join(root, "recordings"), {
        createId: () => "recording-3",
        now: () => new Date("2026-08-29T03:00:00.000Z"),
      });
      await recorder.start();
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      recorder.capture("session", cyclic);

      expect(recorder.status()).toMatchObject({
        error: expect.stringMatching(/circular|cyclic/u),
        eventCount: 0,
        exportAvailable: false,
        state: "failed",
      });

      const stopped = await recorder.stop();
      expect(stopped.state).toBe("failed");
      expect(stopped.exportAvailable).toBe(false);
      expect(await recorder.latestExport()).toBeUndefined();
      const contents = await readFile(join(root, "recordings", "recording-3.jsonl"), "utf8");
      expect(JSON.parse(contents.trim().split("\n").at(-1)!).status).toBe("failed");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects starting a second recording while one is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-dsh-raw-events-"));
    try {
      const recorder = new OrbisDshRawEventRecorder(join(root, "recordings"), {
        createId: () => "recording-4",
        now: () => new Date("2026-08-29T04:00:00.000Z"),
      });
      await recorder.start();
      await expect(recorder.start()).rejects.toThrow(/active recording/u);
      await recorder.stop();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reports a disk write failure instead of exporting an incomplete recording", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-dsh-raw-events-"));
    try {
      const recorder = new OrbisDshRawEventRecorder(join(root, "recordings"), {
        createId: () => "recording-write-failure",
        now: () => new Date("2026-08-29T05:00:00.000Z"),
      });
      await recorder.start();
      const file = (recorder as unknown as { file: FileHandle }).file;
      vi.spyOn(file, "write").mockRejectedValueOnce(new Error("disk unavailable"));

      recorder.capture("session", { type: "assistant/chunk" });
      const stopped = await recorder.stop();

      expect(stopped).toMatchObject({
        error: "disk unavailable",
        eventCount: 1,
        exportAvailable: false,
        state: "failed",
      });
      expect(await recorder.latestExport()).toBeUndefined();
      const contents = await readFile(
        join(root, "recordings", "recording-write-failure.jsonl"),
        "utf8",
      );
      expect(JSON.parse(contents.trim().split("\n").at(-1)!)).toMatchObject({
        kind: "footer",
        status: "failed",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
