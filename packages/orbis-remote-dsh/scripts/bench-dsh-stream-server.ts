import type { AgentSessionEvent } from "@orbisapp/orbis-agent-backend";

import {
  EXPECTED_DSH_STREAM_FIXTURE_ASSISTANT_CHUNKS,
  EXPECTED_DSH_STREAM_FIXTURE_BYTES,
  EXPECTED_DSH_STREAM_FIXTURE_CANONICAL_DELTAS,
  EXPECTED_DSH_STREAM_FIXTURE_EVENTS,
  EXPECTED_DSH_STREAM_FIXTURE_FIRST_NATIVE_SEQUENCE,
  EXPECTED_DSH_STREAM_FIXTURE_LAST_NATIVE_SEQUENCE,
  EXPECTED_DSH_STREAM_FIXTURE_PAYLOAD_BYTES,
  EXPECTED_DSH_STREAM_FIXTURE_SHA256,
  EXPECTED_DSH_STREAM_FIXTURE_TEXT_DELTAS,
  EXPECTED_DSH_STREAM_FIXTURE_THINKING_DELTAS,
  EXPECTED_DSH_STREAM_FIXTURE_TOOL_INPUT_DELTAS,
  loadDshStreamFixture,
  replayDshStreamFixture,
  type CapturedAgentSessionEvent,
  type DshStreamReplay,
  utf8Bytes,
} from "./dsh-stream-fixture";

const WARMUP_ITERATIONS = 3;
const MEASURED_ITERATIONS = 10;
const ASSERTIONS_ENABLED = process.argv.slice(2).some((argument) => argument === "--assert");
const unexpectedArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--" && argument !== "--assert");

if (unexpectedArguments.length > 0) {
  throw new Error("Usage: pnpm run bench:fixture:server [--assert]");
}

type DeltaEvent = Extract<AgentSessionEvent, { readonly type: "entry.delta" }>;

interface Measurement {
  readonly output: DshStreamReplay;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

function assertBench(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`[server fixture bench] ${message}`);
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function measure(operation: () => DshStreamReplay): Measurement {
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) operation();
  const samples: number[] = [];
  let output = operation();
  for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
    const startedAt = performance.now();
    output = operation();
    samples.push(performance.now() - startedAt);
  }
  return { output, p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95) };
}

function delta(record: CapturedAgentSessionEvent): DeltaEvent {
  assertBench(record.event.type === "entry.delta", "replay emitted a non-delta event");
  return record.event;
}

function payloadBytes(records: readonly CapturedAgentSessionEvent[]): number {
  return records.reduce((total, record) => total + utf8Bytes(delta(record).payload.delta), 0);
}

function payloadsByKey(records: readonly CapturedAgentSessionEvent[]): Map<string, string> {
  const chunks = new Map<string, string[]>();
  for (const record of records) {
    const event = delta(record);
    const key = [event.payload.entryId, event.payload.part, event.payload.blockIndex].join(
      "\u0000",
    );
    const values = chunks.get(key) ?? [];
    values.push(event.payload.delta);
    chunks.set(key, values);
  }
  return new Map([...chunks].map(([key, values]) => [key, values.join("")]));
}

function assertSequences(records: readonly CapturedAgentSessionEvent[], label: string): void {
  const previousByEntry = new Map<string, number>();
  let previousCapture = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    const event = delta(record);
    assertBench(record.capturedAtMs >= previousCapture, `${label} capture order moved backwards`);
    previousCapture = record.capturedAtMs;
    const entryId = String(event.payload.entryId);
    const expected = (previousByEntry.get(entryId) ?? 0) + 1;
    assertBench(
      event.payload.chunkSeq === expected,
      `${label} chunkSeq for an entry was ${event.payload.chunkSeq}, expected ${expected}`,
    );
    previousByEntry.set(entryId, event.payload.chunkSeq);
  }
}

function assertEquivalentPayloads(replay: DshStreamReplay): void {
  const raw = payloadsByKey(replay.rawCanonicalDeltas);
  const coalesced = payloadsByKey(replay.coalescedDeltas);
  assertBench(raw.size === coalesced.size, "coalescing changed the number of delta keys");
  for (const [key, value] of raw) {
    assertBench(coalesced.get(key) === value, "coalescing changed ordered payload bytes for a key");
  }
}

const fixture = await loadDshStreamFixture();
const nativeSessions = new Set(fixture.events.map((wrapper) => wrapper.nativeSessionId));
const assistantChunks = fixture.events.reduce(
  (count, wrapper) => count + (wrapper.event.type === "assistant/chunk" ? 1 : 0),
  0,
);
const measurement = measure(() => replayDshStreamFixture(fixture));
const replay = measurement.output;
const rawPayloadBytes = payloadBytes(replay.rawCanonicalDeltas);
const emittedPayloadBytes = payloadBytes(replay.coalescedDeltas);
const reduction = replay.rawCanonicalDeltas.length / replay.coalescedDeltas.length;
const rawDeltaParts = replay.rawCanonicalDeltas.reduce(
  (counts, record) => {
    counts[delta(record).payload.part] += 1;
    return counts;
  },
  { text: 0, thinking: 0, tool_input: 0, tool_output: 0 },
);
const firstNativeSequence = fixture.events[0]?.event.seq;
const lastNativeSequence = fixture.events.at(-1)?.event.seq;

if (ASSERTIONS_ENABLED) {
  assertBench(fixture.bytes === EXPECTED_DSH_STREAM_FIXTURE_BYTES, "fixture byte size changed");
  assertBench(fixture.sha256 === EXPECTED_DSH_STREAM_FIXTURE_SHA256, "fixture digest changed");
  assertBench(
    fixture.events.length === EXPECTED_DSH_STREAM_FIXTURE_EVENTS,
    "fixture event count changed",
  );
  assertBench(
    assistantChunks === EXPECTED_DSH_STREAM_FIXTURE_ASSISTANT_CHUNKS,
    "fixture assistant chunk count changed",
  );
  assertBench(nativeSessions.size === 1, "fixture must contain exactly one native session");
  assertBench(
    firstNativeSequence === EXPECTED_DSH_STREAM_FIXTURE_FIRST_NATIVE_SEQUENCE,
    "fixture first native sequence changed",
  );
  assertBench(
    lastNativeSequence === EXPECTED_DSH_STREAM_FIXTURE_LAST_NATIVE_SEQUENCE,
    "fixture last native sequence changed",
  );
  assertBench(
    replay.rawCanonicalDeltas.length === EXPECTED_DSH_STREAM_FIXTURE_CANONICAL_DELTAS,
    "canonical delta count changed",
  );
  assertBench(
    rawPayloadBytes === EXPECTED_DSH_STREAM_FIXTURE_PAYLOAD_BYTES,
    "canonical payload byte count changed",
  );
  assertBench(
    rawDeltaParts.thinking === EXPECTED_DSH_STREAM_FIXTURE_THINKING_DELTAS,
    "thinking delta count changed",
  );
  assertBench(
    rawDeltaParts.tool_input === EXPECTED_DSH_STREAM_FIXTURE_TOOL_INPUT_DELTAS,
    "tool input delta count changed",
  );
  assertBench(
    rawDeltaParts.text === EXPECTED_DSH_STREAM_FIXTURE_TEXT_DELTAS,
    "text delta count changed",
  );
  assertBench(rawDeltaParts.tool_output === 0, "unexpected tool output deltas appeared");
  assertBench(
    replay.coalescedDeltas.length < replay.rawCanonicalDeltas.length,
    "server coalescing did not reduce the real fixture",
  );
  assertBench(reduction >= 5, `server delta reduction fell below 5x (${reduction.toFixed(2)}x)`);
  assertBench(rawPayloadBytes === emittedPayloadBytes, "server coalescing changed payload bytes");
  assertSequences(replay.rawCanonicalDeltas, "raw");
  assertSequences(replay.coalescedDeltas, "coalesced");
  assertEquivalentPayloads(replay);
}

console.log(
  JSON.stringify(
    {
      assertions: ASSERTIONS_ENABLED,
      fixture: {
        assistantChunks,
        bytes: fixture.bytes,
        events: fixture.events.length,
        sha256: fixture.sha256,
        nativeSessions: nativeSessions.size,
      },
      server: {
        emittedDeltas: replay.coalescedDeltas.length,
        emittedPayloadBytes,
        measuredIterations: MEASURED_ITERATIONS,
        p50Ms: Number(measurement.p50Ms.toFixed(3)),
        p95Ms: Number(measurement.p95Ms.toFixed(3)),
        rawDeltas: replay.rawCanonicalDeltas.length,
        rawPayloadBytes,
        reduction: Number(reduction.toFixed(2)),
      },
    },
    undefined,
    2,
  ),
);
