import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { describe, expect, it, vi } from "vitest";

import {
  OrbisDshRawEventReplayer,
  type OrbisDshRawEventReplayEvent,
  type OrbisDshRawEventReplayTarget,
} from "./raw-dsh-event-replayer";

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

function target(
  options: {
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
    append(event) {
      events.push(event);
      return event.seq;
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

  it("accepts the checked-in raw development fixture without bench-specific conversion", async () => {
    const session = Session.create(SessionId("replay-validation"));
    const append = session.append.bind(session) as (
      type: string,
      data: unknown,
      options?: unknown,
    ) => { readonly seq: number };
    append("permission/preset", { preset: "workspace-write" });
    append("sandbox/mode", { mode: "workspace-write" });
    append("approval/policy", { policy: "ask" });
    const destination: OrbisDshRawEventReplayTarget = {
      announce: () => undefined,
      append(event) {
        const options =
          event.surfaceOp === undefined && event.sourceEventSeqs === undefined
            ? undefined
            : {
                ...(event.sourceEventSeqs === undefined
                  ? {}
                  : { sourceEventSeqs: event.sourceEventSeqs }),
                ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
              };
        return options === undefined
          ? append(event.type, event.data).seq
          : append(event.type, event.data, options).seq;
      },
      flush: async () => undefined,
      initialSeq: session.seq,
      isSubscribed: () => true,
      observeSubscription: () => () => undefined,
      prepare() {
        append("session/title", {
          messageSeqs: [],
          source: { kind: "user" },
          title: "Replay validation",
        });
      },
      prefixEvents: session.snapshotEvents().map((event) => {
        const metadata = event as typeof event & {
          readonly sourceEventSeqs?: readonly number[];
          readonly surfaceOp?: OrbisDshRawEventReplayEvent["surfaceOp"];
        };
        return {
          data: event.data,
          seq: event.seq,
          ...(metadata.sourceEventSeqs === undefined
            ? {}
            : { sourceEventSeqs: metadata.sourceEventSeqs }),
          ...(metadata.surfaceOp === undefined ? {} : { surfaceOp: metadata.surfaceOp }),
          type: event.type,
        };
      }),
      sessionId: String(session.id),
    };
    const replayer = new OrbisDshRawEventReplayer(
      { createSession: async () => destination },
      { sleep: async () => undefined },
    );
    const fixture = createReadStream(
      new URL("../../../../fixtures/dsh-run-stream-events.jsonl", import.meta.url),
    );

    await replayer.start({ data: fixture, filename: "dsh-run-stream-events.jsonl" });
    await expect(replayer.settled()).resolves.toMatchObject({
      eventCount: 45_948,
      replayedEventCount: 45_948,
      state: "completed",
    });
    expect(session.seq).toBe(45_952);
  }, 15_000);
});
