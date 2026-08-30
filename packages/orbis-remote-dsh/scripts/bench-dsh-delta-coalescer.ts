import {
  agentBackendId,
  agentDriverId,
  agentEntryId,
  agentEventId,
  agentSessionId,
  agentTimestamp,
} from "@orbisapp/orbis-agent-backend";

import {
  DSH_DELTA_COALESCE_WINDOW_MS,
  DshDeltaCoalescer,
  type DshDeltaInput,
  type DshDeltaScheduler,
} from "../src/adapter/dsh-delta-coalescer.ts";

const SESSION_ID = agentSessionId("bench-session");
const BACKEND_ID = agentBackendId("bench");
const DRIVER_ID = agentDriverId("dsh");
const OCCURRED_AT = agentTimestamp("2026-08-29T00:00:00.000Z");
const TEXT_ENCODER = new TextEncoder();
const runtimeProcess = (
  globalThis as typeof globalThis & {
    readonly process?: { readonly argv?: readonly string[] };
  }
).process;
const BENCH_ARGUMENTS = [...(runtimeProcess?.argv ?? [])]
  .slice(2)
  .filter((argument) => argument !== "--");
const ASSERTIONS_ENABLED = BENCH_ARGUMENTS.includes("--assert");

if (BENCH_ARGUMENTS.some((argument) => argument !== "--assert")) {
  throw new Error("Usage: pnpm run bench:delta [--assert]");
}

interface BenchResult {
  readonly emittedDeltas: number;
  readonly emittedPayloadBytes: number;
  readonly payloadBytes: number;
  readonly rawChunks: number;
  readonly rawPayloadBytes: number;
  readonly scenario: string;
  readonly wallTimeMs: number;
}

interface DeltaKey {
  readonly blockIndex: number;
  readonly entryId: string;
  readonly part: DshDeltaInput["payload"]["part"];
}

interface BoundaryGroup {
  readonly chunk: string;
  readonly count: number;
  readonly flushAfter?: boolean;
  readonly key: DeltaKey;
}

interface BoundaryFixture {
  readonly groups: readonly (BoundaryGroup & { readonly items: readonly DshDeltaInput[] })[];
  readonly rawChunks: number;
  readonly rawPayloadBytes: number;
}

/** Delays callbacks so the fixture controls exactly when each 50ms window ends. */
class DeferredScheduler implements DshDeltaScheduler {
  private nextHandle = 0;
  private readonly callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void, delayMs: number): number {
    if (delayMs !== DSH_DELTA_COALESCE_WINDOW_MS) {
      throw new Error(`unexpected coalescing delay: ${delayMs}`);
    }
    const handle = ++this.nextHandle;
    this.callbacks.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  runAll(): void {
    while (this.callbacks.size > 0) {
      const timer = this.callbacks.entries().next().value as [number, () => void] | undefined;
      if (timer === undefined) return;
      this.callbacks.delete(timer[0]);
      timer[1]();
    }
  }
}

function delta(sequence: number, value: string, key: DeltaKey): DshDeltaInput {
  return {
    eventId: agentEventId(`bench-event-${sequence}`),
    occurredAt: OCCURRED_AT,
    payload: {
      blockIndex: key.blockIndex,
      delta: value,
      entryId: agentEntryId(key.entryId),
      part: key.part,
    },
    sessionId: SESSION_ID,
    source: { backendId: BACKEND_ID, driverId: DRIVER_ID, nativeType: "assistant/chunk" },
  };
}

function makeHighFrequencyFixture(): DshDeltaInput[] {
  const key: DeltaKey = { blockIndex: 0, entryId: "entry-high-frequency", part: "text" };
  return Array.from({ length: 20_000 }, (_, index) => delta(index, "x", key));
}

function makeBoundaryGroups(): BoundaryGroup[] {
  return [
    {
      chunk: "a",
      count: 1_500,
      flushAfter: true,
      key: { blockIndex: 0, entryId: "entry-boundary", part: "text" },
    },
    {
      chunk: "b",
      count: 1_500,
      key: { blockIndex: 0, entryId: "entry-boundary", part: "text" },
    },
    {
      chunk: "c",
      count: 1_500,
      key: { blockIndex: 0, entryId: "entry-boundary", part: "thinking" },
    },
    {
      chunk: "d",
      count: 1_500,
      key: { blockIndex: 1, entryId: "entry-boundary", part: "thinking" },
    },
    {
      chunk: "e",
      count: 1_500,
      key: { blockIndex: 0, entryId: "entry-next", part: "text" },
    },
  ];
}

function makeBoundaryFixture(): BoundaryFixture {
  let sequence = 0;
  const groups = makeBoundaryGroups().map((group) => ({
    ...group,
    items: Array.from({ length: group.count }, () => {
      const item = delta(sequence, group.chunk, group.key);
      sequence += 1;
      return item;
    }),
  }));
  const rawChunks = groups.reduce((total, group) => total + group.items.length, 0);
  const rawPayloadBytes = groups.reduce(
    (total, group) =>
      total + group.items.reduce((groupTotal, item) => groupTotal + bytes(item.payload.delta), 0),
    0,
  );
  return { groups, rawChunks, rawPayloadBytes };
}

function bytes(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength;
}

function sameKey(left: DshDeltaInput, right: DshDeltaInput): boolean {
  return (
    left.payload.entryId === right.payload.entryId &&
    left.payload.part === right.payload.part &&
    left.payload.blockIndex === right.payload.blockIndex
  );
}

function assertBench(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`[bench] assertion failed: ${message}`);
}

function payloadText(items: readonly DshDeltaInput[]): string {
  return items.map((item) => item.payload.delta).join("");
}

function runHighFrequencyFixture(): BenchResult {
  const fixture = makeHighFrequencyFixture();
  const scheduler = new DeferredScheduler();
  const emitted: DshDeltaInput[] = [];
  const rawPayloadBytes = fixture.reduce((total, item) => total + bytes(item.payload.delta), 0);
  const coalescer = new DshDeltaCoalescer({
    emit: (item) => emitted.push(item),
    scheduler,
  });

  const startedAt = performance.now();
  for (const item of fixture) coalescer.push(item);
  scheduler.runAll();
  const wallTimeMs = performance.now() - startedAt;
  const emittedPayloadBytes = emitted.reduce((total, item) => total + bytes(item.payload.delta), 0);

  if (ASSERTIONS_ENABLED) {
    assertBench(
      emitted.length === 1,
      `stable stream emitted ${emitted.length} deltas instead of one fixed-window delta`,
    );
    assertBench(
      emitted.length < fixture.length / 10,
      `stable stream emitted ${emitted.length} deltas for ${fixture.length} raw chunks`,
    );
    assertBench(
      payloadText(emitted) === payloadText(fixture),
      "stable stream emitted payload differs from the raw payload",
    );
    assertBench(
      emittedPayloadBytes === rawPayloadBytes,
      `stable stream payload bytes changed (${emittedPayloadBytes} != ${rawPayloadBytes})`,
    );
  }

  return {
    emittedDeltas: emitted.length,
    emittedPayloadBytes,
    payloadBytes: emittedPayloadBytes,
    rawChunks: fixture.length,
    rawPayloadBytes,
    scenario: "high-frequency-small-chunks",
    wallTimeMs,
  };
}

function runBoundaryFixture(): BenchResult {
  const fixture = makeBoundaryFixture();
  const scheduler = new DeferredScheduler();
  const emitted: DshDeltaInput[] = [];
  const coalescer = new DshDeltaCoalescer({
    emit: (item) => emitted.push(item),
    scheduler,
  });
  const expectedGroupPayloads = fixture.groups.map((group) => payloadText(group.items));

  const startedAt = performance.now();
  for (const [groupIndex, group] of fixture.groups.entries()) {
    const firstItem = group.items[0];
    const previousItem = fixture.groups[groupIndex - 1]?.items.at(-1);
    const keyBoundary =
      firstItem !== undefined && previousItem !== undefined && !sameKey(previousItem, firstItem);
    for (const [itemIndex, item] of group.items.entries()) {
      coalescer.push(item);
      if (ASSERTIONS_ENABLED && keyBoundary && itemIndex === 0) {
        assertBench(
          emitted.length === groupIndex,
          `key boundary before group ${groupIndex} did not flush immediately`,
        );
        assertBench(
          emitted[groupIndex - 1]?.payload.delta === expectedGroupPayloads[groupIndex - 1],
          `key boundary before group ${groupIndex} emitted the wrong preceding text`,
        );
      }
    }
    if (group.flushAfter) {
      coalescer.flush();
      if (ASSERTIONS_ENABLED) {
        assertBench(
          emitted.length === groupIndex + 1,
          `explicit flush after group ${groupIndex} emitted ${emitted.length} deltas`,
        );
        assertBench(
          emitted[groupIndex]?.payload.delta === expectedGroupPayloads[groupIndex],
          `explicit flush after group ${groupIndex} emitted the wrong text`,
        );
      }
    }
  }
  scheduler.runAll();
  const wallTimeMs = performance.now() - startedAt;
  const emittedPayloadBytes = emitted.reduce((total, item) => total + bytes(item.payload.delta), 0);

  if (ASSERTIONS_ENABLED) {
    const expectedKeys = fixture.groups.map((group) => {
      const item = group.items[0];
      return [item?.payload.entryId, item?.payload.part, item?.payload.blockIndex];
    });
    const actualKeys = emitted.map((item) => [
      item.payload.entryId,
      item.payload.part,
      item.payload.blockIndex,
    ]);
    assertBench(
      emitted.length === fixture.groups.length,
      `boundary fixture emitted ${emitted.length} deltas for ${fixture.groups.length} groups`,
    );
    assertBench(
      JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
      "boundary fixture changed key order",
    );
    assertBench(
      emitted.map((item) => item.payload.delta).join("") === expectedGroupPayloads.join(""),
      "boundary fixture changed payload order or text",
    );
    assertBench(
      emittedPayloadBytes === fixture.rawPayloadBytes,
      `boundary payload bytes changed (${emittedPayloadBytes} != ${fixture.rawPayloadBytes})`,
    );
  }

  return {
    emittedDeltas: emitted.length,
    emittedPayloadBytes,
    payloadBytes: emittedPayloadBytes,
    rawChunks: fixture.rawChunks,
    rawPayloadBytes: fixture.rawPayloadBytes,
    scenario: "key-and-boundary-changes",
    wallTimeMs,
  };
}

const results = [runHighFrequencyFixture(), runBoundaryFixture()];
console.log(
  JSON.stringify(
    {
      assertions: ASSERTIONS_ENABLED,
      coalesceWindowMs: DSH_DELTA_COALESCE_WINDOW_MS,
      results,
    },
    null,
    2,
  ),
);
