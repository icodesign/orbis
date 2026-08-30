import { randomUUID } from "node:crypto";

const MAX_REPLAY_BYTES = 256 * 1024 * 1024;
const MAX_REPLAY_LINE_BYTES = 16 * 1024 * 1024;

export type OrbisDshRawEventReplayState =
  | "cancelled"
  | "completed"
  | "failed"
  | "idle"
  | "preparing"
  | "replaying"
  | "waiting";

export interface OrbisDshRawEventReplayStatus {
  readonly completedAt?: string;
  readonly error?: string;
  readonly eventCount: number;
  readonly filename?: string;
  readonly replayedEventCount: number;
  readonly replayId?: string;
  readonly sessionId?: string;
  readonly startedAt?: string;
  readonly state: OrbisDshRawEventReplayState;
}

export interface OrbisDshRawEventReplayInput {
  readonly data: AsyncIterable<Uint8Array>;
  readonly filename?: string;
}

export interface OrbisDshRawEventReplayEvent {
  readonly data: unknown;
  readonly seq: number;
  readonly sourceEventSeqs?: readonly number[];
  readonly surfaceOp?:
    | "append"
    | { readonly end: number; readonly op: "replace"; readonly start: number };
  readonly type: string;
}

export interface OrbisDshRawEventReplayTarget {
  readonly initialSeq: number;
  readonly prefixEvents: readonly OrbisDshRawEventReplayEvent[];
  readonly sessionId: string;
  announce(): void;
  append(event: OrbisDshRawEventReplayEvent): number;
  flush(): Promise<void>;
  isSubscribed(): boolean;
  observeSubscription(listener: (subscribed: boolean) => void): () => void;
  prepare(events: readonly OrbisDshRawEventReplayEvent[]): void;
}

export interface OrbisDshRawEventReplayPort {
  createSession(): Promise<OrbisDshRawEventReplayTarget>;
}

export interface OrbisDshRawEventReplayerOptions {
  readonly createId?: () => string;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface CapturedEvent {
  readonly capturedAtMs: number;
  readonly event: OrbisDshRawEventReplayEvent;
}

interface ParsedRecording {
  readonly events: readonly CapturedEvent[];
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return String(error);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The replay JSONL ${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`The replay JSONL ${label} has an invalid ${key}`);
  }
  return candidate;
}

function requiredInteger(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): number {
  const candidate = value[key];
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw new Error(`The replay JSONL ${label} has an invalid ${key}`);
  }
  return candidate as number;
}

function parseTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string") {
    throw new Error(`The replay JSONL ${label} has an invalid capturedAt`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`The replay JSONL ${label} has an invalid capturedAt`);
  }
  return milliseconds;
}

function sequenceList(
  value: unknown,
  eventSeq: number,
  label: string,
): readonly number[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some(
      (candidate) => !Number.isSafeInteger(candidate) || candidate < 0 || candidate >= eventSeq,
    )
  ) {
    throw new Error(`The replay JSONL ${label} has invalid sourceEventSeqs`);
  }
  return value as number[];
}

function surfaceOperation(
  value: unknown,
  eventSeq: number,
  label: string,
): OrbisDshRawEventReplayEvent["surfaceOp"] {
  if (value === undefined || value === "append") return value;
  const candidate = record(value, `${label} surfaceOp`);
  const start = requiredInteger(candidate, "start", `${label} surfaceOp`);
  const end = requiredInteger(candidate, "end", `${label} surfaceOp`);
  if (candidate.op !== "replace" || start > end || end >= eventSeq) {
    throw new Error(`The replay JSONL ${label} has an invalid surfaceOp`);
  }
  return { end, op: "replace", start };
}

function parseEvent(value: unknown, label: string): OrbisDshRawEventReplayEvent {
  const candidate = record(value, `${label} event`);
  const seq = requiredInteger(candidate, "seq", `${label} event`);
  const type = requiredString(candidate, "type", `${label} event`);
  const time = candidate.time;
  if (!Number.isFinite(time)) {
    throw new Error(`The replay JSONL ${label} event has an invalid time`);
  }
  if (!("data" in candidate)) {
    throw new Error(`The replay JSONL ${label} event is missing data`);
  }
  if (candidate.ignorable !== undefined) {
    throw new Error(
      "The replay JSONL contains ignorable events that cannot be appended losslessly",
    );
  }
  const sourceEventSeqs = sequenceList(candidate.sourceEventSeqs, seq, label);
  const surfaceOp = surfaceOperation(candidate.surfaceOp, seq, label);
  return {
    data: candidate.data,
    seq,
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
    type,
  };
}

function parseLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`The replay JSONL line ${lineNumber} is not valid JSON`);
  }
}

async function parseRecording(input: AsyncIterable<Uint8Array>): Promise<ParsedRecording> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  let bytes = 0;
  let lineNumber = 0;
  let recordingId: string | undefined;
  let footerBytes: number | undefined;
  let footerSeen = false;
  let expectedSequence = 1;
  let sourceSessionId: string | undefined;
  let previousCapturedAt = -Infinity;
  let previousEventSeq: number | undefined;
  const events: CapturedEvent[] = [];

  const acceptLine = (line: string): void => {
    lineNumber += 1;
    if (Buffer.byteLength(line, "utf8") > MAX_REPLAY_LINE_BYTES) {
      throw new Error(`The replay JSONL line ${lineNumber} is too large`);
    }
    if (line.length === 0) throw new Error(`The replay JSONL line ${lineNumber} is empty`);
    const candidate = record(parseLine(line, lineNumber), `line ${lineNumber}`);
    if (lineNumber === 1) {
      if (
        candidate.kind !== "header" ||
        candidate.format !== "orbis-dsh-raw-events" ||
        candidate.version !== 1
      ) {
        throw new Error("The selected file is not an Orbis raw DSH event recording");
      }
      recordingId = requiredString(candidate, "recordingId", "header");
      return;
    }
    if (recordingId === undefined) throw new Error("The replay JSONL is missing its header");
    if (footerSeen) throw new Error("The replay JSONL contains data after its footer");
    if (candidate.kind === "footer") {
      if (
        candidate.recordingId !== recordingId ||
        candidate.status !== "stopped" ||
        requiredInteger(candidate, "eventCount", "footer") !== events.length
      ) {
        throw new Error("The replay JSONL footer does not match the completed recording");
      }
      footerBytes = requiredInteger(candidate, "bytes", "footer");
      footerSeen = true;
      return;
    }
    if (candidate.kind !== "event" || candidate.recordingId !== recordingId) {
      throw new Error(`The replay JSONL line ${lineNumber} is not a recording event`);
    }
    const sequence = requiredInteger(candidate, "sequence", `line ${lineNumber}`);
    if (sequence !== expectedSequence) {
      throw new Error(
        `The replay JSONL event sequence is ${sequence}; expected ${expectedSequence}`,
      );
    }
    const nativeSessionId = requiredString(candidate, "nativeSessionId", `line ${lineNumber}`);
    sourceSessionId ??= nativeSessionId;
    if (nativeSessionId !== sourceSessionId) {
      throw new Error("Replay currently requires a recording containing exactly one DSH session");
    }
    const capturedAtMs = parseTimestamp(candidate.capturedAt, `line ${lineNumber}`);
    if (capturedAtMs < previousCapturedAt) {
      throw new Error("The replay JSONL capturedAt timeline moved backwards");
    }
    const event = parseEvent(candidate.event, `line ${lineNumber}`);
    if (previousEventSeq !== undefined && event.seq !== previousEventSeq + 1) {
      throw new Error(
        `The replay JSONL native sequence is ${event.seq}; expected ${previousEventSeq + 1}`,
      );
    }
    events.push({ capturedAtMs, event });
    expectedSequence += 1;
    previousCapturedAt = capturedAtMs;
    previousEventSeq = event.seq;
  };

  try {
    for await (const chunk of input) {
      bytes += chunk.byteLength;
      if (bytes > MAX_REPLAY_BYTES) throw new Error("The replay JSONL exceeds 256 MiB");
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/u, "");
        buffered = buffered.slice(newline + 1);
        acceptLine(line);
        newline = buffered.indexOf("\n");
      }
      if (Buffer.byteLength(buffered, "utf8") > MAX_REPLAY_LINE_BYTES) {
        throw new Error("The replay JSONL contains a line larger than 16 MiB");
      }
    }
    buffered += decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) throw new Error("The replay JSONL is not valid UTF-8");
    throw error;
  }
  if (buffered.length > 0) acceptLine(buffered.replace(/\r$/u, ""));
  if (!footerSeen) throw new Error("The replay JSONL is missing its completed footer");
  if (footerBytes !== bytes) {
    throw new Error(`The replay JSONL contains ${bytes} bytes; its footer declares ${footerBytes}`);
  }
  if (events.length === 0 || sourceSessionId === undefined) {
    throw new Error("The replay JSONL contains no DSH events");
  }
  return { events };
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", aborted, { once: true });
    function done(): void {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
  });
}

function waitForSubscription(
  target: OrbisDshRawEventReplayTarget,
  signal: AbortSignal,
): Promise<void> {
  if (target.isSubscribed()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const detach = target.observeSubscription((subscribed) => {
      if (!subscribed) return;
      cleanup();
      resolve();
    });
    signal.addEventListener("abort", aborted, { once: true });
    if (target.isSubscribed()) {
      cleanup();
      resolve();
    }
    function cleanup(): void {
      signal.removeEventListener("abort", aborted);
      detach();
    }
    function aborted(): void {
      cleanup();
      reject(signal.reason);
    }
  });
}

function displayFilename(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replaceAll("\\", "/").split("/").at(-1)?.trim();
  if (!normalized || normalized.length > 256 || !normalized.toLowerCase().endsWith(".jsonl")) {
    throw new Error("Select a .jsonl recording file to replay");
  }
  return normalized;
}

function isCancelled(state: OrbisDshRawEventReplayState): boolean {
  return state === "cancelled";
}

function sameReplayEvent(
  left: OrbisDshRawEventReplayEvent,
  right: OrbisDshRawEventReplayEvent,
): boolean {
  return (
    left.seq === right.seq &&
    left.type === right.type &&
    JSON.stringify(left.data) === JSON.stringify(right.data) &&
    JSON.stringify(left.sourceEventSeqs) === JSON.stringify(right.sourceEventSeqs) &&
    JSON.stringify(left.surfaceOp) === JSON.stringify(right.surfaceOp)
  );
}

function replayStartIndex(
  events: readonly CapturedEvent[],
  target: OrbisDshRawEventReplayTarget,
): number {
  const firstSeq = events[0]!.event.seq;
  if (target.prefixEvents.length !== target.initialSeq) {
    throw new Error("DSH returned an invalid replay session prefix");
  }
  if (firstSeq === target.initialSeq) return 0;
  if (firstSeq !== 0 || target.initialSeq === 0 || events.length < target.initialSeq) {
    throw new Error(
      `The recording starts at native seq ${firstSeq}, but a fresh DSH session starts replay at seq ${target.initialSeq}`,
    );
  }
  for (let index = 0; index < target.initialSeq; index += 1) {
    if (!sameReplayEvent(events[index]!.event, target.prefixEvents[index]!)) {
      throw new Error(`The recording's DSH session prefix differs at native seq ${index}`);
    }
  }
  return target.initialSeq;
}

function mappedSequence(sequence: number, sequences: ReadonlyMap<number, number>, label: string) {
  const mapped = sequences.get(sequence);
  if (mapped === undefined) {
    throw new Error(`The replay cannot map ${label} seq ${sequence} into the target session`);
  }
  return mapped;
}

function mappedSequenceList(
  value: unknown,
  sequences: ReadonlyMap<number, number>,
  label: string,
): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((sequence) =>
    typeof sequence === "number" ? mappedSequence(sequence, sequences, label) : sequence,
  );
}

function mappedRange(
  value: unknown,
  sequences: ReadonlyMap<number, number>,
  label: string,
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const range = value as Readonly<Record<string, unknown>>;
  if (typeof range.start !== "number" || typeof range.end !== "number") return value;
  return {
    ...range,
    end: mappedSequence(range.end, sequences, `${label} end`),
    start: mappedSequence(range.start, sequences, `${label} start`),
  };
}

/** Rebase the event-sequence references carried inside known DSH extension payloads. */
function mappedEventData(
  event: OrbisDshRawEventReplayEvent,
  sequences: ReadonlyMap<number, number>,
): unknown {
  if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) {
    return event.data;
  }
  const data = event.data as Readonly<Record<string, unknown>>;
  if (event.type === "session/title" || event.type === "session/title-llm-request") {
    return {
      ...data,
      messageSeqs: mappedSequenceList(data.messageSeqs, sequences, `${event.type} message`),
    };
  }
  if (event.type === "compaction/summary" || event.type === "compaction/prune") {
    return {
      ...data,
      shadowedRange: mappedRange(data.shadowedRange, sequences, `${event.type} shadowed range`),
      shadowedSeqs: mappedSequenceList(data.shadowedSeqs, sequences, `${event.type} shadowed`),
    };
  }
  if (event.type === "command/done" && typeof data.sourceEventSeq === "number") {
    return {
      ...data,
      sourceEventSeq: mappedSequence(data.sourceEventSeq, sequences, "command source event"),
    };
  }
  return event.data;
}

function mappedReplayEvent(
  event: OrbisDshRawEventReplayEvent,
  sequences: ReadonlyMap<number, number>,
): OrbisDshRawEventReplayEvent {
  const sourceEventSeqs = event.sourceEventSeqs?.map((sequence) =>
    mappedSequence(sequence, sequences, "source event"),
  );
  const surfaceOp =
    typeof event.surfaceOp !== "object"
      ? event.surfaceOp
      : {
          end: mappedSequence(event.surfaceOp.end, sequences, "surface replacement end"),
          op: "replace" as const,
          start: mappedSequence(event.surfaceOp.start, sequences, "surface replacement start"),
        };
  return {
    data: mappedEventData(event, sequences),
    seq: event.seq,
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
    type: event.type,
  };
}

/** Development-only lifecycle for replaying one complete raw recording into a real DSH session. */
export class OrbisDshRawEventReplayer {
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private controller?: AbortController;
  private operation?: Promise<void>;
  private completedAt?: string;
  private error?: string;
  private eventCount = 0;
  private filename?: string;
  private replayedEventCount = 0;
  private replayId?: string;
  private sessionId?: string;
  private startedAt?: string;
  private state: OrbisDshRawEventReplayState = "idle";

  constructor(
    private readonly port: OrbisDshRawEventReplayPort,
    options: OrbisDshRawEventReplayerOptions = {},
  ) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
  }

  async start(input: OrbisDshRawEventReplayInput): Promise<OrbisDshRawEventReplayStatus> {
    if (this.state === "preparing" || this.state === "waiting" || this.state === "replaying") {
      throw new Error("A DSH event replay is already active");
    }
    this.state = "preparing";
    this.error = undefined;
    this.completedAt = undefined;
    this.eventCount = 0;
    this.replayedEventCount = 0;
    this.replayId = this.createId();
    this.filename = undefined;
    this.sessionId = undefined;
    this.startedAt = undefined;
    this.controller = new AbortController();
    try {
      this.filename = displayFilename(input.filename);
      const recording = await parseRecording(input.data);
      if (this.controller.signal.aborted) throw this.controller.signal.reason;
      const target = await this.port.createSession();
      if (this.controller.signal.aborted) throw this.controller.signal.reason;
      const startIndex = replayStartIndex(recording.events, target);
      target.prepare(recording.events.map((record) => record.event));
      this.eventCount = recording.events.length;
      this.replayedEventCount = startIndex;
      this.sessionId = target.sessionId;
      target.announce();
      this.state = "waiting";
      const operation = this.run(
        recording.events.slice(startIndex),
        recording.events[0]!.capturedAtMs,
        target,
        this.controller.signal,
      );
      this.operation = operation;
      void operation.finally(() => {
        if (this.operation === operation) this.operation = undefined;
      });
      return this.status();
    } catch (error) {
      if (!isCancelled(this.state)) {
        this.state = "failed";
        this.error = errorText(error).slice(0, 512);
        this.completedAt = this.timestamp();
      }
      throw error;
    }
  }

  async cancel(): Promise<OrbisDshRawEventReplayStatus> {
    if (this.state !== "preparing" && this.state !== "waiting" && this.state !== "replaying") {
      return this.status();
    }
    this.state = "cancelled";
    this.completedAt = this.timestamp();
    this.controller?.abort(new Error("The DSH event replay was cancelled"));
    await this.operation?.catch(() => undefined);
    return this.status();
  }

  async dispose(): Promise<void> {
    await this.cancel();
    await this.operation?.catch(() => undefined);
  }

  async settled(): Promise<OrbisDshRawEventReplayStatus> {
    await this.operation?.catch(() => undefined);
    return this.status();
  }

  status(): OrbisDshRawEventReplayStatus {
    return {
      ...(this.completedAt === undefined ? {} : { completedAt: this.completedAt }),
      ...(this.error === undefined ? {} : { error: this.error }),
      eventCount: this.eventCount,
      ...(this.filename === undefined ? {} : { filename: this.filename }),
      replayedEventCount: this.replayedEventCount,
      ...(this.replayId === undefined ? {} : { replayId: this.replayId }),
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
      state: this.state,
    };
  }

  private async run(
    events: readonly CapturedEvent[],
    firstCapturedAt: number,
    target: OrbisDshRawEventReplayTarget,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await waitForSubscription(target, signal);
      if (signal.aborted) throw signal.reason;
      this.state = "replaying";
      this.startedAt = this.timestamp();
      const replayStartedAt = Date.now();
      const targetSequences = new Map<number, number>(
        target.prefixEvents.map((event) => [event.seq, event.seq]),
      );
      for (const record of events) {
        const dueAt = replayStartedAt + record.capturedAtMs - firstCapturedAt;
        await this.sleep(Math.max(0, dueAt - Date.now()), signal);
        if (signal.aborted) throw signal.reason;
        const appendedSeq = target.append(mappedReplayEvent(record.event, targetSequences));
        if (!Number.isSafeInteger(appendedSeq) || appendedSeq < 0) {
          throw new Error("DSH appended the replay event with an invalid sequence");
        }
        targetSequences.set(record.event.seq, appendedSeq);
        this.replayedEventCount += 1;
      }
      await target.flush();
      if (signal.aborted) throw signal.reason;
      this.state = "completed";
      this.completedAt = this.timestamp();
    } catch (error) {
      if (this.state === "cancelled") return;
      this.state = "failed";
      this.error = errorText(error).slice(0, 512);
      this.completedAt = this.timestamp();
    }
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) throw new Error("The replay clock is invalid");
    return value.toISOString();
  }
}
