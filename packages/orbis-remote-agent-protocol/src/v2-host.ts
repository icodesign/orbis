import {
  AgentBackendError,
  agentBackendId,
  agentDeliveryCursor,
  agentDriverId,
  agentEventId,
  agentRunId,
  agentSessionLocatorKey,
  agentTimestamp,
  createAgentSessionRef,
  hasAgentDriverCapability,
  isSameAgentSessionRef,
  validateAgentQuestionResponseForRequest,
  validateAgentQuestionResponseInput,
  validateAgentPromptInput,
  validateAgentPromptReferenceCompletionInput,
  validateAgentPromptReferenceCompletionResult,
  validateAgentSessionSubagentList,
  type AgentBackendId,
  type AgentPromptContentBlock,
  type AgentDeliveryCursor,
  type AgentEntryId,
  type AgentJsonValue,
  type AgentSessionRef,
  type AgentTimestamp,
  type AgentAttachmentReadResult,
  type AgentPromptReferenceCompletionInput,
} from "@orbisapp/orbis-agent-backend";
import {
  jsonValueSchema,
  OrbisTransportError,
  type JsonValue,
  type TransportEvent,
} from "@orbisapp/transport";

import type {
  RemoteAgentHostDeliveryTransport,
  RemoteAgentHostPeer,
  RemoteAgentHostRequestContext,
} from "./host";
import {
  ORBIS_REMOTE_AGENT_V2_EVENT_TYPE,
  ORBIS_REMOTE_AGENT_V2_METHODS,
  ORBIS_REMOTE_AGENT_V2_PROTOCOL_VERSION,
} from "./v2-constants";
import {
  v2CancelInputSchema,
  v2ContentBlockSchema,
  v2PromptContentBlockSchema,
  v2CreateInputSchema,
  v2DeviceSchema,
  v2EntriesInputSchema,
  v2HelloInputSchema,
  v2ListInputSchema,
  v2ModelSchema,
  v2ModelsListInputSchema,
  v2WorkspacesListInputSchema,
  v2WorkspacesBrowseInputSchema,
  v2WorkspacesCreateFolderInputSchema,
  v2WorkspacesRegisterInputSchema,
  v2PromptInputSchema,
  v2PermissionResponseInputSchema,
  v2QuestionResponseInputSchema,
  v2RefSchema,
  v2SyncInputSchema,
  v2UpdateInputSchema,
  v2AttachmentUploadBeginInputSchema,
  v2AttachmentUploadChunkInputSchema,
  v2AttachmentUploadFinishInputSchema,
  v2AttachmentUploadAbortInputSchema,
  v2AttachmentReadInputSchema,
  v2PromptReferenceCompletionInputSchema,
  v2SubagentListInputSchema,
  v2SubagentListResponseSchema,
} from "./v2-schemas";
import type {
  RemoteAgentV2Backend,
  RemoteAgentV2CancelInput,
  RemoteAgentV2ContentBlock,
  RemoteAgentV2DeviceDescriptor,
  RemoteAgentV2Entry,
  RemoteAgentV2Event,
  RemoteAgentV2Hello,
  RemoteAgentV2HostCapabilities,
  RemoteAgentV2HostEvent,
  RemoteAgentV2Limits,
  RemoteAgentV2ModelSelection,
  RemoteAgentV2PromptInput,
  RemoteAgentV2PromptContentBlock,
  RemoteAgentV2PermissionResponseInput,
  RemoteAgentV2QuestionResponseInput,
  RemoteAgentV2SessionEvent,
  RemoteAgentV2SessionRecord,
  RemoteAgentV2SessionSnapshot,
  RemoteAgentV2SessionState,
  RemoteAgentV2SessionSummary,
  RemoteAgentV2Runtime,
  RemoteAgentV2UpdateInput,
} from "./v2-types";

export interface RemoteAgentV2StoredEntryIndex {
  readonly cursor: AgentDeliveryCursor;
  readonly entryId: string;
}

export interface RemoteAgentV2StoredSessionIndex {
  readonly ref: AgentSessionRef;
  readonly entries: readonly RemoteAgentV2StoredEntryIndex[];
}

export type RemoteAgentV2IdempotencyClaim =
  | { readonly kind: "claimed" }
  | { readonly kind: "pending" }
  | { readonly kind: "accepted"; readonly result: AgentJsonValue };

/**
 * The v2 host store deliberately contains no transcript payload and no ACK
 * state. Native DSH persistence remains the history authority.
 */
export interface RemoteAgentV2HostStore {
  bumpHostRevision(): Promise<string>;
  claimIdempotency(key: string): Promise<RemoteAgentV2IdempotencyClaim>;
  completeIdempotency(key: string, result: AgentJsonValue): Promise<void>;
  initializeSession(
    ref: AgentSessionRef,
    entries: readonly RemoteAgentV2StoredEntryIndex[],
  ): Promise<RemoteAgentV2StoredSessionIndex>;
  readHostRevision(): Promise<string>;
  readSessionIndex(ref: AgentSessionRef): Promise<RemoteAgentV2StoredSessionIndex | undefined>;
  replaceSessionIndex(
    ref: AgentSessionRef,
    entries: readonly RemoteAgentV2StoredEntryIndex[],
  ): Promise<RemoteAgentV2StoredSessionIndex>;
}

/** Injectable timer seam so catalog coalescing is deterministic under test. */
export interface RemoteAgentV2HostScheduler {
  cancel(handle: unknown): void;
  schedule(callback: () => void, delayMs: number): unknown;
}

export interface RemoteAgentV2HostOptions {
  /** Native execution backend. Its host id is translated to the public remote placement. */
  readonly backend: RemoteAgentV2Backend;
  /** Product-facing placement id, conventionally `remote:<host-id>`. */
  readonly backendId: string;
  readonly capabilities?: Partial<RemoteAgentV2HostCapabilities>;
  /**
   * Trailing window used to collapse a burst of native catalog hints into one
   * listing. A running native session emits far more events than its catalog
   * row has distinct states.
   */
  readonly catalogCoalesceMs?: number;
  /** Clock used for in-memory presence membership timestamps. */
  readonly clock?: () => AgentTimestamp;
  readonly limits?: Partial<RemoteAgentV2Limits>;
  readonly onError?: (error: AgentBackendError) => void;
  readonly scheduler?: RemoteAgentV2HostScheduler;
  readonly store: RemoteAgentV2HostStore;
  readonly transport: RemoteAgentHostDeliveryTransport;
}

interface RemoteAgentV2Subscriber {
  readonly peer: RemoteAgentHostPeer;
  readonly since: AgentTimestamp;
}

interface Owner {
  readonly nativeRef: AgentSessionRef;
  readonly ref: AgentSessionRef;
  readonly subscribers: Map<string, RemoteAgentV2Subscriber>;
  initializing: Promise<void>;
  index?: RemoteAgentV2StoredSessionIndex;
  runtime?: RemoteAgentV2Runtime;
  snapshot?: RemoteAgentV2SessionSnapshot;
  tail: Promise<void>;
  transientTail: Promise<void>;
  unsubscribe?: () => void;
  /** Includes the in-flight send and queued transient deliveries. */
  transientPending: number;
  transientSeq: number;
  presenceSeq: number;
}

interface AttachmentUpload {
  readonly peerId: string;
  readonly transportId: string;
  readonly ref: AgentSessionRef;
  readonly uploadId: string;
  readonly totalBytes: number;
  readonly mimeType: string;
  readonly name?: string;
  readonly chunks: Uint8Array[];
  nextOffset: number;
  complete: boolean;
}

interface AttachmentReadCache {
  readonly peerId: string;
  readonly transportId: string;
  readonly ref: AgentSessionRef;
  readonly value: AgentAttachmentReadResult;
}

function invalid(message: string): never {
  throw new AgentBackendError("invalid_argument", message);
}

function parseSchema<T>(
  schema: { readonly parse: (value: unknown) => T },
  value: unknown,
  label: string,
): T {
  try {
    return schema.parse(value);
  } catch {
    invalid(`${label} is invalid`);
  }
}

function protocol(message: string): never {
  throw new AgentBackendError("protocol", message);
}

function json(value: unknown): JsonValue {
  try {
    return jsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
  } catch {
    throw new AgentBackendError("protocol", "The remote agent value is not JSON serializable");
  }
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function base64Bytes(value: string, label: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (btoa(binary) !== value) protocol(`${label} is not canonical base64`);
    return bytes;
  } catch {
    protocol(`${label} is not canonical base64`);
  }
}

function uploadBase64Bytes(value: string): Uint8Array {
  try {
    const binary = atob(value);
    if (btoa(binary) !== value) throw new Error("non-canonical");
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new AgentBackendError("invalid_argument", "Attachment chunk is not canonical base64");
  }
}

function encodedBytes(value: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    binary += String.fromCharCode(...value.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function responseTooLarge(code: "entry_too_large" | "response_too_large", message: string): never {
  throw new OrbisTransportError("remote_request", message, { serverCode: code });
}

/**
 * Baseline branch: a trailing window ending at the newest entry, packed
 * backwards to fill the byte budget. `hasMore` is always `false` — a baseline
 * never continues forward, it replaces the client's transcript outright.
 */
function snapshotResult(
  snapshot: RemoteAgentV2SessionSnapshot,
  hostRevision: string,
  limit: number,
  maxResponseBytes: number,
): JsonValue {
  const throughCursor = snapshot.entries.at(-1)?.cursor ?? 0;
  if (
    jsonByteLength({
      baseline: true,
      entries: [],
      hasMore: false,
      hasOlder: snapshot.entries.length > 0,
      hostRevision,
      oldestCursor: 0,
      overlay: snapshot.overlay,
      state: snapshot.state,
      throughCursor,
    }) > maxResponseBytes
  ) {
    responseTooLarge(
      "response_too_large",
      "The session state cannot fit in one encrypted transport frame",
    );
  }
  const lowerBound = Math.max(0, snapshot.entries.length - limit);
  let start = snapshot.entries.length;
  let entriesContentBytes = 0;

  while (start > lowerBound) {
    const candidate = snapshot.entries[start - 1] as RemoteAgentV2Entry;
    const candidateContentBytes =
      entriesContentBytes + jsonByteLength(candidate) + (start < snapshot.entries.length ? 1 : 0);
    const candidateStart = start - 1;
    const resultBytes =
      jsonByteLength({
        baseline: true,
        entries: [],
        hasMore: false,
        hasOlder: candidateStart > 0,
        hostRevision,
        oldestCursor: candidate.cursor,
        overlay: snapshot.overlay,
        state: snapshot.state,
        throughCursor,
      }) + candidateContentBytes;
    if (resultBytes > maxResponseBytes) break;
    start = candidateStart;
    entriesContentBytes = candidateContentBytes;
  }

  if (start === snapshot.entries.length && snapshot.entries.length > 0 && limit > 0) {
    responseTooLarge(
      "entry_too_large",
      "The newest session entry cannot fit in one encrypted transport frame",
    );
  }

  const entries = snapshot.entries.slice(start);
  const result = {
    baseline: true,
    entries,
    hasMore: false,
    hasOlder: start > 0,
    hostRevision,
    oldestCursor: entries[0]?.cursor ?? 0,
    overlay: snapshot.overlay,
    state: snapshot.state,
    throughCursor,
  };
  if (jsonByteLength(result) > maxResponseBytes) {
    responseTooLarge(
      "response_too_large",
      "The session state cannot fit in one encrypted transport frame",
    );
  }
  return toJsonResult(result);
}

/**
 * Continuation branch: the mirror of `snapshotResult`, packing forward from
 * the first pending entry instead of backward from the newest. `hasOlder` is
 * always `false` — the client's existing transcript is the older part, and
 * forward pagination is expressed only through `hasMore`.
 */
function continuationResult(
  snapshot: RemoteAgentV2SessionSnapshot,
  pending: readonly RemoteAgentV2Entry[],
  afterCursor: number,
  hostRevision: string,
  limit: number,
  maxResponseBytes: number,
): JsonValue {
  if (
    jsonByteLength({
      baseline: false,
      entries: [],
      hasMore: pending.length > 0,
      hasOlder: false,
      hostRevision,
      oldestCursor: afterCursor,
      overlay: snapshot.overlay,
      state: snapshot.state,
      throughCursor: afterCursor,
    }) > maxResponseBytes
  ) {
    responseTooLarge(
      "response_too_large",
      "The session state cannot fit in one encrypted transport frame",
    );
  }
  const upperBound = Math.min(pending.length, limit);
  let end = 0;
  let entriesContentBytes = 0;

  while (end < upperBound) {
    const candidate = pending[end] as RemoteAgentV2Entry;
    const candidateContentBytes =
      entriesContentBytes + jsonByteLength(candidate) + (end > 0 ? 1 : 0);
    const candidateEnd = end + 1;
    const resultBytes =
      jsonByteLength({
        baseline: false,
        entries: [],
        hasMore: pending.length > candidateEnd,
        hasOlder: false,
        hostRevision,
        oldestCursor: (pending[0] as RemoteAgentV2Entry).cursor,
        overlay: snapshot.overlay,
        state: snapshot.state,
        throughCursor: candidate.cursor,
      }) + candidateContentBytes;
    if (resultBytes > maxResponseBytes) break;
    end = candidateEnd;
    entriesContentBytes = candidateContentBytes;
  }

  if (end === 0 && pending.length > 0 && limit > 0) {
    responseTooLarge(
      "entry_too_large",
      "The next session entry cannot fit in one encrypted transport frame",
    );
  }

  const entries = pending.slice(0, end);
  const result = {
    baseline: false,
    entries,
    hasMore: pending.length > entries.length,
    hasOlder: false,
    hostRevision,
    oldestCursor: entries[0]?.cursor ?? afterCursor,
    overlay: snapshot.overlay,
    state: snapshot.state,
    throughCursor: entries.at(-1)?.cursor ?? afterCursor,
  };
  if (jsonByteLength(result) > maxResponseBytes) {
    responseTooLarge(
      "response_too_large",
      "The session state cannot fit in one encrypted transport frame",
    );
  }
  return toJsonResult(result);
}

function olderEntriesResult(
  older: readonly RemoteAgentV2Entry[],
  limit: number,
  maxResponseBytes: number,
): JsonValue {
  if (jsonByteLength({ entries: [], hasOlder: older.length > 0 }) > maxResponseBytes) {
    responseTooLarge(
      "response_too_large",
      "The historical entry response cannot fit in one encrypted transport frame",
    );
  }
  const lowerBound = Math.max(0, older.length - limit);
  let start = older.length;
  let entriesContentBytes = 0;

  while (start > lowerBound) {
    const candidate = older[start - 1] as RemoteAgentV2Entry;
    const candidateContentBytes =
      entriesContentBytes + jsonByteLength(candidate) + (start < older.length ? 1 : 0);
    const candidateStart = start - 1;
    const resultBytes =
      jsonByteLength({ entries: [], hasOlder: candidateStart > 0 }) + candidateContentBytes;
    if (resultBytes > maxResponseBytes) break;
    start = candidateStart;
    entriesContentBytes = candidateContentBytes;
  }

  if (start === older.length && older.length > 0 && limit > 0) {
    responseTooLarge(
      "entry_too_large",
      "The next historical session entry cannot fit in one encrypted transport frame",
    );
  }
  const result = { entries: older.slice(start), hasOlder: start > 0 };
  if (jsonByteLength(result) > maxResponseBytes) {
    responseTooLarge(
      "response_too_large",
      "The historical entry response cannot fit in one encrypted transport frame",
    );
  }
  return toJsonResult(result);
}

function parseRef(value: unknown): AgentSessionRef {
  const input = parseSchema(v2RefSchema, value, "Session locator");
  return createAgentSessionRef({
    backendId: input.backendId,
    driverId: input.driverId,
    nativeSessionId: input.nativeSessionId,
    sessionId: input.sessionId,
  });
}

function parseModel(value: unknown): RemoteAgentV2ModelSelection {
  return parseSchema(v2ModelSchema, value, "Model selection");
}

function parseContent(value: unknown): RemoteAgentV2ContentBlock {
  return parseSchema(v2ContentBlockSchema, value, "Content block");
}

function parsePromptContent(value: unknown): RemoteAgentV2PromptContentBlock {
  return parseSchema(v2PromptContentBlockSchema, value, "Prompt content block");
}

function parseDevice(value: unknown): RemoteAgentV2DeviceDescriptor {
  return parseSchema(v2DeviceSchema, value, "Device descriptor");
}

function parseHelloInput(value: JsonValue): {
  readonly device: RemoteAgentV2DeviceDescriptor;
  readonly supportedVersions: readonly number[];
} {
  const input = parseSchema(v2HelloInputSchema, value, "Hello input");
  const { supportedVersions } = input;
  if (!supportedVersions.includes(ORBIS_REMOTE_AGENT_V2_PROTOCOL_VERSION)) {
    throw new AgentBackendError(
      "version_unsupported",
      "The client does not support Orbis protocol v2",
    );
  }
  return {
    supportedVersions,
    device: parseDevice(input.device),
  };
}

function parseListInput(value: JsonValue): {
  readonly cursor?: string;
  readonly driverId?: string;
  readonly limit?: number;
} {
  const input = parseSchema(v2ListInputSchema, value, "Session list input");
  return {
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.driverId === undefined ? {} : { driverId: input.driverId }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
}

function parseSubagentListInput(value: JsonValue): { readonly ref: AgentSessionRef } {
  const input = parseSchema(v2SubagentListInputSchema, value, "Subagent list input");
  return { ref: parseRef(input.ref) };
}

function parseSyncInput(value: JsonValue): {
  readonly afterCursor?: number;
  readonly afterEntryId?: string | null;
  readonly limit?: number;
  readonly mode: "once" | "live";
  readonly ref: AgentSessionRef;
} {
  const input = parseSchema(v2SyncInputSchema, value, "Session sync input");
  return {
    ...(input.afterCursor === undefined ? {} : { afterCursor: input.afterCursor }),
    ...(input.afterEntryId === undefined ? {} : { afterEntryId: input.afterEntryId }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    mode: input.mode,
    ref: parseRef(input.ref),
  };
}

function parsePromptInput(value: JsonValue): RemoteAgentV2PromptInput {
  const input = parseSchema(v2PromptInputSchema, value, "Prompt input");
  return {
    content: input.content.map((item) => parsePromptContent(item)),
    ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    idempotencyKey: input.idempotencyKey,
    ref: parseRef(input.ref),
  };
}

function parsePromptReferenceCompletionInput(
  value: JsonValue,
): AgentPromptReferenceCompletionInput {
  const input = parseSchema(
    v2PromptReferenceCompletionInputSchema,
    value,
    "Prompt reference completion input",
  );
  return validateAgentPromptReferenceCompletionInput({
    cursor: input.cursor,
    limit: input.limit,
    ref: parseRef(input.ref),
    source: input.source,
    text: input.text,
  });
}

function parseCancelInput(value: JsonValue): RemoteAgentV2CancelInput {
  const input = parseSchema(v2CancelInputSchema, value, "Cancel input");
  return {
    ...(input.runId === undefined ? {} : { runId: agentRunId(input.runId) }),
    ...(input.keepInbox === undefined ? {} : { keepInbox: input.keepInbox }),
    idempotencyKey: input.idempotencyKey,
    ref: parseRef(input.ref),
  };
}

function parseUpdateInput(value: JsonValue): RemoteAgentV2UpdateInput {
  const input = parseSchema(v2UpdateInputSchema, value, "Session update input");
  return {
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    idempotencyKey: input.idempotencyKey,
    patch: {
      ...(input.patch.title === undefined ? {} : { title: input.patch.title }),
      ...(input.patch.model === undefined
        ? {}
        : { model: input.patch.model === null ? null : parseModel(input.patch.model) }),
      ...(input.patch.mode === undefined ? {} : { mode: input.patch.mode }),
      ...(input.patch.configOptions === undefined
        ? {}
        : {
            configOptions: input.patch.configOptions as Readonly<Record<string, AgentJsonValue>>,
          }),
    },
    ref: parseRef(input.ref),
  };
}

function parsePermissionResponseInput(value: JsonValue): RemoteAgentV2PermissionResponseInput {
  const input = parseSchema(v2PermissionResponseInputSchema, value, "Permission response input");
  return {
    idempotencyKey: input.idempotencyKey,
    optionId: input.optionId,
    ref: parseRef(input.ref),
    requestId: input.requestId,
  };
}

function parseQuestionResponseInput(value: JsonValue): RemoteAgentV2QuestionResponseInput {
  const input = parseSchema(v2QuestionResponseInputSchema, value, "Question response input");
  try {
    const validated = validateAgentQuestionResponseInput(input);
    return {
      idempotencyKey: validated.idempotencyKey ?? input.idempotencyKey,
      ref: parseRef(input.ref),
      requestId: validated.requestId,
      response: validated.response,
    };
  } catch {
    invalid("Question response input is invalid");
  }
}

function publicRef(backendId: AgentBackendId, nativeRef: AgentSessionRef): AgentSessionRef {
  return createAgentSessionRef({
    backendId,
    driverId: nativeRef.driverId,
    nativeSessionId: nativeRef.nativeSessionId,
    sessionId: nativeRef.sessionId,
  });
}

function nativeRef(backendId: AgentBackendId, ref: AgentSessionRef): AgentSessionRef {
  return createAgentSessionRef({
    backendId,
    driverId: ref.driverId,
    nativeSessionId: ref.nativeSessionId,
    sessionId: ref.sessionId,
  });
}

function sourceFor(
  ref: AgentSessionRef,
  source: RemoteAgentV2SessionEvent["source"],
): RemoteAgentV2SessionEvent["source"] {
  return { ...source, backendId: ref.backendId, driverId: ref.driverId };
}

function publicSummary(
  backendId: AgentBackendId,
  summary: RemoteAgentV2SessionSummary,
): RemoteAgentV2SessionSummary {
  return { ...summary, ref: publicRef(backendId, summary.ref) };
}

function publicRecord(
  backendId: AgentBackendId,
  recordValue: RemoteAgentV2SessionRecord,
): RemoteAgentV2SessionRecord {
  return { ...recordValue, ref: publicRef(backendId, recordValue.ref) };
}

interface SessionListCursor {
  readonly sessionId: string;
  readonly updatedAt: string;
}

function compareSessionKey(
  session: Pick<RemoteAgentV2SessionSummary, "ref" | "updatedAt">,
  cursor: SessionListCursor,
): number {
  return (
    cursor.updatedAt.localeCompare(session.updatedAt) ||
    session.ref.sessionId.localeCompare(cursor.sessionId)
  );
}

function compareSessions(
  left: RemoteAgentV2SessionSummary,
  right: RemoteAgentV2SessionSummary,
): number {
  // The catalog is newest-first. Session id is the deterministic ascending
  // tie-breaker, which keeps the opaque cursor stable for equal timestamps.
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.ref.sessionId.localeCompare(right.ref.sessionId)
  );
}

function encodeSessionCursor(session: RemoteAgentV2SessionSummary): string {
  return `${encodeURIComponent(session.updatedAt)}|${encodeURIComponent(session.ref.sessionId)}`;
}

function decodeSessionCursor(value: string): SessionListCursor {
  const parts = value.split("|");
  if (parts.length !== 2) invalid("Session list cursor is invalid");
  try {
    const updatedAt = decodeURIComponent(parts[0] ?? "");
    const sessionId = decodeURIComponent(parts[1] ?? "");
    if (updatedAt.length === 0 || sessionId.length === 0) invalid("Session list cursor is invalid");
    return { sessionId, updatedAt };
  } catch {
    invalid("Session list cursor is invalid");
  }
}

function sameEntryPrefix(
  index: readonly RemoteAgentV2StoredEntryIndex[],
  entries: readonly RemoteAgentV2Entry[],
): boolean {
  if (index.length > entries.length) return false;
  return index.every((candidate, position) => candidate.entryId === entries[position]?.id);
}

function materializeEntries(
  index: RemoteAgentV2StoredSessionIndex,
  entries: readonly RemoteAgentV2Entry[],
): readonly RemoteAgentV2Entry[] {
  const cursorById = new Map(index.entries.map((entry) => [entry.entryId, entry.cursor]));
  return entries.map((entry) => ({
    ...entry,
    cursor: agentDeliveryCursor(cursorById.get(entry.id) ?? 0),
  }));
}

function eventBase(
  ref: AgentSessionRef,
  event: RemoteAgentV2SessionEvent,
): Pick<RemoteAgentV2SessionEvent, "eventId" | "occurredAt" | "sessionId" | "source"> {
  return {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    sessionId: ref.sessionId,
    source: sourceFor(ref, event.source),
  };
}

function entryEvent(
  ref: AgentSessionRef,
  entry: RemoteAgentV2Entry,
  eventId: string,
  occurredAt: RemoteAgentV2SessionEvent["occurredAt"],
  source: RemoteAgentV2SessionEvent["source"],
  settlesEntryId?: AgentEntryId,
): RemoteAgentV2SessionEvent {
  return {
    channel: "replayable",
    cursor: entry.cursor,
    entry,
    eventId: agentEventId(eventId),
    occurredAt,
    sessionId: ref.sessionId,
    source: sourceFor(ref, source),
    ...(settlesEntryId === undefined ? {} : { settlesEntryId }),
    type: "entry.appended",
  };
}

function transportEvent(
  ref: AgentSessionRef,
  event: RemoteAgentV2Event,
  transientSeq: number,
): TransportEvent {
  const durable = "channel" in event && event.channel === "replayable";
  const source =
    "source" in event ? event.source : { backendId: ref.backendId, driverId: ref.driverId };
  const occurredAt =
    "occurredAt" in event ? event.occurredAt : agentTimestamp(new Date().toISOString());
  return {
    durability: durable ? "durable" : "transient",
    eventId: "eventId" in event ? event.eventId : agentEventId(`host:${event.type}`),
    eventSeq: durable ? event.cursor : transientSeq,
    payload: json({
      event,
      protocolVersion: ORBIS_REMOTE_AGENT_V2_PROTOCOL_VERSION,
      scope: { kind: "session", ref },
    }),
    sessionId: ref.sessionId,
    source: {
      harness: source.driverId,
      ...(source.nativeType === undefined ? {} : { nativeType: source.nativeType }),
      ...(source.version === undefined ? {} : { version: source.version }),
    },
    time: occurredAt,
    type: ORBIS_REMOTE_AGENT_V2_EVENT_TYPE,
  };
}

function hostTransportEvent(
  backendId: AgentBackendId,
  event: RemoteAgentV2HostEvent,
  eventSeq: number,
): TransportEvent {
  const occurredAt = agentTimestamp(new Date().toISOString());
  return {
    durability: "transient",
    eventId: agentEventId(`host:${eventSeq}`),
    eventSeq,
    payload: json({
      event,
      protocolVersion: ORBIS_REMOTE_AGENT_V2_PROTOCOL_VERSION,
      scope: { kind: "host" },
    }),
    sessionId: `host:${backendId}`,
    source: { harness: "orbis-remote-agent", nativeType: "host" },
    time: occurredAt,
    type: ORBIS_REMOTE_AGENT_V2_EVENT_TYPE,
  };
}

function asTransportError(error: unknown): OrbisTransportError {
  if (error instanceof OrbisTransportError) return error;
  if (!(error instanceof AgentBackendError)) {
    return new OrbisTransportError("remote_request", "The remote agent operation failed", {
      retryable: true,
      serverCode: "unavailable",
    });
  }
  switch (error.code) {
    case "invalid_argument":
      return new OrbisTransportError("invalid_argument", error.message);
    case "protocol":
      return new OrbisTransportError("protocol", error.message);
    case "not_found":
      return new OrbisTransportError("remote_request", error.message, { serverCode: "not_found" });
    case "conflict":
    case "cursor_conflict":
    case "cursor_gap":
      return new OrbisTransportError("remote_request", error.message, { serverCode: "conflict" });
    case "revision_conflict":
      return new OrbisTransportError("remote_request", error.message, {
        serverCode: "revision_conflict",
      });
    case "unsupported":
      return new OrbisTransportError("remote_request", error.message, {
        serverCode: "unsupported",
      });
    case "version_unsupported":
      return new OrbisTransportError("remote_request", error.message, {
        serverCode: "version_unsupported",
      });
    case "closed":
    case "unavailable":
      return new OrbisTransportError("remote_request", error.message, {
        retryable: error.retryable || error.code === "unavailable",
        serverCode: "unavailable",
      });
  }
}

function toStateWithRef(
  backendId: AgentBackendId,
  state: RemoteAgentV2SessionState,
): RemoteAgentV2SessionState {
  return { ...state, ref: publicRef(backendId, state.ref) };
}

function sessionSummary(
  ref: AgentSessionRef,
  snapshot: RemoteAgentV2SessionSnapshot,
): RemoteAgentV2SessionSummary {
  return {
    driverId: ref.driverId,
    ref,
    runState: snapshot.state.runState,
    title: snapshot.state.title,
    updatedAt: snapshot.state.updatedAt,
  };
}

function catalogIndex(
  sessions: readonly RemoteAgentV2SessionSummary[],
): Map<string, RemoteAgentV2SessionSummary> {
  return new Map(sessions.map((session) => [session.ref.sessionId, session]));
}

function sameSessionSummary(
  left: RemoteAgentV2SessionSummary,
  right: RemoteAgentV2SessionSummary,
): boolean {
  return (
    left.ref.sessionId === right.ref.sessionId &&
    left.title === right.title &&
    left.runState === right.runState &&
    left.updatedAt === right.updatedAt
  );
}

function toJsonResult(value: unknown): JsonValue {
  return json(value);
}

const DEFAULT_CATALOG_COALESCE_MS = 500;
const MAX_PENDING_TRANSIENT_DELIVERIES = 256;

const defaultScheduler: RemoteAgentV2HostScheduler = {
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
};

const defaultPresenceClock = (): AgentTimestamp => agentTimestamp(new Date().toISOString());

/** Host-side v2 owner: native transcript plus a small cursor/index store. */
export class OrbisRemoteAgentV2Host {
  private readonly backend: RemoteAgentV2Backend;
  private readonly backendId: AgentBackendId;
  private readonly owners = new Map<string, Owner>();
  private readonly uploadsByPeer = new Map<string, Map<string, AttachmentUpload>>();
  private readonly attachmentReads = new Map<string, AttachmentReadCache>();
  private readonly helloPeers = new Map<string, RemoteAgentHostPeer>();
  private readonly store: RemoteAgentV2HostStore;
  private readonly transport: RemoteAgentHostDeliveryTransport;
  private readonly capabilities: RemoteAgentV2HostCapabilities;
  private readonly limits: RemoteAgentV2Limits;
  private readonly onError: ((error: AgentBackendError) => void) | undefined;
  private readonly scheduler: RemoteAgentV2HostScheduler;
  private readonly clock: () => AgentTimestamp;
  private readonly catalogCoalesceMs: number;
  private readonly detachCatalog: (() => void) | undefined;
  private readonly detachPeerDisconnected: (() => void) | undefined;
  /** Last catalog the host published, keyed by public session id. */
  private catalogBaseline: Map<string, RemoteAgentV2SessionSummary> | undefined;
  private catalogHandle: unknown;
  private catalogTail: Promise<void> = Promise.resolve();
  private hostEventSeq = 0;
  private closed = false;

  constructor(options: RemoteAgentV2HostOptions) {
    this.backend = options.backend;
    this.backendId = agentBackendId(options.backendId);
    if (!this.backendId.startsWith("remote:")) {
      throw new AgentBackendError(
        "invalid_argument",
        "A remote host backend id must begin with 'remote:'",
      );
    }
    this.store = options.store;
    this.transport = options.transport;
    this.onError = options.onError;
    this.capabilities = {
      attachments: false,
      dispose: false,
      fork: false,
      presence: false,
      ...options.capabilities,
    };
    this.limits = {
      maxPromptBytes: 1_048_576,
      maxReplayBatch: 256,
      maxSnapshotWindow: 256,
      ...options.limits,
    };
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.clock = options.clock ?? defaultPresenceClock;
    this.catalogCoalesceMs = options.catalogCoalesceMs ?? DEFAULT_CATALOG_COALESCE_MS;
    this.detachCatalog = this.backend.observeCatalog?.(() => this.scheduleCatalogSweep());
    this.detachPeerDisconnected = this.transport.onPeerDisconnected?.((peer) => {
      this.handlePeerDisconnected(peer);
    });
  }

  async handleRequest(
    method: string,
    params: JsonValue,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    try {
      this.assertOpen();
      if (!Number.isSafeInteger(context.maxResponseBytes) || context.maxResponseBytes < 0) {
        throw new OrbisTransportError("protocol", "The transport response byte budget is invalid");
      }
      if (context.signal.aborted)
        throw new OrbisTransportError("aborted", "The request was cancelled");
      if (method === ORBIS_REMOTE_AGENT_V2_METHODS.hello) {
        if (this.helloPeers.has(context.peer.transportId)) {
          throw new AgentBackendError(
            "protocol",
            "orbis.hello may only be called once per connection",
          );
        }
        const input = parseHelloInput(params);
        const result = await this.hello(input);
        for (const [transportId, peer] of this.helloPeers) {
          if (peer.id === context.peer.id && transportId !== context.peer.transportId) {
            this.helloPeers.delete(transportId);
          }
        }
        this.helloPeers.set(context.peer.transportId, context.peer);
        return toJsonResult(result);
      }
      if (!this.helloPeers.has(context.peer.transportId)) {
        throw new AgentBackendError("protocol", "orbis.hello must be the first agent request");
      }
      switch (method) {
        case ORBIS_REMOTE_AGENT_V2_METHODS.modelsList:
          return toJsonResult({
            models: await this.backend.listModels(
              (() => {
                const input = parseSchema(v2ModelsListInputSchema, params, "Model list input");
                return input.driverId === undefined ? undefined : agentDriverId(input.driverId);
              })(),
            ),
            revision: await this.store.readHostRevision(),
          });
        case ORBIS_REMOTE_AGENT_V2_METHODS.workspacesList: {
          const input = parseSchema(v2WorkspacesListInputSchema, params, "Workspace list input");
          return toJsonResult({
            workspaces: await this.backend.listWorkspaces(agentDriverId(input.driverId)),
          });
        }
        case ORBIS_REMOTE_AGENT_V2_METHODS.workspacesBrowse:
          return toJsonResult(await this.browseWorkspaces(params, context));
        case ORBIS_REMOTE_AGENT_V2_METHODS.workspacesCreateFolder:
          return await this.createWorkspaceFolder(params, context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.workspacesRegister:
          return await this.registerWorkspace(params, context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.sessionsList:
          return toJsonResult(await this.listSessions(parseListInput(params)));
        case ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSubagentsList:
          return await this.listSessionSubagents(parseSubagentListInput(params), context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.sessionsCreate:
          return await this.createSession(params, context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.promptReferencesFiles:
          return await this.completePromptReferences(params, context, "files");
        case ORBIS_REMOTE_AGENT_V2_METHODS.promptReferencesSessions:
          return await this.completePromptReferences(params, context, "sessions");
        case ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync:
          return await this.sync(parseSyncInput(params), context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.sessionsEntries:
          return await this.entries(params, context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt:
          return await this.prompt(parsePromptInput(params), context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.sessionsCancel:
          return await this.cancel(parseCancelInput(params), context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.sessionsRespondPermission:
          return await this.respondPermission(parsePermissionResponseInput(params), context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.sessionsRespondQuestion:
          return await this.respondQuestion(parseQuestionResponseInput(params), context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadBegin:
          return await this.attachmentUploadBegin(params, context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadChunk:
          return await this.attachmentUploadChunk(params, context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadFinish:
          return await this.attachmentUploadFinish(params, context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadAbort:
          return await this.attachmentUploadAbort(params, context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsRead:
          return await this.attachmentRead(params, context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.sessionsUpdate:
          return await this.update(parseUpdateInput(params), context);
        case ORBIS_REMOTE_AGENT_V2_METHODS.sessionsFork:
        case ORBIS_REMOTE_AGENT_V2_METHODS.sessionsDispose:
          throw new AgentBackendError(
            "unsupported",
            "This host does not support the requested v2 operation",
          );
        default:
          throw new OrbisTransportError("remote_request", "The v2 agent method is not supported", {
            serverCode: "method_not_found",
          });
      }
    } catch (error) {
      throw asTransportError(error);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detachCatalog?.();
    this.detachPeerDisconnected?.();
    if (this.catalogHandle !== undefined) {
      this.scheduler.cancel(this.catalogHandle);
      this.catalogHandle = undefined;
    }
    const owners = [...this.owners.values()];
    this.owners.clear();
    this.helloPeers.clear();
    this.uploadsByPeer.clear();
    this.attachmentReads.clear();
    await Promise.all(
      owners.map(async (owner) => {
        owner.unsubscribe?.();
        await Promise.all([
          owner.tail.catch(() => undefined),
          owner.transientTail.catch(() => undefined),
        ]);
        await owner.runtime?.close().catch(() => undefined);
      }),
    );
  }

  private async hello(_input: {
    readonly device: RemoteAgentV2DeviceDescriptor;
    readonly supportedVersions: readonly number[];
  }): Promise<RemoteAgentV2Hello> {
    return {
      capabilities: this.capabilities,
      drivers: await this.backend.listDrivers(),
      hostId: this.backendId,
      hostRevision: await this.store.readHostRevision(),
      limits: this.limits,
      version: 2,
    };
  }

  private async listSessions(input: {
    readonly cursor?: string;
    readonly driverId?: string;
    readonly limit?: number;
  }): Promise<JsonValue> {
    const sessions = await this.backend.listSessions({
      driverId: input.driverId === undefined ? undefined : agentDriverId(input.driverId),
    });
    const publicSessions = sessions
      .map((session) => publicSummary(this.backendId, session))
      .sort(compareSessions);
    // An unfiltered listing is the moment host and client agree on the catalog.
    // Anchoring the diff baseline here keeps a later native hint describing what
    // actually changed since a client last saw the list.
    if (input.driverId === undefined) this.catalogBaseline = catalogIndex(publicSessions);
    let offset = 0;
    if (input.cursor !== undefined) {
      const cursor = decodeSessionCursor(input.cursor);
      const next = publicSessions.findIndex((session) => compareSessionKey(session, cursor) > 0);
      offset = next === -1 ? publicSessions.length : next;
    }
    const page =
      input.limit === undefined
        ? publicSessions.slice(offset)
        : publicSessions.slice(offset, offset + input.limit);
    return toJsonResult({
      sessions: page,
      ...(offset + page.length < publicSessions.length && page.at(-1) !== undefined
        ? { nextCursor: encodeSessionCursor(page.at(-1) as RemoteAgentV2SessionSummary) }
        : {}),
    });
  }

  private async listSessionSubagents(
    input: { readonly ref: AgentSessionRef },
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    const owner = await this.ownerFor(input.ref);
    return this.enqueue(owner, async () => {
      this.assertRequestActive(context);
      await this.assertDriverCapability(owner.nativeRef.driverId, "session.subagents.list");
      const entries = validateAgentSessionSubagentList(
        await this.backend.listSessionSubagents(owner.nativeRef, context.signal),
        owner.nativeRef,
      );
      this.assertRequestActive(context);
      const publicEntries = entries.map((entry) => ({
        ...entry,
        parentRef: publicRef(this.backendId, entry.parentRef),
        ref: publicRef(this.backendId, entry.ref),
      }));
      const validatedPublicEntries = validateAgentSessionSubagentList(publicEntries, owner.ref);
      const result = parseSchema(
        v2SubagentListResponseSchema,
        { entries: validatedPublicEntries },
        "Subagent list result",
      );
      if (jsonByteLength(result) > context.maxResponseBytes) {
        responseTooLarge(
          "response_too_large",
          "The subagent list cannot fit in one encrypted transport frame",
        );
      }
      return toJsonResult(result);
    });
  }

  private async browseWorkspaces(params: JsonValue, context: RemoteAgentHostRequestContext) {
    const input = parseSchema(v2WorkspacesBrowseInputSchema, params, "Workspace browse input");
    const driverId = agentDriverId(input.driverId);
    await this.assertDriverCapability(driverId, "workspace.open");
    this.assertRequestActive(context);
    return await this.backend.browseWorkspaceFolders(driverId, input.folderRef, context.signal);
  }

  private async createWorkspaceFolder(
    params: JsonValue,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    const input = parseSchema(
      v2WorkspacesCreateFolderInputSchema,
      params,
      "Workspace folder creation input",
    );
    const driverId = agentDriverId(input.driverId);
    await this.assertDriverCapability(driverId, "workspace.open");
    const key = this.idempotencyKey(
      context.peer,
      ORBIS_REMOTE_AGENT_V2_METHODS.workspacesCreateFolder,
      input.idempotencyKey,
      input.driverId,
    );
    const claim = await this.store.claimIdempotency(key);
    if (claim.kind === "accepted") return toJsonResult(claim.result);
    if (claim.kind === "pending") {
      throw new AgentBackendError(
        "unavailable",
        "The prior workspace folder creation is still reconciling",
        { retryable: true },
      );
    }
    this.assertRequestActive(context);
    const result = toJsonResult(
      await this.backend.createWorkspaceFolder(driverId, input.parentFolderRef, input.name),
    );
    await this.store.completeIdempotency(key, result as AgentJsonValue);
    return result;
  }

  private async registerWorkspace(
    params: JsonValue,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    const input = parseSchema(
      v2WorkspacesRegisterInputSchema,
      params,
      "Workspace registration input",
    );
    const driverId = agentDriverId(input.driverId);
    await this.assertDriverCapability(driverId, "workspace.open");
    const key = this.idempotencyKey(
      context.peer,
      ORBIS_REMOTE_AGENT_V2_METHODS.workspacesRegister,
      input.idempotencyKey,
      input.driverId,
    );
    const claim = await this.store.claimIdempotency(key);
    if (claim.kind === "accepted") return toJsonResult(claim.result);
    if (claim.kind === "pending") {
      throw new AgentBackendError(
        "unavailable",
        "The prior workspace registration is still reconciling",
        { retryable: true },
      );
    }
    this.assertRequestActive(context);
    const result = toJsonResult(await this.backend.registerWorkspace(driverId, input.folderRef));
    await this.store.completeIdempotency(key, result as AgentJsonValue);
    return result;
  }

  private async createSession(
    params: JsonValue,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    const input = parseSchema(v2CreateInputSchema, params, "Session creation input");
    const idempotencyKey = input.idempotencyKey;
    const key = this.idempotencyKey(
      context.peer,
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsCreate,
      idempotencyKey,
    );
    const claim = await this.store.claimIdempotency(key);
    if (claim.kind === "accepted") return toJsonResult(claim.result);
    if (claim.kind === "pending")
      throw new AgentBackendError("unavailable", "The prior operation is still being reconciled", {
        retryable: true,
      });
    const driverId = agentDriverId(input.driverId);
    const model = input.model === undefined ? undefined : parseModel(input.model);
    const { mode, title, workspaceRef, nativeSessionId } = input;
    const created = publicRecord(
      this.backendId,
      await this.backend.createSession({
        driverId,
        ...(model === undefined ? {} : { model }),
        ...(mode === undefined ? {} : { mode }),
        ...(title === undefined ? {} : { title }),
        ...(workspaceRef === undefined ? {} : { workspaceRef }),
        ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
      }),
    );
    const result = toJsonResult(created);
    await this.store.completeIdempotency(key, result as AgentJsonValue);
    await this.broadcastHostEvent({
      session: {
        driverId: created.driverId,
        ref: created.ref,
        runState: created.runState,
        title: created.title,
        updatedAt: created.updatedAt,
      },
      type: "host.session.added",
    });
    return result;
  }

  private async sync(
    input: ReturnType<typeof parseSyncInput>,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    const owner = await this.ownerFor(input.ref);
    return this.enqueue(owner, async () => {
      this.assertRequestActive(context);
      if (input.mode === "live") {
        const existing = owner.subscribers.get(context.peer.id);
        owner.subscribers.set(context.peer.id, {
          peer: context.peer,
          since: existing?.since ?? this.clock(),
        });
      } else {
        this.removePeer(owner, context.peer);
      }
      await this.refreshOwner(owner);
      if (this.capabilities.presence) {
        await this.broadcastPresence(owner);
      }
      const snapshot = this.requiredSnapshot(owner);
      const hostRevision = await this.store.readHostRevision();
      const limit = Math.min(input.limit ?? this.limits.maxReplayBatch, this.limits.maxReplayBatch);
      if (input.afterCursor === undefined) {
        return snapshotResult(
          snapshot,
          hostRevision,
          Math.min(limit, this.limits.maxSnapshotWindow),
          context.maxResponseBytes,
        );
      }
      const index = owner.index?.entries ?? [];
      const cursorIndex = index.find((entry) => entry.cursor === input.afterCursor);
      if (
        input.afterCursor > 0 &&
        (cursorIndex === undefined || cursorIndex.entryId !== input.afterEntryId)
      ) {
        return snapshotResult(
          snapshot,
          hostRevision,
          Math.min(limit, this.limits.maxSnapshotWindow),
          context.maxResponseBytes,
        );
      }
      const pending = snapshot.entries.filter((entry) => entry.cursor > input.afterCursor!);
      return continuationResult(
        snapshot,
        pending,
        input.afterCursor,
        hostRevision,
        limit,
        context.maxResponseBytes,
      );
    });
  }

  private async entries(
    params: JsonValue,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    const input = parseSchema(v2EntriesInputSchema, params, "Older entries input");
    const ref = parseRef(input.ref);
    const beforeCursor = input.beforeCursor;
    const limit = Math.min(
      input.limit ?? this.limits.maxSnapshotWindow,
      this.limits.maxSnapshotWindow,
    );
    const owner = await this.ownerFor(ref);
    return this.enqueue(owner, async () => {
      this.assertRequestActive(context);
      await this.refreshOwner(owner);
      const snapshot = this.requiredSnapshot(owner);
      const older = snapshot.entries.filter((entry) => entry.cursor < beforeCursor);
      return olderEntriesResult(older, limit, context.maxResponseBytes);
    });
  }

  private async completePromptReferences(
    params: JsonValue,
    context: RemoteAgentHostRequestContext,
    expectedSource: "files" | "sessions",
  ): Promise<JsonValue> {
    const input = parsePromptReferenceCompletionInput(params);
    if (input.source !== expectedSource) {
      invalid("Prompt reference completion source does not match the method");
    }
    await this.assertDriverCapability(
      input.ref.driverId,
      expectedSource === "files" ? "prompt.references.files" : "prompt.references.sessions",
    );
    const owner = await this.ownerFor(input.ref);
    return this.enqueue(owner, async () => {
      this.assertRequestActive(context);
      const result = await this.backend.completePromptReferences({
        ...input,
        ref: owner.nativeRef,
        signal: context.signal,
      });
      const validated = validateAgentPromptReferenceCompletionResult(result, input);
      const wire = validated === undefined ? null : validated;
      if (jsonByteLength(wire) > context.maxResponseBytes) {
        responseTooLarge(
          "response_too_large",
          "Prompt reference completion exceeds the response budget",
        );
      }
      return json(wire);
    });
  }

  private async prompt(
    input: RemoteAgentV2PromptInput,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    if (jsonByteLength(input.content) > this.limits.maxPromptBytes) {
      throw new AgentBackendError("invalid_argument", "Prompt content exceeds the host byte limit");
    }
    const owner = await this.ownerFor(input.ref);
    return this.enqueue(owner, async () => {
      this.assertRequestActive(context);
      const key = this.idempotencyKey(
        context.peer,
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt,
        input.idempotencyKey,
        input.ref.sessionId,
      );
      const claim = await this.store.claimIdempotency(key);
      if (claim.kind === "accepted") return toJsonResult(claim.result);
      if (claim.kind === "pending")
        throw new AgentBackendError("unavailable", "The prior prompt is still being reconciled", {
          retryable: true,
        });
      this.assertExpectedRevision(owner, input.expectedRevision);
      const runtime = this.requiredRuntime(owner);
      const resolvedContent = this.resolvePromptContent(owner, context.peer, input.content);
      const canonicalInput = validateAgentPromptInput({
        content: resolvedContent,
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      });
      const receipt = await runtime.prompt({
        content: canonicalInput.content,
        ...(canonicalInput.delivery === undefined ? {} : { delivery: canonicalInput.delivery }),
        ...(canonicalInput.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: canonicalInput.idempotencyKey }),
      });
      const result = toJsonResult(receipt);
      await this.store.completeIdempotency(key, result as AgentJsonValue);
      this.consumePromptUploads(context.peer, input.ref, input.content);
      return result;
    });
  }

  private async attachmentUploadBegin(
    params: JsonValue,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    const input = parseSchema(
      v2AttachmentUploadBeginInputSchema,
      params,
      "Attachment upload begin input",
    );
    const capability = this.requireAttachmentCapability();
    const ref = parseRef(input.ref);
    const owner = await this.ownerFor(ref);
    return this.enqueue(owner, async () => {
      this.assertRequestActive(context);
      if (!capability.mimeTypes.includes(input.mimeType)) {
        throw new AgentBackendError("invalid_argument", "Attachment MIME type is not supported");
      }
      if (input.totalBytes > capability.maxImageBytes) {
        throw new AgentBackendError("invalid_argument", "Attachment exceeds the image byte limit");
      }
      const key = this.idempotencyKey(
        context.peer,
        ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadBegin,
        input.idempotencyKey,
        input.uploadId,
      );
      const claim = await this.store.claimIdempotency(key);
      if (claim.kind === "accepted") return toJsonResult(claim.result);
      if (claim.kind === "pending") {
        throw new AgentBackendError("unavailable", "The attachment upload is still reconciling", {
          retryable: true,
        });
      }
      const uploads = this.uploadsFor(context.peer);
      const existing = uploads.get(input.uploadId);
      if (existing !== undefined) {
        if (
          existing.transportId !== context.peer.transportId ||
          !isSameAgentSessionRef(existing.ref, ref) ||
          existing.totalBytes !== input.totalBytes ||
          existing.mimeType !== input.mimeType ||
          existing.name !== input.name
        ) {
          throw new AgentBackendError("protocol", "Attachment upload identity was reused");
        }
      } else {
        const stagedCount = uploads.size;
        const stagedBytes = [...uploads.values()].reduce(
          (total, upload) => total + upload.totalBytes,
          0,
        );
        if (stagedCount >= capability.maxImagesPerMessage) {
          throw new AgentBackendError(
            "invalid_argument",
            "The peer has reached the staged image count limit",
          );
        }
        if (stagedBytes + input.totalBytes > capability.maxMessageImageBytes) {
          throw new AgentBackendError(
            "invalid_argument",
            "The peer has reached the staged image byte limit",
          );
        }
        uploads.set(input.uploadId, {
          chunks: [],
          complete: false,
          mimeType: input.mimeType,
          name: input.name,
          nextOffset: 0,
          peerId: context.peer.id,
          ref,
          totalBytes: input.totalBytes,
          transportId: context.peer.transportId,
          uploadId: input.uploadId,
        });
      }
      const result = toJsonResult({ uploadId: input.uploadId });
      await this.store.completeIdempotency(key, result as AgentJsonValue);
      return result;
    });
  }

  private async attachmentUploadChunk(
    params: JsonValue,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    const input = parseSchema(
      v2AttachmentUploadChunkInputSchema,
      params,
      "Attachment upload chunk input",
    );
    const capability = this.requireAttachmentCapability();
    const upload = this.uploadsFor(context.peer).get(input.uploadId);
    if (upload === undefined || upload.transportId !== context.peer.transportId) {
      throw new AgentBackendError("not_found", "The attachment upload was not found");
    }
    const owner = await this.ownerFor(upload.ref);
    return this.enqueue(owner, async () => {
      this.assertRequestActive(context);
      if (upload.complete)
        throw new AgentBackendError("conflict", "The attachment upload is complete");
      const key = this.idempotencyKey(
        context.peer,
        ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadChunk,
        input.idempotencyKey,
        `${input.uploadId}:${input.offset}`,
      );
      const claim = await this.store.claimIdempotency(key);
      if (claim.kind === "accepted") return toJsonResult(claim.result);
      if (claim.kind === "pending") {
        throw new AgentBackendError("unavailable", "The attachment chunk is still reconciling", {
          retryable: true,
        });
      }
      if (input.offset !== upload.nextOffset) {
        throw new AgentBackendError("invalid_argument", "Attachment chunks must be ordered");
      }
      const bytes = uploadBase64Bytes(input.data);
      if (bytes.byteLength === 0 || bytes.byteLength > capability.uploadChunkBytes) {
        throw new AgentBackendError("invalid_argument", "Attachment chunk size is invalid");
      }
      if (upload.nextOffset + bytes.byteLength > upload.totalBytes) {
        throw new AgentBackendError("invalid_argument", "Attachment chunks exceed declared size");
      }
      upload.chunks.push(bytes);
      upload.nextOffset += bytes.byteLength;
      const result = toJsonResult({ nextOffset: upload.nextOffset, uploadId: upload.uploadId });
      await this.store.completeIdempotency(key, result as AgentJsonValue);
      return result;
    });
  }

  private async attachmentUploadFinish(
    params: JsonValue,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    this.requireAttachmentCapability();
    const input = parseSchema(
      v2AttachmentUploadFinishInputSchema,
      params,
      "Attachment upload finish input",
    );
    const upload = this.uploadsFor(context.peer).get(input.uploadId);
    if (upload === undefined || upload.transportId !== context.peer.transportId) {
      throw new AgentBackendError("not_found", "The attachment upload was not found");
    }
    const owner = await this.ownerFor(upload.ref);
    return this.enqueue(owner, async () => {
      this.assertRequestActive(context);
      const key = this.idempotencyKey(
        context.peer,
        ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadFinish,
        input.idempotencyKey,
        input.uploadId,
      );
      const claim = await this.store.claimIdempotency(key);
      if (claim.kind === "accepted") return toJsonResult(claim.result);
      if (claim.kind === "pending") {
        throw new AgentBackendError("unavailable", "The attachment upload is still reconciling", {
          retryable: true,
        });
      }
      if (upload.nextOffset !== upload.totalBytes) {
        throw new AgentBackendError("invalid_argument", "The attachment upload is incomplete");
      }
      upload.complete = true;
      const result = toJsonResult({ uploadId: upload.uploadId });
      await this.store.completeIdempotency(key, result as AgentJsonValue);
      return result;
    });
  }

  private async attachmentUploadAbort(
    params: JsonValue,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    this.requireAttachmentCapability();
    const input = parseSchema(
      v2AttachmentUploadAbortInputSchema,
      params,
      "Attachment upload abort input",
    );
    this.assertRequestActive(context);
    const key = this.idempotencyKey(
      context.peer,
      ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadAbort,
      input.idempotencyKey,
      input.uploadId,
    );
    const claim = await this.store.claimIdempotency(key);
    if (claim.kind === "accepted") return toJsonResult(claim.result);
    if (claim.kind === "pending") {
      throw new AgentBackendError("unavailable", "The attachment abort is still reconciling", {
        retryable: true,
      });
    }
    const uploads = this.uploadsFor(context.peer);
    const upload = uploads.get(input.uploadId);
    const aborted = upload !== undefined && upload.transportId === context.peer.transportId;
    if (aborted) uploads.delete(input.uploadId);
    if (uploads.size === 0) this.uploadsByPeer.delete(context.peer.id);
    const result = toJsonResult({ aborted, uploadId: input.uploadId });
    await this.store.completeIdempotency(key, result as AgentJsonValue);
    return result;
  }

  private async attachmentRead(
    params: JsonValue,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    const capability = this.requireAttachmentCapability();
    const input = parseSchema(v2AttachmentReadInputSchema, params, "Attachment read input");
    const ref = parseRef(input.ref);
    const owner = await this.ownerFor(ref);
    return this.enqueue(owner, async () => {
      this.assertRequestActive(context);
      const cacheKey = `${context.peer.id}\u0000${ref.sessionId}\u0000${input.attachmentId}`;
      let cached = this.attachmentReads.get(cacheKey);
      if (cached !== undefined && cached.transportId !== context.peer.transportId)
        cached = undefined;
      if (cached === undefined) {
        const value = await this.backend.readAttachment(
          owner.nativeRef,
          input.attachmentId,
          context.signal,
        );
        cached = {
          peerId: context.peer.id,
          ref,
          transportId: context.peer.transportId,
          value,
        };
        this.attachmentReads.set(cacheKey, cached);
      }
      const bytes = base64Bytes(cached.value.data, "Attachment data");
      if (!capability.mimeTypes.includes(cached.value.mimeType)) {
        throw new AgentBackendError("protocol", "Attachment MIME type is not advertised");
      }
      if (bytes.byteLength > capability.maxImageBytes) {
        throw new AgentBackendError("protocol", "Attachment exceeds the advertised image limit");
      }
      if (cached.value.bytes !== undefined && cached.value.bytes !== bytes.byteLength) {
        throw new AgentBackendError("protocol", "Attachment metadata byte count is invalid");
      }
      const rawChunkBytes = Math.max(3, Math.floor(capability.downloadChunkBytes / 3) * 3);
      if (input.offset > bytes.byteLength) {
        throw new AgentBackendError("invalid_argument", "Attachment read offset is out of range");
      }
      const remaining = bytes.byteLength - input.offset;
      const length = Math.min(remaining, rawChunkBytes);
      const chunk = bytes.slice(input.offset, input.offset + length);
      const eof = input.offset + length === bytes.byteLength;
      if (!eof && chunk.byteLength % 3 !== 0) {
        throw new AgentBackendError("protocol", "Attachment download chunk alignment is invalid");
      }
      if (eof) this.attachmentReads.delete(cacheKey);
      return toJsonResult({
        attachmentId: cached.value.attachmentId,
        data: encodedBytes(chunk),
        eof,
        mimeType: cached.value.mimeType,
        nextOffset: input.offset + chunk.byteLength,
        ...(cached.value.name === undefined ? {} : { name: cached.value.name }),
        ...(cached.value.bytes === undefined ? {} : { bytes: cached.value.bytes }),
        ...(cached.value.width === undefined ? {} : { width: cached.value.width }),
        ...(cached.value.height === undefined ? {} : { height: cached.value.height }),
      });
    });
  }

  private requireAttachmentCapability(): Exclude<
    RemoteAgentV2HostCapabilities["attachments"],
    false
  > {
    if (this.capabilities.attachments === false) {
      throw new AgentBackendError("unsupported", "This host does not support attachments");
    }
    return this.capabilities.attachments;
  }

  private uploadsFor(peer: RemoteAgentHostPeer): Map<string, AttachmentUpload> {
    let uploads = this.uploadsByPeer.get(peer.id);
    if (uploads === undefined) {
      uploads = new Map();
      this.uploadsByPeer.set(peer.id, uploads);
    }
    return uploads;
  }

  private resolvePromptContent(
    owner: Owner,
    peer: RemoteAgentHostPeer,
    content: readonly RemoteAgentV2PromptContentBlock[],
  ): readonly AgentPromptContentBlock[] {
    const uploads = this.uploadsFor(peer);
    const imageUploads = content.filter((block) => block.type === "image_upload");
    const capability = imageUploads.length === 0 ? undefined : this.requireAttachmentCapability();
    if (capability !== undefined && imageUploads.length > capability.maxImagesPerMessage) {
      throw new AgentBackendError("invalid_argument", "Prompt contains too many images");
    }
    let imageBytes = 0;
    const resolved = content.map((block) => {
      if (block.type === "text") return block;
      const upload = uploads.get(block.uploadId);
      if (
        upload === undefined ||
        !upload.complete ||
        upload.transportId !== peer.transportId ||
        !isSameAgentSessionRef(upload.ref, owner.ref) ||
        upload.mimeType !== block.mimeType ||
        upload.name !== block.name
      ) {
        throw new AgentBackendError("invalid_argument", "Prompt image upload is not available");
      }
      imageBytes += upload.totalBytes;
      return {
        data: encodedBytes(concatBytes(upload.chunks)),
        ...(upload.name === undefined ? {} : { name: upload.name }),
        mimeType: upload.mimeType,
        type: "image" as const,
      };
    });
    if (capability !== undefined && imageBytes > capability.maxMessageImageBytes) {
      throw new AgentBackendError(
        "invalid_argument",
        "Prompt images exceed the aggregate byte limit",
      );
    }
    return resolved;
  }

  private consumePromptUploads(
    peer: RemoteAgentHostPeer,
    ref: AgentSessionRef,
    content: readonly RemoteAgentV2PromptContentBlock[],
  ): void {
    const uploads = this.uploadsByPeer.get(peer.id);
    if (uploads === undefined) return;
    for (const block of content) {
      if (block.type !== "image_upload") continue;
      const upload = uploads.get(block.uploadId);
      if (upload !== undefined && upload.complete && isSameAgentSessionRef(upload.ref, ref)) {
        uploads.delete(block.uploadId);
      }
    }
    if (uploads.size === 0) this.uploadsByPeer.delete(peer.id);
  }

  private async cancel(
    input: RemoteAgentV2CancelInput,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    const owner = await this.ownerFor(input.ref);
    return this.enqueue(owner, async () => {
      this.assertRequestActive(context);
      const key = this.idempotencyKey(
        context.peer,
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsCancel,
        input.idempotencyKey,
        input.ref.sessionId,
      );
      const claim = await this.store.claimIdempotency(key);
      if (claim.kind === "accepted") return toJsonResult(claim.result);
      if (claim.kind === "pending")
        throw new AgentBackendError("unavailable", "The prior cancel is still being reconciled", {
          retryable: true,
        });
      const result = toJsonResult(
        await this.requiredRuntime(owner).cancel({
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.keepInbox === undefined ? {} : { keepInbox: input.keepInbox }),
          idempotencyKey: input.idempotencyKey,
        }),
      );
      await this.store.completeIdempotency(key, result as AgentJsonValue);
      return result;
    });
  }

  private async respondPermission(
    input: RemoteAgentV2PermissionResponseInput,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    const owner = await this.ownerFor(input.ref);
    return this.enqueue(owner, async () => {
      this.assertRequestActive(context);
      await this.assertDriverCapability(owner.nativeRef.driverId, "permission.respond");
      const key = this.idempotencyKey(
        context.peer,
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsRespondPermission,
        input.idempotencyKey,
        input.ref.sessionId,
      );
      const claim = await this.store.claimIdempotency(key);
      if (claim.kind === "accepted") return toJsonResult(claim.result);
      if (claim.kind === "pending") {
        throw new AgentBackendError(
          "unavailable",
          "The prior permission response is still reconciling",
          { retryable: true },
        );
      }
      const result = toJsonResult(
        await this.requiredRuntime(owner).respondPermission({
          requestId: input.requestId,
          optionId: input.optionId,
          idempotencyKey: input.idempotencyKey,
        }),
      );
      await this.store.completeIdempotency(key, result as AgentJsonValue);
      return result;
    });
  }

  private async respondQuestion(
    input: RemoteAgentV2QuestionResponseInput,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    const owner = await this.ownerFor(input.ref);
    return this.enqueue(owner, async () => {
      this.assertRequestActive(context);
      await this.assertDriverCapability(owner.nativeRef.driverId, "question.respond");
      const key = this.idempotencyKey(
        context.peer,
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsRespondQuestion,
        input.idempotencyKey,
        input.ref.sessionId,
      );
      const claim = await this.store.claimIdempotency(key);
      if (claim.kind === "accepted") return toJsonResult(claim.result);
      if (claim.kind === "pending") {
        throw new AgentBackendError(
          "unavailable",
          "The prior question response is still reconciling",
          { retryable: true },
        );
      }
      const request = this.requiredSnapshot(owner).state.pendingQuestions.find(
        (candidate) => candidate.requestId === input.requestId,
      );
      if (request !== undefined) {
        // Enforce full-set/question-option membership at the host boundary while
        // allowing the runtime to return accepted:false for an already-resolved
        // request that is no longer present in the snapshot.
        validateAgentQuestionResponseForRequest(
          {
            idempotencyKey: input.idempotencyKey,
            requestId: input.requestId,
            response: input.response,
          },
          request,
        );
      }
      const result = toJsonResult(
        await this.requiredRuntime(owner).respondQuestion({
          requestId: input.requestId,
          response: input.response,
          idempotencyKey: input.idempotencyKey,
        }),
      );
      await this.store.completeIdempotency(key, result as AgentJsonValue);
      return result;
    });
  }

  private async update(
    input: RemoteAgentV2UpdateInput,
    context: RemoteAgentHostRequestContext,
  ): Promise<JsonValue> {
    const owner = await this.ownerFor(input.ref);
    return this.enqueue(owner, async () => {
      this.assertRequestActive(context);
      if (Object.keys(input.patch).length === 0) {
        throw new AgentBackendError("invalid_argument", "A session update requires a patch");
      }
      if (input.patch.model !== undefined) {
        const driver = (await this.backend.listDrivers()).find(
          (candidate) => candidate.id === owner.nativeRef.driverId,
        );
        if (driver === undefined) {
          throw new AgentBackendError("not_found", "The session driver is unavailable");
        }
        if (!hasAgentDriverCapability(driver, "model.select")) {
          throw new AgentBackendError("unsupported", "The session driver cannot select models");
        }
      }
      if (input.patch.mode === "plan" || input.patch.mode === null) {
        await this.assertDriverCapability(owner.nativeRef.driverId, "plan.select");
      }
      const key = this.idempotencyKey(
        context.peer,
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsUpdate,
        input.idempotencyKey,
        input.ref.sessionId,
      );
      const claim = await this.store.claimIdempotency(key);
      if (claim.kind === "accepted") return toJsonResult(claim.result);
      if (claim.kind === "pending") {
        throw new AgentBackendError(
          "unavailable",
          "The prior session update is still reconciling",
          {
            retryable: true,
          },
        );
      }
      // Native front doors such as DSH Web can change session state without a
      // transport event. Refresh at the mutation boundary before comparing the
      // client's optimistic revision.
      await this.refreshOwner(owner);
      this.assertExpectedRevision(owner, input.expectedRevision);
      await this.backend.updateSession(owner.nativeRef, input.patch);
      await this.refreshOwner(owner);
      const result = toJsonResult({ revision: this.requiredSnapshot(owner).state.revision });
      await this.store.completeIdempotency(key, result as AgentJsonValue);
      return result;
    });
  }

  private async ownerFor(ref: AgentSessionRef): Promise<Owner> {
    this.assertOpen();
    if (ref.backendId !== this.backendId)
      throw new AgentBackendError("not_found", "The requested session is not hosted here");
    const key = agentSessionLocatorKey(ref);
    let owner = this.owners.get(key);
    if (owner === undefined) {
      owner = {
        initializing: Promise.resolve(),
        nativeRef: nativeRef(this.backend.hostId, ref),
        ref,
        subscribers: new Map(),
        tail: Promise.resolve(),
        transientTail: Promise.resolve(),
        presenceSeq: 0,
        transientPending: 0,
        transientSeq: 0,
      };
      this.owners.set(key, owner);
      owner.initializing = this.initializeOwner(owner);
    }
    try {
      await owner.initializing;
      return owner;
    } catch (error) {
      if (this.owners.get(key) === owner) this.owners.delete(key);
      throw error;
    }
  }

  private async initializeOwner(owner: Owner): Promise<void> {
    const native = await this.backend.readSession(owner.nativeRef);
    await this.reconcile(owner, native);
    const runtime = await this.backend.connectRuntime(owner.nativeRef);
    owner.runtime = runtime;
    owner.unsubscribe = runtime.subscribe((event) => {
      const task =
        event.channel === "transient"
          ? this.enqueueTransientEvent(owner, event)
          : this.enqueue(owner, () => this.receiveNativeEvent(owner, event));
      if (task !== undefined) void task.catch((error) => this.report(error));
    });
    await this.enqueue(owner, async () => {
      await this.refreshOwner(owner);
    });
  }

  private async refreshOwner(owner: Owner): Promise<void> {
    await this.reconcile(owner, await this.backend.readSession(owner.nativeRef));
  }

  private async reconcile(owner: Owner, native: RemoteAgentV2SessionSnapshot): Promise<void> {
    if (!isSameAgentSessionRef(native.state.ref, owner.nativeRef)) {
      protocol("The native v2 backend returned another session");
    }
    const current = await this.store.readSessionIndex(owner.ref);
    let entries = current?.entries ?? [];
    if (!sameEntryPrefix(entries, native.entries)) {
      await this.store.bumpHostRevision();
      entries = native.entries.map((entry, position) => ({
        cursor: agentDeliveryCursor(position + 1),
        entryId: entry.id,
      }));
    } else if (entries.length < native.entries.length) {
      const nextCursor = entries.at(-1)?.cursor ?? 0;
      entries = [
        ...entries,
        ...native.entries.slice(entries.length).map((entry, offset) => ({
          cursor: agentDeliveryCursor(nextCursor + offset + 1),
          entryId: entry.id,
        })),
      ];
    }
    const stored =
      current === undefined
        ? await this.store.initializeSession(owner.ref, entries)
        : await this.store.replaceSessionIndex(owner.ref, entries);
    owner.index = stored;
    owner.snapshot = {
      ...(native.overlay === undefined ? {} : { overlay: native.overlay }),
      entries: materializeEntries(stored, native.entries),
      state: { ...toStateWithRef(this.backendId, native.state), ref: owner.ref },
    };
  }

  private async receiveNativeEvent(owner: Owner, event: RemoteAgentV2SessionEvent): Promise<void> {
    if (this.closed) return;
    this.assertNativeEventSession(owner, event);
    const previous = owner.snapshot;
    const previousSummary =
      previous === undefined ? undefined : sessionSummary(owner.ref, previous);
    await this.refreshOwner(owner);
    const current = this.requiredSnapshot(owner);
    const currentSummary = sessionSummary(owner.ref, current);
    if (previousSummary !== undefined && !sameSessionSummary(previousSummary, currentSummary)) {
      await this.broadcastHostEvent({ session: currentSummary, type: "host.session.changed" });
    }
    const previousEntryIds = new Set(previous?.entries.map((candidate) => candidate.id) ?? []);
    const newEntries = current.entries.filter((candidate) => !previousEntryIds.has(candidate.id));
    for (const entry of newEntries) {
      const isTriggeredEntry =
        event.type === "entry.appended" &&
        event.channel === "replayable" &&
        event.entry.id === entry.id;
      await this.deliverLive(
        owner,
        entryEvent(
          owner.ref,
          entry,
          isTriggeredEntry ? event.eventId : `entry:${entry.id}`,
          isTriggeredEntry ? event.occurredAt : entry.createdAt,
          isTriggeredEntry
            ? event.source
            : {
                backendId: owner.ref.backendId,
                driverId: owner.ref.driverId,
                nativeType: "reconciled",
              },
          isTriggeredEntry ? event.settlesEntryId : undefined,
        ),
        [...owner.subscribers.values()],
      );
    }
    if (event.type === "entry.appended" && event.channel === "replayable") {
      return;
    }
    if (event.type === "session.state.changed" && event.channel === "state") {
      const publicEvent: RemoteAgentV2SessionEvent = {
        ...eventBase(owner.ref, event),
        channel: event.channel,
        patch: event.patch,
        revision: event.revision,
        type: event.type,
      };
      await this.deliverLive(owner, publicEvent, [...owner.subscribers.values()]);
      return;
    }
    protocol("A transient native event must use the transient delivery lane");
  }

  private async receiveTransientEvent(
    owner: Owner,
    event: Extract<RemoteAgentV2SessionEvent, { readonly channel: "transient" }>,
    subscribers: readonly RemoteAgentV2Subscriber[],
  ): Promise<void> {
    if (this.closed) return;
    this.assertNativeEventSession(owner, event);
    await this.deliverLive(owner, this.publicTransientEvent(owner, event), subscribers);
  }

  private assertNativeEventSession(owner: Owner, event: RemoteAgentV2SessionEvent): void {
    if (event.sessionId !== owner.nativeRef.sessionId)
      protocol("The native v2 event belongs to another session");
  }

  private enqueueTransientEvent(
    owner: Owner,
    event: Extract<RemoteAgentV2SessionEvent, { readonly channel: "transient" }>,
  ): Promise<void> | undefined {
    try {
      this.assertNativeEventSession(owner, event);
    } catch (error) {
      this.report(error);
      return undefined;
    }
    const subscribers = [...owner.subscribers.values()];
    if (subscribers.length === 0) return undefined;
    // G4 permits dropping transient frames; never allocate another queued
    // operation once the in-flight plus pending delivery window is full.
    if (owner.transientPending >= MAX_PENDING_TRANSIENT_DELIVERIES) return undefined;
    owner.transientPending += 1;
    return this.enqueueTransient(owner, async () => {
      try {
        await this.receiveTransientEvent(owner, event, subscribers);
      } finally {
        owner.transientPending -= 1;
      }
    });
  }

  private publicTransientEvent(
    owner: Owner,
    event: Extract<RemoteAgentV2SessionEvent, { readonly channel: "transient" }>,
  ): RemoteAgentV2SessionEvent {
    return {
      ...eventBase(owner.ref, event),
      ...(event.type === "entry.delta"
        ? {
            blockIndex: event.blockIndex,
            chunkSeq: event.chunkSeq,
            delta: event.delta,
            entryId: event.entryId,
            part: event.part,
          }
        : event.type === "tool.state.changed"
          ? { tool: event.tool }
          : event.type === "run.activity"
            ? { detail: event.detail, kind: event.kind, runId: event.runId }
            : { devices: event.devices }),
      channel: "transient",
      type: event.type,
    } as RemoteAgentV2SessionEvent;
  }

  private async deliverLive(
    owner: Owner,
    event: RemoteAgentV2SessionEvent,
    subscribers: readonly RemoteAgentV2Subscriber[],
  ): Promise<void> {
    const frame = transportEvent(owner.ref, event, ++owner.transientSeq);
    let removedPeer = false;
    await Promise.all(
      subscribers.map(async (subscriber) => {
        if (
          owner.subscribers.get(subscriber.peer.id)?.peer.transportId !==
          subscriber.peer.transportId
        )
          return;
        try {
          await this.transport.send(subscriber.peer, frame);
        } catch (error) {
          removedPeer = this.handleLiveSendFailure(owner, subscriber.peer, error) || removedPeer;
        }
      }),
    );
    if (removedPeer && this.capabilities.presence) await this.broadcastPresence(owner);
  }

  /**
   * Classifies a live-frame send failure and applies its side effect.
   * Returns whether the peer was removed.
   *
   * `OrbisSecureChannel.seal` rejects an oversized plaintext with a
   * `frame_too_large` transport error before its encrypted sequence
   * advances, which makes this a property of the EVENT, not of the peer:
   * every subscriber whose frame ceiling is exceeded fails identically.
   * Removing the peer for it would silently end its live subscription with
   * no signal -- the client keeps its socket, keeps its cursor, and simply
   * stops receiving updates for the session. Skip the frame for this
   * subscriber instead and surface it as a diagnostic:
   *  - A transient frame may be dropped outright: protocol goal G4 says
   *    transient content carries no unique information and must be
   *    reconstructible from the durable log, so the client's own chunkSeq
   *    continuity check marks the affected entry blocked until the next
   *    snapshot or durable settlement repairs it.
   *  - A durable frame that is skipped leaves a gap in the client's
   *    delivery cursor, but the client already detects cursor gaps and
   *    repairs them by re-syncing. `transportEvent` sets `eventSeq` to
   *    `event.cursor` for durable events and to the running `transientSeq`
   *    counter for transient ones, so skipping a transient frame only opens
   *    a gap in a counter the client never validates for contiguity --
   *    `v2-connection.ts`'s `receiveEvent` checks `eventSeq === cursor` only
   *    when the parsed event is on the replayable (durable) channel.
   *
   * Any other failure keeps today's behaviour: the peer is removed, since a
   * dead transport/connection produces no signal on either lane and removal
   * is the only way to stop wasting effort on it.
   */
  private handleLiveSendFailure(owner: Owner, peer: RemoteAgentHostPeer, error: unknown): boolean {
    if (
      error instanceof OrbisTransportError &&
      error.code === "invalid_argument" &&
      error.serverCode === "frame_too_large"
    ) {
      this.report(
        new AgentBackendError(
          "invalid_argument",
          "A live event exceeded the transport frame ceiling and was skipped for one subscriber",
          { details: { peerId: peer.id, sessionId: owner.ref.sessionId } },
        ),
      );
      return false;
    }
    return this.removePeer(owner, peer);
  }

  private async broadcastPresence(owner: Owner): Promise<void> {
    if (!this.capabilities.presence) return;

    // A failed send removes a subscriber. Keep publishing the newly reduced
    // snapshot until one complete round succeeds, so a second failure during
    // convergence cannot leave the remaining peers with stale viewers.
    while (owner.subscribers.size > 0) {
      const devices = [...owner.subscribers.values()]
        .map(({ peer, since }) => ({
          deviceId: peer.deviceId,
          ...(peer.deviceName === undefined ? {} : { name: peer.deviceName }),
          since,
          viewing: true as const,
        }))
        .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
      const event: RemoteAgentV2SessionEvent = {
        channel: "transient",
        devices,
        eventId: agentEventId(`presence:${owner.ref.sessionId}:${++owner.presenceSeq}`),
        occurredAt: this.clock(),
        sessionId: owner.ref.sessionId,
        source: {
          backendId: owner.ref.backendId,
          driverId: owner.ref.driverId,
          nativeType: "orbis/presence",
        },
        type: "presence.changed",
      };
      const frame = transportEvent(owner.ref, event, ++owner.transientSeq);
      let removedPeer = false;
      await Promise.all(
        [...owner.subscribers.values()].map(async (subscriber) => {
          try {
            await this.transport.send(subscriber.peer, frame);
          } catch (error) {
            removedPeer = this.handleLiveSendFailure(owner, subscriber.peer, error) || removedPeer;
          }
        }),
      );
      if (!removedPeer) return;
    }
  }

  /**
   * A native catalog hint only says "something moved". Collapse a burst into
   * one trailing listing so an active native run costs a single sweep rather
   * than one per transcript event.
   */
  private scheduleCatalogSweep(): void {
    if (this.closed || this.catalogHandle !== undefined) return;
    this.catalogHandle = this.scheduler.schedule(() => {
      this.catalogHandle = undefined;
      this.catalogTail = this.catalogTail.then(
        () => this.sweepCatalog(),
        () => this.sweepCatalog(),
      );
    }, this.catalogCoalesceMs);
  }

  /**
   * Re-reads the authoritative catalog and announces only the rows that moved.
   * Sessions with an owner already publish `host.session.changed` from their
   * runtime, so the native seam deliberately never hints for those.
   */
  private async sweepCatalog(): Promise<void> {
    if (this.closed || this.helloPeers.size === 0) return;
    let sessions: readonly RemoteAgentV2SessionSummary[];
    try {
      sessions = await this.backend.listSessions({});
    } catch (error) {
      // Freshness is best-effort: a failed sweep leaves clients on their
      // existing list-on-handshake refresh rather than degrading the host.
      this.report(error);
      return;
    }
    if (this.closed) return;
    const current = catalogIndex(sessions.map((session) => publicSummary(this.backendId, session)));
    const baseline = this.catalogBaseline;
    this.catalogBaseline = current;
    // Nobody has listed yet, so there is no shared view to diff against. The
    // next `sessions.list` is what establishes it.
    if (baseline === undefined) return;

    for (const [sessionId, summary] of current) {
      const previous = baseline.get(sessionId);
      if (previous === undefined) {
        await this.broadcastHostEvent({ session: summary, type: "host.session.added" });
      } else if (!sameSessionSummary(previous, summary)) {
        await this.broadcastHostEvent({ session: summary, type: "host.session.changed" });
      }
    }
    for (const sessionId of baseline.keys()) {
      if (current.has(sessionId)) continue;
      await this.broadcastHostEvent({ reason: "gone", sessionId, type: "host.session.removed" });
    }
  }

  private async broadcastHostEvent(event: RemoteAgentV2HostEvent): Promise<void> {
    // Every announced row is one clients now know about. Folding it into the
    // baseline here keeps the create/runtime paths from being re-announced by
    // the next sweep.
    this.rememberAnnouncedCatalogRow(event);
    await Promise.all(
      [...this.helloPeers.values()].map(async (peer) => {
        try {
          await this.transport.send(
            peer,
            hostTransportEvent(this.backendId, event, ++this.hostEventSeq),
          );
        } catch {
          // Host events are connection-level freshness hints. A failed hint
          // must not fail the mutation or revoke the peer's hello state;
          // session sync/list on the next live connection remains authoritative.
        }
      }),
    );
  }

  private rememberAnnouncedCatalogRow(event: RemoteAgentV2HostEvent): void {
    const baseline = this.catalogBaseline;
    if (baseline === undefined) return;
    if (event.type === "host.session.added" || event.type === "host.session.changed") {
      baseline.set(event.session.ref.sessionId, event.session);
      return;
    }
    if (event.type === "host.session.removed") baseline.delete(event.sessionId);
  }

  private requiredSnapshot(owner: Owner): RemoteAgentV2SessionSnapshot {
    if (owner.snapshot === undefined)
      throw new AgentBackendError("unavailable", "The native session snapshot is unavailable", {
        retryable: true,
      });
    return owner.snapshot;
  }

  private requiredRuntime(owner: Owner): RemoteAgentV2Runtime {
    if (owner.runtime === undefined)
      throw new AgentBackendError("unavailable", "The native session runtime is unavailable", {
        retryable: true,
      });
    return owner.runtime;
  }

  private async assertDriverCapability(
    driverId: AgentSessionRef["driverId"],
    capability:
      | "permission.respond"
      | "plan.select"
      | "prompt.references.files"
      | "prompt.references.sessions"
      | "question.respond"
      | "session.subagents.list"
      | "workspace.open",
  ): Promise<void> {
    const driver = (await this.backend.listDrivers()).find(
      (candidate) => candidate.id === driverId,
    );
    if (driver === undefined) throw new AgentBackendError("not_found", "The driver is unavailable");
    if (!hasAgentDriverCapability(driver, capability)) {
      throw new AgentBackendError(
        "unsupported",
        capability === "permission.respond"
          ? "The driver cannot respond to permission requests"
          : capability === "question.respond"
            ? "The driver cannot respond to questions"
            : capability === "plan.select"
              ? "The driver cannot select plan mode"
              : capability === "prompt.references.files"
                ? "The driver cannot complete file references"
                : capability === "prompt.references.sessions"
                  ? "The driver cannot complete session references"
                  : capability === "session.subagents.list"
                    ? "The driver cannot list session subagents"
                    : "The driver cannot open server workspaces",
      );
    }
  }

  private assertExpectedRevision(owner: Owner, expectedRevision: number | undefined): void {
    if (expectedRevision === undefined) return;
    const revision = this.requiredSnapshot(owner).state.revision;
    if (revision !== expectedRevision) {
      throw new AgentBackendError(
        "revision_conflict",
        "The session state revision does not match",
        {
          details: { expectedRevision, actualRevision: revision },
        },
      );
    }
  }

  private idempotencyKey(
    peer: RemoteAgentHostPeer,
    method: string,
    key: string,
    targetId?: string,
  ): string {
    return `${peer.id}\u0000${targetId ?? "host"}\u0000${method}\u0000${key}`;
  }

  private enqueue<TResult>(owner: Owner, operation: () => Promise<TResult>): Promise<TResult> {
    const task = owner.tail.then(operation);
    owner.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private enqueueTransient<TResult>(
    owner: Owner,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    const task = owner.transientTail.then(operation);
    owner.transientTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private removePeer(owner: Owner, peer: RemoteAgentHostPeer): boolean {
    const current = owner.subscribers.get(peer.id);
    if (current?.peer.transportId !== peer.transportId) return false;
    return owner.subscribers.delete(peer.id);
  }

  private handlePeerDisconnected(peer: RemoteAgentHostPeer): void {
    const known = this.helloPeers.get(peer.transportId);
    if (known?.id === peer.id) this.helloPeers.delete(peer.transportId);
    const uploads = this.uploadsByPeer.get(peer.id);
    if (uploads !== undefined) {
      const hasCurrentTransport = [...uploads.values()].some(
        (upload) => upload.transportId !== peer.transportId,
      );
      if (!hasCurrentTransport) this.uploadsByPeer.delete(peer.id);
      else {
        for (const [uploadId, upload] of uploads) {
          if (upload.transportId === peer.transportId) uploads.delete(uploadId);
        }
      }
    }
    for (const [key, cache] of this.attachmentReads) {
      if (cache.peerId === peer.id && cache.transportId === peer.transportId) {
        this.attachmentReads.delete(key);
      }
    }
    for (const owner of this.owners.values()) {
      void this.enqueue(owner, async () => {
        if (!this.removePeer(owner, peer) || !this.capabilities.presence) return;
        await this.broadcastPresence(owner);
      }).catch((error) => this.report(error));
    }
  }

  private assertRequestActive(context: RemoteAgentHostRequestContext): void {
    this.assertOpen();
    if (context.signal.aborted)
      throw new OrbisTransportError("aborted", "The request was cancelled");
  }

  private assertOpen(): void {
    if (this.closed) throw new AgentBackendError("closed", "The remote agent host is closed");
  }

  private report(error: unknown): void {
    if (!(error instanceof AgentBackendError)) return;
    try {
      this.onError?.(error);
    } catch {
      // Diagnostics are passive.
    }
  }
}
