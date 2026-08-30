import {
  agentBackendId,
  agentDriverId,
  agentEntryId,
  agentEventId,
  agentSessionId,
  agentTimestamp,
  type AgentTimestamp,
} from "@orbisapp/orbis-agent-backend";
import { describe, expect, test } from "vitest";

import {
  DSH_DELTA_COALESCE_WINDOW_MS,
  DshDeltaCoalescer,
  type DshDeltaInput,
  type DshDeltaScheduler,
} from "./dsh-delta-coalescer";

const FIXED_TIME = agentTimestamp("2026-08-25T00:00:00.000Z");
const BACKEND_ID = agentBackendId("local");
const DRIVER_ID = agentDriverId("dsh");
const SESSION_ID = agentSessionId("session-1");

class ManualScheduler implements DshDeltaScheduler {
  private nextHandle = 0;
  private readonly timers = new Map<number, () => void>();

  readonly delays: number[] = [];

  setTimeout(callback: () => void, delayMs: number): number {
    const handle = ++this.nextHandle;
    this.delays.push(delayMs);
    this.timers.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  runNext(): void {
    const timer = this.timers.entries().next().value as [number, () => void] | undefined;
    if (timer === undefined) return;
    this.timers.delete(timer[0]);
    timer[1]();
  }

  runAll(): void {
    while (this.timers.size > 0) this.runNext();
  }
}

function delta(
  sequence: number,
  value: string,
  options: {
    readonly blockIndex?: number;
    readonly entryId?: string;
    readonly part?: DshDeltaInput["payload"]["part"];
    readonly occurredAt?: AgentTimestamp;
  } = {},
): DshDeltaInput {
  return {
    eventId: agentEventId(`event-${sequence}`),
    occurredAt: options.occurredAt ?? FIXED_TIME,
    payload: {
      blockIndex: options.blockIndex ?? 0,
      delta: value,
      entryId: agentEntryId(options.entryId ?? "entry-1"),
      part: options.part ?? "text",
    },
    sessionId: SESSION_ID,
    source: { backendId: BACKEND_ID, driverId: DRIVER_ID, nativeType: "assistant/chunk" },
  };
}

describe("DshDeltaCoalescer", () => {
  test("merges the same key in one fixed 50ms window", () => {
    const scheduler = new ManualScheduler();
    let nextChunkSeq = 0;
    const emitted: Array<{ readonly chunkSeq: number; readonly delta: DshDeltaInput }> = [];
    const coalescer = new DshDeltaCoalescer({
      emit: (item) => emitted.push({ chunkSeq: ++nextChunkSeq, delta: item }),
      scheduler,
    });

    coalescer.push(delta(1, "a"));
    coalescer.push(delta(2, "b"));

    expect(emitted).toEqual([]);
    expect(scheduler.delays).toEqual([DSH_DELTA_COALESCE_WINDOW_MS]);
    scheduler.runNext();

    expect(emitted.map(({ chunkSeq, delta: item }) => [chunkSeq, item.payload.delta])).toEqual([
      [1, "ab"],
    ]);
  });

  test("flushes at entry, part, and block boundaries without reordering", () => {
    const scheduler = new ManualScheduler();
    let nextChunkSeq = 0;
    const emitted: Array<{ readonly chunkSeq: number; readonly delta: DshDeltaInput }> = [];
    const coalescer = new DshDeltaCoalescer({
      emit: (item) => emitted.push({ chunkSeq: ++nextChunkSeq, delta: item }),
      scheduler,
    });

    coalescer.push(delta(1, "a", { entryId: "entry-1" }));
    coalescer.push(delta(2, "b", { entryId: "entry-2" }));
    coalescer.push(delta(3, "c", { entryId: "entry-2", part: "thinking" }));
    coalescer.push(delta(4, "d", { entryId: "entry-2", part: "thinking", blockIndex: 1 }));
    scheduler.runNext();

    expect(
      emitted.map(({ chunkSeq, delta: item }) => [
        chunkSeq,
        item.payload.entryId,
        item.payload.part,
        item.payload.blockIndex,
        item.payload.delta,
      ]),
    ).toEqual([
      [1, "entry-1", "text", 0, "a"],
      [2, "entry-2", "text", 0, "b"],
      [3, "entry-2", "thinking", 0, "c"],
      [4, "entry-2", "thinking", 1, "d"],
    ]);
  });

  test("does not extend the fixed window when more same-key chunks arrive", () => {
    const scheduler = new ManualScheduler();
    const emitted: DshDeltaInput[] = [];
    const coalescer = new DshDeltaCoalescer({
      emit: (item) => emitted.push(item),
      scheduler,
    });

    coalescer.push(delta(1, "a"));
    coalescer.push(delta(2, "b"));
    coalescer.push(delta(3, "c"));

    expect(scheduler.delays).toEqual([DSH_DELTA_COALESCE_WINDOW_MS]);
    scheduler.runNext();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload.delta).toBe("abc");
  });

  test("keeps the newest event metadata while preserving the merged payload", () => {
    const scheduler = new ManualScheduler();
    const emitted: DshDeltaInput[] = [];
    const coalescer = new DshDeltaCoalescer({
      emit: (item) => emitted.push(item),
      scheduler,
    });
    const first = delta(1, "a", { occurredAt: agentTimestamp("2026-08-25T00:00:00.001Z") });
    const second = delta(2, "b", { occurredAt: agentTimestamp("2026-08-25T00:00:00.002Z") });

    coalescer.push(first);
    coalescer.push(second);
    scheduler.runNext();

    expect(emitted).toEqual([
      {
        ...second,
        payload: { ...second.payload, delta: "ab" },
      },
    ]);
  });

  test("flushes synchronously before completion and ignores late timer callbacks after close", () => {
    const scheduler = new ManualScheduler();
    const emitted: DshDeltaInput[] = [];
    const coalescer = new DshDeltaCoalescer({
      emit: (item) => emitted.push(item),
      scheduler,
    });

    coalescer.push(delta(1, "answer"));
    expect(emitted).toEqual([]);
    coalescer.flush();
    expect(emitted.map((item) => item.payload.delta)).toEqual(["answer"]);

    coalescer.push(delta(2, "tail"));
    coalescer.close();
    coalescer.push(delta(3, "late"));
    scheduler.runAll();

    expect(emitted.map((item) => item.payload.delta)).toEqual(["answer", "tail"]);
  });

  test("ignores a stale callback after the window was flushed and reused", () => {
    const callbacks: Array<() => void> = [];
    const scheduler: DshDeltaScheduler = {
      clearTimeout: () => undefined,
      setTimeout: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
    };
    const emitted: DshDeltaInput[] = [];
    const coalescer = new DshDeltaCoalescer({
      emit: (item) => emitted.push(item),
      scheduler,
    });

    coalescer.push(delta(1, "first"));
    coalescer.flush();
    coalescer.push(delta(2, "second"));
    callbacks[0]?.();
    expect(emitted.map((item) => item.payload.delta)).toEqual(["first"]);

    callbacks[1]?.();

    expect(emitted.map((item) => item.payload.delta)).toEqual(["first", "second"]);
  });
});
