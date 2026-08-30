import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  agentBackendId,
  agentDriverId,
  agentEntryId,
  agentEventId,
  agentSessionId,
  type AgentSessionEvent,
} from "@orbisapp/orbis-agent-backend";

import {
  DSH_DELTA_COALESCE_WINDOW_MS,
  DshDeltaCoalescer,
  type DshDeltaInput,
  type DshDeltaScheduler,
} from "../src/adapter/dsh-delta-coalescer";
import { dshEventIdentity, dshTimestamp } from "../src/adapter/dsh-projection";
import type { DshSessionEvent } from "../src/adapter/dsh-types";

export const DSH_STREAM_FIXTURE_FORMAT = "orbis-dsh-raw-events" as const;
export const DSH_STREAM_FIXTURE_VERSION = 1 as const;
export const EXPECTED_DSH_STREAM_FIXTURE_EVENTS = 45_948 as const;
export const EXPECTED_DSH_STREAM_FIXTURE_BYTES = 17_649_140 as const;
export const EXPECTED_DSH_STREAM_FIXTURE_ASSISTANT_CHUNKS = 45_517 as const;
export const EXPECTED_DSH_STREAM_FIXTURE_CANONICAL_DELTAS = 45_065 as const;
export const EXPECTED_DSH_STREAM_FIXTURE_PAYLOAD_BYTES = 179_216 as const;
export const EXPECTED_DSH_STREAM_FIXTURE_THINKING_DELTAS = 37_915 as const;
export const EXPECTED_DSH_STREAM_FIXTURE_TOOL_INPUT_DELTAS = 5_242 as const;
export const EXPECTED_DSH_STREAM_FIXTURE_TEXT_DELTAS = 1_908 as const;
export const EXPECTED_DSH_STREAM_FIXTURE_FIRST_NATIVE_SEQUENCE = 3 as const;
export const EXPECTED_DSH_STREAM_FIXTURE_LAST_NATIVE_SEQUENCE = 45_950 as const;
export const EXPECTED_DSH_STREAM_FIXTURE_SHA256 =
  "2994dc69f7d60e3579bdd596615b505b95dbc37874ec49f879706c8d9cf3d8e6" as const;

const DEFAULT_FIXTURE_URL = new URL(
  "../../../fixtures/dsh-run-stream-events.jsonl",
  import.meta.url,
);
export const DEFAULT_DSH_STREAM_FIXTURE_PATH = fileURLToPath(DEFAULT_FIXTURE_URL);

const BACKEND_ID = agentBackendId("local");
const DRIVER_ID = agentDriverId("dsh");
const TEXT_ENCODER = new TextEncoder();

type JsonRecord = Record<string, unknown>;

export interface DshStreamFixtureHeader {
  readonly format: typeof DSH_STREAM_FIXTURE_FORMAT;
  readonly kind: "header";
  readonly recordingId: string;
  readonly startedAt: string;
  readonly version: typeof DSH_STREAM_FIXTURE_VERSION;
}

export interface DshStreamFixtureEvent {
  readonly capturedAt: string;
  readonly event: DshSessionEvent;
  readonly kind: "event";
  readonly nativeSessionId: string;
  readonly recordingId: string;
  readonly sequence: number;
}

export interface DshStreamFixtureFooter {
  readonly bytes: number;
  readonly eventCount: number;
  readonly kind: "footer";
  readonly recordingId: string;
  readonly status: "stopped";
  readonly stoppedAt: string;
}

export interface DshStreamFixture {
  readonly bytes: number;
  readonly events: readonly DshStreamFixtureEvent[];
  readonly footer: DshStreamFixtureFooter;
  readonly header: DshStreamFixtureHeader;
  readonly sha256: string;
}

/** The event plus the recorder arrival time used by the virtual replay clock. */
export interface CapturedAgentSessionEvent {
  readonly capturedAtMs: number;
  readonly event: AgentSessionEvent;
}

export interface DshStreamReplay {
  readonly coalescedDeltas: readonly CapturedAgentSessionEvent[];
  readonly rawCanonicalDeltas: readonly CapturedAgentSessionEvent[];
}

interface DeltaRecord {
  readonly capturedAtMs: number;
  readonly input: DshDeltaInput;
}

/**
 * Streams and validates the development recorder's JSONL format.
 *
 * The returned event array is intentionally reusable by replay callers. The
 * replay path is read-only and never mutates the parsed native event objects.
 */
export async function loadDshStreamFixture(
  filePath: string = DEFAULT_DSH_STREAM_FIXTURE_PATH,
): Promise<DshStreamFixture> {
  const stream = createReadStream(filePath);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const digest = createHash("sha256");
  const events: DshStreamFixtureEvent[] = [];
  let buffered = "";
  let bytes = 0;
  let lineNumber = 0;
  let header: DshStreamFixtureHeader | undefined;
  let footer: DshStreamFixtureFooter | undefined;
  let expectedSequence = 1;
  const lastNativeSequenceBySession = new Map<string, number>();

  const consumeLine = (rawLine: string): void => {
    lineNumber += 1;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) throw fixtureError(`blank line ${lineNumber}`);
    const parsed = parseJsonObject(line, lineNumber);
    const kind = parsed.kind;

    if (lineNumber === 1) {
      header = parseHeader(parsed, lineNumber);
      return;
    }
    if (header === undefined) throw fixtureError("missing header");
    if (kind === "event") {
      if (footer !== undefined) throw fixtureError("event after footer");
      const event = parseEvent(parsed, header, expectedSequence, lineNumber);
      const previousNativeSequence = lastNativeSequenceBySession.get(event.nativeSessionId);
      if (previousNativeSequence !== undefined && event.event.seq !== previousNativeSequence + 1) {
        throw fixtureError(
          `native sequence for ${event.nativeSessionId} was ${event.event.seq}, expected ${previousNativeSequence + 1}`,
        );
      }
      lastNativeSequenceBySession.set(event.nativeSessionId, event.event.seq);
      events.push(event);
      expectedSequence += 1;
      return;
    }
    if (kind === "footer") {
      if (footer !== undefined) throw fixtureError("duplicate footer");
      footer = parseFooter(parsed, header, lineNumber);
      return;
    }
    throw fixtureError(`unknown record kind at line ${lineNumber}`);
  };

  try {
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      digest.update(chunk);
      buffered += decoder.decode(chunk, { stream: true });
      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex !== -1) {
        consumeLine(buffered.slice(0, newlineIndex));
        buffered = buffered.slice(newlineIndex + 1);
        newlineIndex = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[dsh fixture]")) throw error;
    throw fixtureError("unable to read or decode fixture");
  }

  if (buffered.length > 0) consumeLine(buffered);
  if (header === undefined) throw fixtureError("missing header");
  if (footer === undefined) throw fixtureError("missing footer");
  if (footer.eventCount !== events.length) {
    throw fixtureError(`event count ${footer.eventCount} != ${events.length}`);
  }
  if (footer.bytes !== bytes) throw fixtureError(`footer bytes ${footer.bytes} != ${bytes}`);
  if (events.length !== expectedSequence - 1) {
    throw fixtureError(`sequence ended at ${expectedSequence - 1}`);
  }

  return { bytes, events, footer, header, sha256: digest.digest("hex") };
}

/**
 * Replays a loaded fixture without file IO. The canonical array models every
 * valid delta before server coalescing; the coalesced array models the server
 * 50ms hot path with recorder capturedAt timestamps driving a virtual clock.
 */
export function replayDshStreamFixture(fixture: DshStreamFixture): DshStreamReplay {
  const nativeSessionIds = new Set(fixture.events.map((wrapper) => wrapper.nativeSessionId));
  if (nativeSessionIds.size !== 1) {
    throw fixtureError("stream replay requires exactly one native session");
  }
  const rawCanonicalDeltas: CapturedAgentSessionEvent[] = [];
  const inputRecords: DeltaRecord[] = [];
  const coalescedDeltas: CapturedAgentSessionEvent[] = [];
  const capturedAtByEventId = new Map<string, number>();
  const nextRawChunkSeqByEntryId = new Map<string, number>();
  const nextCoalescedChunkSeqByEntryId = new Map<string, number>();
  const scheduler = new FixtureVirtualScheduler();

  const appendCanonical = (record: DeltaRecord): void => {
    const event = toAgentSessionEvent(record.input, nextRawChunkSeqByEntryId);
    rawCanonicalDeltas.push({ capturedAtMs: record.capturedAtMs, event });
    capturedAtByEventId.set(String(record.input.eventId), record.capturedAtMs);
  };

  const coalescer = new DshDeltaCoalescer({
    emit: (input) => {
      const event = toAgentSessionEvent(input, nextCoalescedChunkSeqByEntryId);
      const capturedAtMs = capturedAtByEventId.get(String(input.eventId));
      if (capturedAtMs === undefined) throw fixtureError("coalesced delta has unknown source");
      coalescedDeltas.push({ capturedAtMs, event });
    },
    scheduler,
  });

  for (const wrapper of fixture.events) {
    const capturedAtMs = parseCapturedAtMs(wrapper.capturedAt);
    scheduler.advanceTo(capturedAtMs);
    const record = deltaRecordForWrapper(wrapper, capturedAtMs);
    if (record === undefined) {
      coalescer.flush();
      continue;
    }
    inputRecords.push(record);
    appendCanonical(record);
    coalescer.push(record.input);
  }
  coalescer.close();

  // `inputRecords` is kept as a deliberate local invariant check: every
  // canonical delta is produced from exactly one valid source wrapper.
  if (inputRecords.length !== rawCanonicalDeltas.length) {
    throw fixtureError("canonical replay count mismatch");
  }
  return { coalescedDeltas, rawCanonicalDeltas };
}

function parseHeader(value: JsonRecord, lineNumber: number): DshStreamFixtureHeader {
  if (
    value.format !== DSH_STREAM_FIXTURE_FORMAT ||
    value.kind !== "header" ||
    value.version !== DSH_STREAM_FIXTURE_VERSION ||
    !nonEmptyString(value.recordingId) ||
    !validTimestamp(value.startedAt)
  ) {
    throw fixtureError(`invalid header at line ${lineNumber}`);
  }
  return {
    format: DSH_STREAM_FIXTURE_FORMAT,
    kind: "header",
    recordingId: value.recordingId as string,
    startedAt: value.startedAt as string,
    version: DSH_STREAM_FIXTURE_VERSION,
  };
}

function parseEvent(
  value: JsonRecord,
  header: DshStreamFixtureHeader,
  expectedSequence: number,
  lineNumber: number,
): DshStreamFixtureEvent {
  if (
    value.kind !== "event" ||
    value.recordingId !== header.recordingId ||
    !nonEmptyString(value.nativeSessionId) ||
    value.sequence !== expectedSequence ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    !validTimestamp(value.capturedAt)
  ) {
    throw fixtureError(`invalid event wrapper at line ${lineNumber}`);
  }
  const event = parseNativeEvent(value.event, lineNumber);
  return {
    capturedAt: value.capturedAt as string,
    event,
    kind: "event",
    nativeSessionId: value.nativeSessionId as string,
    recordingId: header.recordingId,
    sequence: value.sequence as number,
  };
}

function parseFooter(
  value: JsonRecord,
  header: DshStreamFixtureHeader,
  lineNumber: number,
): DshStreamFixtureFooter {
  if (
    value.kind !== "footer" ||
    value.recordingId !== header.recordingId ||
    value.status !== "stopped" ||
    !Number.isSafeInteger(value.eventCount) ||
    (value.eventCount as number) < 0 ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    !validTimestamp(value.stoppedAt)
  ) {
    throw fixtureError(`invalid footer at line ${lineNumber}`);
  }
  return {
    bytes: value.bytes as number,
    eventCount: value.eventCount as number,
    kind: "footer",
    recordingId: header.recordingId,
    status: "stopped",
    stoppedAt: value.stoppedAt as string,
  };
}

function parseNativeEvent(value: unknown, lineNumber: number): DshSessionEvent {
  const event = asRecord(value);
  if (
    event === undefined ||
    !nonEmptyString(event.type) ||
    !Number.isSafeInteger(event.seq) ||
    (event.seq as number) < 0 ||
    typeof event.time !== "number" ||
    !Number.isFinite(event.time) ||
    !validDateMs(event.time) ||
    !("data" in event)
  ) {
    throw fixtureError(`invalid native event at line ${lineNumber}`);
  }
  return {
    data: event.data,
    seq: event.seq as number,
    time: event.time as number,
    type: event.type as string,
  };
}

function parseJsonObject(line: string, lineNumber: number): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw fixtureError(`invalid JSON at line ${lineNumber}`);
  }
  const value = asRecord(parsed);
  if (value === undefined) throw fixtureError(`record is not an object at line ${lineNumber}`);
  return value;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validDateMs(value: number): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

function parseCapturedAtMs(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw fixtureError("invalid capturedAt timestamp");
  return milliseconds;
}

function fixtureError(message: string): Error {
  return new Error(`[dsh fixture] ${message}`);
}

function deltaRecordForWrapper(
  wrapper: DshStreamFixtureEvent,
  capturedAtMs: number,
): DeltaRecord | undefined {
  const native = wrapper.event;
  if (native.type !== "assistant/chunk") return undefined;
  const data = asRecord(native.data);
  if (data === undefined) return undefined;
  const turn = data.turn;
  const step = data.step;
  const chunk = asRecord(data.chunk);
  if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step) || chunk === undefined) {
    return undefined;
  }
  const index = chunk.index;
  if (!Number.isSafeInteger(index) || (index as number) < 0) return undefined;
  const turnNumber = turn as number;
  const stepNumber = step as number;
  const indexNumber = index as number;
  const messageId = `message-${turnNumber}-${stepNumber}`;
  let part: DshDeltaInput["payload"]["part"];
  let delta: unknown;
  let entryId: string;
  let suffix: string;
  switch (chunk.type) {
    case "text-delta":
      part = "text";
      delta = chunk.text;
      entryId = messageId;
      suffix = "message-delta";
      break;
    case "reasoning-delta":
      part = "thinking";
      delta = chunk.text;
      entryId = messageId;
      suffix = "message-delta";
      break;
    case "tool-call-delta":
      part = "tool_input";
      delta = chunk.argumentsDelta;
      if (typeof chunk.id !== "string" || chunk.id.length === 0) return undefined;
      entryId = `tool-${chunk.id}`;
      suffix = "tool-delta";
      break;
    default:
      return undefined;
  }
  if (typeof delta !== "string") return undefined;
  return {
    capturedAtMs,
    input: {
      eventId: agentEventId(dshEventIdentity(native, suffix)),
      occurredAt: dshTimestamp(native.time),
      payload: {
        blockIndex: indexNumber,
        delta,
        entryId: agentEntryId(entryId),
        part,
      },
      sessionId: agentSessionId(wrapper.nativeSessionId),
      source: { backendId: BACKEND_ID, driverId: DRIVER_ID, nativeType: native.type },
    },
  };
}

function toAgentSessionEvent(
  input: DshDeltaInput,
  nextChunkSeqByEntryId: Map<string, number>,
): AgentSessionEvent {
  const entryId = String(input.payload.entryId);
  const chunkSeq = (nextChunkSeqByEntryId.get(entryId) ?? 0) + 1;
  nextChunkSeqByEntryId.set(entryId, chunkSeq);
  return {
    ...input,
    durability: "transient",
    payload: { ...input.payload, chunkSeq },
    type: "entry.delta",
  };
}

/** A timer scheduler whose clock is advanced by recorder capturedAt values. */
class FixtureVirtualScheduler implements DshDeltaScheduler {
  private nextHandle = 0;
  private nowMs = 0;
  private readonly timers = new Map<
    number,
    { readonly callback: () => void; readonly dueAtMs: number }
  >();

  setTimeout(callback: () => void, delayMs: number): number {
    if (delayMs !== DSH_DELTA_COALESCE_WINDOW_MS) {
      throw fixtureError(`unexpected coalescing delay ${delayMs}`);
    }
    const handle = ++this.nextHandle;
    this.timers.set(handle, { callback, dueAtMs: this.nowMs + delayMs });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  advanceTo(nextMs: number): void {
    if (nextMs < this.nowMs) throw fixtureError("capturedAt moved backwards");
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAtMs <= nextMs)
        .sort((left, right) => left[1].dueAtMs - right[1].dueAtMs || left[0] - right[0])[0];
      if (due === undefined) break;
      this.nowMs = due[1].dueAtMs;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.nowMs = nextMs;
  }
}

export function utf8Bytes(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength;
}
