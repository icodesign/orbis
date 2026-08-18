import {
  AgentBackendError,
  agentBackendId,
  agentDeliveryCursor,
  agentDriverId,
  agentEntryId,
  agentEventId,
  agentRunId,
  agentSessionId,
  agentTimestamp,
  createAgentSessionRef,
  createAgentDriverDescriptor,
  isAgentBackendError,
  validateAgentPermissionRequest,
  type AgentBackendErrorCode,
  type AgentDriverDescriptor,
  type AgentJsonValue,
  type AgentModelMetadata,
  type AgentSessionRef,
  type AgentWorkspaceDescriptor,
  type AgentWorkspaceFolderDescriptor,
  type AgentWorkspaceFolderListing,
  type AgentWorkspaceRegisterResult,
} from "@orbisapp/orbis-agent-backend";
import {
  isOrbisTransportError,
  jsonValueSchema,
  type JsonValue,
  type OrbisRemoteConnection,
  type TransportEvent,
} from "@orbisapp/transport";

import { ORBIS_REMOTE_AGENT_V2_EVENT_TYPE, ORBIS_REMOTE_AGENT_V2_METHODS } from "./v2-constants";
import {
  v2ContentBlockSchema,
  v2DriverSchema,
  v2EntrySchema,
  v2HelloInputSchema,
  v2HelloResultSchema,
  v2HostEventSchema,
  v2OverlaySchema,
  v2ModelSchema,
  v2ModelMetadataSchema,
  v2WorkspaceSchema,
  v2WorkspaceFolderSchema,
  v2RefSchema,
  v2SessionEventSchema,
  v2SessionSummarySchema,
  v2StatePatchSchema,
  v2StateSchema,
  v2SyncResultSchema,
} from "./v2-schemas";
import type {
  RemoteAgentV2CancelInput,
  RemoteAgentV2ContentBlock,
  RemoteAgentV2CreateInput,
  RemoteAgentV2Delivery,
  RemoteAgentV2DeviceDescriptor,
  RemoteAgentV2Entry,
  RemoteAgentV2Hello,
  RemoteAgentV2JsonValue,
  RemoteAgentV2Limits,
  RemoteAgentV2ModelSelection,
  RemoteAgentV2Overlay,
  RemoteAgentV2PermissionRequest,
  RemoteAgentV2PromptInput,
  RemoteAgentV2PromptReceipt,
  RemoteAgentV2RunSummary,
  RemoteAgentV2SessionEvent,
  RemoteAgentV2SessionRecord,
  RemoteAgentV2SessionState,
  RemoteAgentV2SessionStatePatch,
  RemoteAgentV2SessionSummary,
  RemoteAgentV2UpdateInput,
  RemoteAgentV2WorkspaceBrowseInput,
  RemoteAgentV2WorkspaceCreateFolderInput,
  RemoteAgentV2WorkspaceRegisterInput,
  RemoteAgentV2Usage,
} from "./v2-types";

export type RemoteAgentV2SyncMode = "once" | "live";

export type RemoteAgentV2SyncResult =
  | {
      readonly kind: "replay";
      readonly throughCursor: number;
      readonly hasMore: boolean;
      readonly hostRevision: string;
      readonly state: RemoteAgentV2SessionState;
      readonly overlay?: RemoteAgentV2Overlay;
    }
  | {
      readonly kind: "snapshot";
      readonly hostRevision: string;
      readonly state: RemoteAgentV2SessionState;
      readonly entries: readonly RemoteAgentV2Entry[];
      readonly oldestCursor: number;
      readonly hasOlder: boolean;
      readonly overlay?: RemoteAgentV2Overlay;
    };

export interface RemoteAgentV2Connection {
  browseWorkspaces(input: RemoteAgentV2WorkspaceBrowseInput): Promise<AgentWorkspaceFolderListing>;
  createWorkspaceFolder(
    input: RemoteAgentV2WorkspaceCreateFolderInput,
  ): Promise<AgentWorkspaceFolderDescriptor>;
  cancel(input: RemoteAgentV2CancelInput): Promise<{ readonly cancelled: boolean }>;
  close(): void;
  createSession(input: RemoteAgentV2CreateInput): Promise<RemoteAgentV2SessionRecord>;
  entries(input: {
    readonly ref: AgentSessionRef;
    readonly beforeCursor: number;
    readonly limit?: number;
  }): Promise<{ readonly entries: readonly RemoteAgentV2Entry[]; readonly hasOlder: boolean }>;
  hello(input: {
    readonly supportedVersions: readonly number[];
    readonly device: RemoteAgentV2DeviceDescriptor;
  }): Promise<RemoteAgentV2Hello>;
  listDrivers(): Promise<readonly AgentDriverDescriptor[]>;
  listModels(input?: { readonly driverId?: AgentSessionRef["driverId"] }): Promise<{
    readonly models: readonly AgentModelMetadata[];
    readonly revision: string;
  }>;
  listWorkspaces(input: {
    readonly driverId: AgentSessionRef["driverId"];
  }): Promise<readonly AgentWorkspaceDescriptor[]>;
  registerWorkspace(
    input: RemoteAgentV2WorkspaceRegisterInput,
  ): Promise<AgentWorkspaceRegisterResult>;
  listSessions(input?: {
    readonly driverId?: AgentSessionRef["driverId"];
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<{
    readonly sessions: readonly RemoteAgentV2SessionSummary[];
    readonly nextCursor?: string;
  }>;
  onClose(listener: () => void): () => void;
  onEvent(listener: (delivery: RemoteAgentV2Delivery) => void): () => void;
  onProtocolError(listener: (error: AgentBackendError) => void): () => void;
  prompt(input: RemoteAgentV2PromptInput): Promise<RemoteAgentV2PromptReceipt>;
  respondPermission(input: {
    readonly ref: AgentSessionRef;
    readonly requestId: string;
    readonly optionId: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly accepted: boolean }>;
  sync(input: {
    readonly ref: AgentSessionRef;
    readonly afterCursor?: number;
    /** Null pairs with cursor 0; a nonzero cursor must carry its entry id. */
    readonly afterEntryId?: string | null;
    readonly mode: RemoteAgentV2SyncMode;
    readonly limit?: number;
  }): Promise<RemoteAgentV2SyncResult>;
  update(input: RemoteAgentV2UpdateInput): Promise<{ readonly revision: number }>;
  fork(input: {
    readonly ref: AgentSessionRef;
    readonly fromEntryId?: string;
    readonly title?: string;
    readonly idempotencyKey: string;
  }): Promise<RemoteAgentV2SessionSummary>;
  dispose(input: {
    readonly ref: AgentSessionRef;
    readonly deleteHistory?: boolean;
    readonly idempotencyKey: string;
  }): Promise<{ readonly disposed: boolean }>;
}

class IgnoredRemoteEvent extends Error {}

type JsonRecord = Readonly<Record<string, JsonValue>>;

function protocolError(message: string): never {
  throw new AgentBackendError("protocol", message);
}

function parseSchema<T>(
  schema: { readonly parse: (value: unknown) => T },
  value: unknown,
  label: string,
): T {
  try {
    return schema.parse(value);
  } catch {
    protocolError(`${label} is invalid`);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) protocolError(`${label} must be an object`);
  return value;
}

function has(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function string(value: JsonRecord, key: string, label: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) protocolError(`${label} is invalid`);
  return candidate;
}

function optionalString(value: JsonRecord, key: string, label: string): string | undefined {
  if (!has(value, key)) return undefined;
  const candidate = value[key];
  if (typeof candidate !== "string") protocolError(`${label} is invalid`);
  return candidate;
}

function boolean(value: JsonRecord, key: string, label: string): boolean {
  const candidate = value[key];
  if (typeof candidate !== "boolean") protocolError(`${label} is invalid`);
  return candidate;
}

function integer(value: JsonRecord, key: string, label: string, minimum = 0): number {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < minimum) {
    protocolError(`${label} is invalid`);
  }
  return candidate;
}

function array(value: JsonRecord, key: string, label: string): readonly JsonValue[] {
  const candidate = value[key];
  if (!Array.isArray(candidate)) protocolError(`${label} is invalid`);
  return candidate;
}

function json(value: unknown): AgentJsonValue {
  return value as AgentJsonValue;
}

function parseRef(value: unknown): AgentSessionRef {
  const input = parseSchema(v2RefSchema, value, "Session ref");
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

function parseUsage(value: unknown): RemoteAgentV2Usage {
  const input = record(value, "Usage");
  const optional = (key: string): number | undefined =>
    has(input, key) ? integer(input, key, `Usage ${key}`) : undefined;
  return {
    inputTokens: integer(input, "inputTokens", "Input tokens"),
    outputTokens: integer(input, "outputTokens", "Output tokens"),
    ...(optional("cacheReadTokens") === undefined
      ? {}
      : { cacheReadTokens: optional("cacheReadTokens") }),
    ...(optional("cacheWriteTokens") === undefined
      ? {}
      : { cacheWriteTokens: optional("cacheWriteTokens") }),
    ...(optional("costUsd") === undefined ? {} : { costUsd: optional("costUsd") }),
  };
}

function parseEntry(value: unknown): RemoteAgentV2Entry {
  const input = parseSchema(v2EntrySchema, value, "Entry");
  const base = {
    id: agentEntryId(input.id),
    parentId: input.parentId === null ? null : agentEntryId(input.parentId),
    cursor: agentDeliveryCursor(input.cursor),
    createdAt: agentTimestamp(input.createdAt),
    ...(input._meta === undefined ? {} : { _meta: json(input._meta) }),
  };
  switch (input.kind) {
    case "message": {
      return {
        ...base,
        kind: "message",
        role: input.role,
        content: input.content.map(parseContent),
        ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason }),
        ...(input.model === undefined ? {} : { model: parseModel(input.model) }),
        ...(input.usage === undefined ? {} : { usage: parseUsage(input.usage) }),
        ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
      };
    }
    case "tool": {
      return {
        ...base,
        kind: "tool",
        callId: input.callId,
        name: input.name,
        status: input.status,
        ...(input.input === undefined ? {} : { input: json(input.input) }),
        ...(input.output === undefined ? {} : { output: json(input.output) }),
        ...(input.content === undefined ? {} : { content: input.content.map(parseContent) }),
      };
    }
    case "notice": {
      return {
        ...base,
        kind: "notice",
        code: input.code,
        message: input.message,
        level: input.level,
      };
    }
    case "context": {
      return {
        ...base,
        kind: "context",
        origin: input.origin,
        ...(input.label === undefined ? {} : { label: input.label }),
        content: input.content.map(parseContent),
      };
    }
  }
}

function parseRun(value: unknown): RemoteAgentV2RunSummary {
  const input = record(value, "Run summary");
  const outcome = optionalString(input, "outcome", "Run outcome");
  if (
    outcome !== undefined &&
    outcome !== "completed" &&
    outcome !== "cancelled" &&
    outcome !== "failed"
  )
    protocolError("Run outcome is invalid");
  const error = input.error;
  return {
    runId: agentRunId(string(input, "runId", "Run id")),
    startedAt: agentTimestamp(string(input, "startedAt", "Run start")),
    ...(input.finishedAt === undefined
      ? {}
      : { finishedAt: agentTimestamp(string(input, "finishedAt", "Run finish")) }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(error === undefined ? {} : { error: parseError(error) }),
  };
}

function parseError(value: unknown): { readonly code: string; readonly message: string } {
  const input = record(value, "Error");
  return {
    code: string(input, "code", "Error code"),
    message: string(input, "message", "Error message"),
  };
}

function parseState(value: unknown): RemoteAgentV2SessionState {
  const input = parseSchema(v2StateSchema, value, "Session state");
  return {
    ref: parseRef(input.ref),
    title: input.title,
    model: input.model === null ? null : parseModel(input.model),
    mode: input.mode,
    configOptions: input.configOptions,
    workspaceRef: input.workspaceRef,
    cwd: input.cwd,
    leafEntryId: input.leafEntryId === null ? null : agentEntryId(input.leafEntryId),
    runState: input.runState,
    ...(input.activeRun === undefined || input.activeRun === null
      ? {}
      : { activeRun: parseRun(input.activeRun) }),
    ...(input.lastRun === undefined || input.lastRun === null
      ? {}
      : { lastRun: parseRun(input.lastRun) }),
    pendingInputs: input.pendingInputs.map(parseQueuedInput),
    pendingPermissions: input.pendingPermissions.map(parsePermission),
    ...(input.usageTotal === undefined || input.usageTotal === null
      ? {}
      : { usageTotal: parseUsage(input.usageTotal) }),
    createdAt: agentTimestamp(input.createdAt),
    updatedAt: agentTimestamp(input.updatedAt),
    revision: input.revision,
  };
}

function parseQueuedInput(value: unknown): RemoteAgentV2SessionState["pendingInputs"][number] {
  const input = record(value, "Queued input");
  const kind = string(input, "kind", "Queued input kind");
  if (kind !== "steer" && kind !== "follow_up" && kind !== "next_run")
    protocolError("Queued input kind is invalid");
  return {
    id: string(input, "id", "Queued input id"),
    kind,
    content: array(input, "content", "Queued input content").map(parseContent),
    queuedAt: agentTimestamp(string(input, "queuedAt", "Queued input time")),
  };
}

function parsePermission(value: unknown): RemoteAgentV2PermissionRequest {
  try {
    return validateAgentPermissionRequest(value);
  } catch {
    protocolError("Permission request is invalid");
  }
}

function parseSummary(value: unknown): RemoteAgentV2SessionSummary {
  const input = parseSchema(v2SessionSummarySchema, value, "Session summary");
  return {
    ref: parseRef(input.ref),
    driverId: agentDriverId(input.driverId),
    title: input.title,
    runState: input.runState,
    updatedAt: agentTimestamp(input.updatedAt),
  };
}

function parseOverlay(value: unknown): RemoteAgentV2Overlay {
  const input = parseSchema(v2OverlaySchema, value, "Overlay");
  return {
    runId: agentRunId(input.runId),
    ...(input.streaming === undefined ? {} : { streaming: parseStreaming(input.streaming) }),
    runningTools: input.runningTools.map(parseRunningTool),
  };
}

function parseStreaming(value: unknown): NonNullable<RemoteAgentV2Overlay["streaming"]> {
  const input = parseSchema(v2OverlaySchema.shape.streaming.unwrap(), value, "Streaming overlay");
  return {
    entryId: agentEntryId(input.entryId),
    blocks: input.blocks.map((block) => ({
      blockIndex: block.blockIndex,
      content: parseStreamingContent(block.content),
    })),
    chunkSeq: input.chunkSeq,
  };
}

function parseStreamingContent(
  value: unknown,
): NonNullable<RemoteAgentV2Overlay["streaming"]>["blocks"][number]["content"] {
  const content = parseContent(value);
  if (content.type === "text" || content.type === "thinking") return content;
  throw new AgentBackendError("protocol", "Streaming overlay content must be text or thinking");
}

function parseRunningTool(value: unknown): RemoteAgentV2Overlay["runningTools"][number] {
  const input = parseSchema(v2OverlaySchema.shape.runningTools.element, value, "Running tool");
  return {
    entryId: agentEntryId(input.entryId),
    callId: input.callId,
    name: input.name,
    status: input.status,
    ...(input.input === undefined ? {} : { input: json(input.input) }),
    ...(input.content === undefined ? {} : { content: input.content.map(parseContent) }),
    chunkSeq: input.chunkSeq,
  };
}

function parseDriver(value: unknown): AgentDriverDescriptor {
  const input = parseSchema(v2DriverSchema, value, "Driver descriptor");
  return createAgentDriverDescriptor({
    id: input.id,
    displayName: input.displayName,
    capabilities: input.capabilities as never,
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.availability === undefined
      ? {}
      : {
          availability: {
            available: input.availability.available,
            ...(input.availability.reason === undefined
              ? {}
              : { reason: input.availability.reason }),
          },
        }),
  });
}

function stringValue(value: JsonValue, label: string): string {
  if (typeof value !== "string" || value.length === 0) protocolError(`${label} is invalid`);
  return value;
}

function parseHello(value: unknown): RemoteAgentV2Hello {
  const input = parseSchema(v2HelloResultSchema, value, "Hello result");
  return {
    version: 2,
    hostId: agentBackendId(input.hostId),
    hostRevision: input.hostRevision,
    capabilities: {
      presence: input.capabilities.presence,
      attachments:
        input.capabilities.attachments === false
          ? false
          : parseAttachments(input.capabilities.attachments),
      fork: input.capabilities.fork,
      dispose: input.capabilities.dispose,
    },
    drivers: input.drivers.map(parseDriver),
    limits: parseLimits(input.limits),
  };
}

function parseAttachments(
  value: unknown,
): NonNullable<RemoteAgentV2Hello["capabilities"]["attachments"]> {
  const input = record(value, "Attachment capability");
  return {
    maxBytes: integer(input, "maxBytes", "Attachment max bytes", 1),
    mimeTypes: array(input, "mimeTypes", "Attachment MIME types").map((item) =>
      stringValue(item, "Attachment MIME type"),
    ),
  };
}

function parseLimits(value: unknown): RemoteAgentV2Limits {
  const input = record(value, "Host limits");
  return {
    maxReplayBatch: integer(input, "maxReplayBatch", "Replay batch limit", 1),
    maxSnapshotWindow: integer(input, "maxSnapshotWindow", "Snapshot window limit", 1),
    maxPromptBytes: integer(input, "maxPromptBytes", "Prompt byte limit", 1),
  };
}

function parseEvent(value: unknown): RemoteAgentV2SessionEvent | RemoteAgentV2Delivery["event"] {
  const input = record(value, "Orbis event");
  const type = string(input, "type", "Event type");
  if (
    (input.channel === "state" && type !== "session.state.changed") ||
    (input.channel === "transient" &&
      type !== "entry.delta" &&
      type !== "tool.state.changed" &&
      type !== "run.activity" &&
      type !== "presence.changed")
  ) {
    throw new IgnoredRemoteEvent();
  }
  if (type.startsWith("host.")) {
    return parseHostEvent(parseSchema(v2HostEventSchema, input, "Host event"));
  }
  const parsed = parseSchema(v2SessionEventSchema, input, "Orbis event");
  const base = {
    eventId: agentEventId(parsed.eventId),
    occurredAt: agentTimestamp(parsed.occurredAt),
    sessionId: agentSessionId(parsed.sessionId),
    source: parseSource(parsed.source),
  };
  if (parsed.type === "entry.appended") {
    return {
      ...base,
      channel: parsed.channel,
      type: parsed.type,
      cursor: agentDeliveryCursor(parsed.cursor),
      entry: parseEntry(parsed.entry),
      ...(parsed.settlesEntryId === undefined
        ? {}
        : { settlesEntryId: agentEntryId(parsed.settlesEntryId) }),
    };
  }
  if (parsed.type === "session.state.changed") {
    return {
      ...base,
      channel: parsed.channel,
      type: parsed.type,
      revision: parsed.revision,
      patch: parsePatch(parsed.patch),
    };
  }
  if (parsed.type === "entry.delta") {
    return {
      ...base,
      channel: parsed.channel,
      type: parsed.type,
      entryId: agentEntryId(parsed.entryId),
      part: parsed.part,
      blockIndex: parsed.blockIndex,
      chunkSeq: parsed.chunkSeq,
      delta: parsed.delta,
    };
  }
  if (parsed.type === "tool.state.changed") {
    return {
      ...base,
      channel: parsed.channel,
      tool: {
        callId: parsed.tool.callId,
        ...(parsed.tool.content === undefined
          ? {}
          : { content: parsed.tool.content.map(parseContent) }),
        entryId: agentEntryId(parsed.tool.entryId),
        ...(parsed.tool.input === undefined ? {} : { input: json(parsed.tool.input) }),
        name: parsed.tool.name,
        status: parsed.tool.status,
      },
      type: parsed.type,
    };
  }
  if (parsed.type === "run.activity") {
    return {
      ...base,
      channel: parsed.channel,
      type: parsed.type,
      runId: agentRunId(parsed.runId),
      kind: parsed.kind,
      ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
    };
  }
  if (parsed.type === "presence.changed") {
    return {
      ...base,
      channel: parsed.channel,
      type: parsed.type,
      devices: parsed.devices.map(parsePresence),
    };
  }
  throw new IgnoredRemoteEvent();
}

function parseSource(value: unknown) {
  const input = record(value, "Event source");
  return {
    backendId: agentBackendId(string(input, "backendId", "Source backend id")),
    driverId: agentDriverId(string(input, "driverId", "Source driver id")),
    ...(input.nativeType === undefined
      ? {}
      : { nativeType: string(input, "nativeType", "Native event type") }),
    ...(input.version === undefined ? {} : { version: string(input, "version", "Source version") }),
  };
}

function parsePatch(value: unknown): RemoteAgentV2SessionStatePatch {
  const input = parseSchema(v2StatePatchSchema, value, "State patch");
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.model === undefined
      ? {}
      : { model: input.model === null ? null : parseModel(input.model) }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.configOptions === undefined
      ? {}
      : {
          configOptions: input.configOptions,
        }),
    ...(input.workspaceRef === undefined ? {} : { workspaceRef: input.workspaceRef }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.leafEntryId === undefined
      ? {}
      : {
          leafEntryId: input.leafEntryId === null ? null : agentEntryId(input.leafEntryId),
        }),
    ...(input.runState === undefined ? {} : { runState: input.runState }),
    ...(input.activeRun === undefined
      ? {}
      : { activeRun: input.activeRun === null ? null : parseRun(input.activeRun) }),
    ...(input.lastRun === undefined
      ? {}
      : { lastRun: input.lastRun === null ? null : parseRun(input.lastRun) }),
    ...(input.pendingInputs === undefined
      ? {}
      : { pendingInputs: input.pendingInputs.map(parseQueuedInput) }),
    ...(input.pendingPermissions === undefined
      ? {}
      : { pendingPermissions: input.pendingPermissions.map(parsePermission) }),
    ...(input.usageTotal === undefined
      ? {}
      : { usageTotal: input.usageTotal === null ? null : parseUsage(input.usageTotal) }),
    ...(input.updatedAt === undefined ? {} : { updatedAt: agentTimestamp(input.updatedAt) }),
  };
}

function parsePresence(value: unknown) {
  const input = record(value, "Presence device");
  return {
    deviceId: string(input, "deviceId", "Presence device id"),
    ...(input.name === undefined ? {} : { name: string(input, "name", "Presence name") }),
    since: agentTimestamp(string(input, "since", "Presence since")),
    viewing: boolean(input, "viewing", "Presence viewing"),
  };
}

function parseHostEvent(input: unknown): RemoteAgentV2Delivery["event"] {
  const recordInput = record(input, "Host event");
  const type = string(recordInput, "type", "Host event type");
  switch (type) {
    case "host.session.added":
    case "host.session.changed":
      return {
        type,
        session: parseSummary(recordInput.session ?? protocolError("Host session is missing")),
      };
    case "host.session.removed": {
      const reason = string(recordInput, "reason", "Removal reason");
      if (reason !== "disposed" && reason !== "gone") protocolError("Removal reason is invalid");
      return { type, sessionId: string(recordInput, "sessionId", "Removed session id"), reason };
    }
    case "host.drivers.changed":
      return { type, drivers: array(recordInput, "drivers", "Changed drivers").map(parseDriver) };
    case "host.models.changed":
      return { type, revision: string(recordInput, "revision", "Model revision") };
    default:
      throw new IgnoredRemoteEvent();
  }
}

function parseSync(value: unknown): RemoteAgentV2SyncResult {
  const input = parseSchema(v2SyncResultSchema, value, "Sync result");
  if (input.kind === "replay") {
    return {
      kind: input.kind,
      throughCursor: input.throughCursor,
      hasMore: input.hasMore,
      hostRevision: input.hostRevision,
      state: parseState(input.state),
      ...(input.overlay === undefined ? {} : { overlay: parseOverlay(input.overlay) }),
    };
  }
  return {
    kind: input.kind,
    hostRevision: input.hostRevision,
    state: parseState(input.state),
    entries: input.entries.map(parseEntry),
    oldestCursor: input.oldestCursor,
    hasOlder: input.hasOlder,
    ...(input.overlay === undefined ? {} : { overlay: parseOverlay(input.overlay) }),
  };
}

function parseTransportError(error: unknown): AgentBackendError {
  if (isAgentBackendError(error)) return error;
  if (!isOrbisTransportError(error))
    return new AgentBackendError("unavailable", "The remote agent service is unavailable.", {
      retryable: true,
    });
  const mappedCode: AgentBackendErrorCode =
    error.code === "invalid_argument"
      ? "invalid_argument"
      : error.code === "protocol"
        ? "protocol"
        : error.code === "remote_request" && error.serverCode === "protocol"
          ? "protocol"
          : error.code === "remote_request" && error.serverCode === "not_found"
            ? "not_found"
            : error.code === "remote_request" &&
                (error.serverCode === "conflict" || error.serverCode === "revision_conflict")
              ? error.serverCode === "revision_conflict"
                ? "revision_conflict"
                : "conflict"
              : error.code === "remote_request" && error.serverCode === "version_unsupported"
                ? "version_unsupported"
                : error.code === "remote_request" && error.serverCode === "unsupported"
                  ? "unsupported"
                  : error.code === "remote_request" && error.serverCode === "method_not_found"
                    ? "unsupported"
                    : "unavailable";
  return new AgentBackendError(mappedCode, error.message, {
    ...(error.serverCode === undefined ? {} : { details: { serverCode: error.serverCode } }),
    retryable: error.retryable,
  });
}

function refPayload(ref: AgentSessionRef): JsonValue {
  return {
    backendId: ref.backendId,
    driverId: ref.driverId,
    nativeSessionId: ref.nativeSessionId,
    sessionId: ref.sessionId,
  };
}

function toJson(value: unknown): JsonValue {
  return jsonValueSchema.parse(JSON.parse(JSON.stringify(value))) as JsonValue;
}

export class OrbisRemoteAgentV2Connection implements RemoteAgentV2Connection {
  private readonly closeListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(delivery: RemoteAgentV2Delivery) => void>();
  private readonly protocolErrorListeners = new Set<(error: AgentBackendError) => void>();
  private readonly methods: ReadonlySet<string> | undefined;
  private readonly unsubscribeEvent: () => void;
  private readonly unsubscribeClose: () => void;
  private closed = false;
  private helloResult: RemoteAgentV2Hello | undefined;

  constructor(
    private readonly transport: {
      readonly methods?: readonly string[];
      request(
        method: string,
        params: JsonValue,
        options?: { signal?: AbortSignal },
      ): Promise<JsonValue>;
      close(): void;
      onEvent(listener: (event: TransportEvent) => void): () => void;
      onClose(listener: () => void): () => void;
    },
  ) {
    this.methods = transport.methods === undefined ? undefined : new Set(transport.methods);
    this.unsubscribeEvent = transport.onEvent((event) => this.receiveEvent(event));
    this.unsubscribeClose = transport.onClose(() => this.notifyClosed());
  }

  async hello(input: {
    readonly supportedVersions: readonly number[];
    readonly device: RemoteAgentV2DeviceDescriptor;
  }): Promise<RemoteAgentV2Hello> {
    this.assertOpen();
    if (this.helloResult !== undefined)
      throw new AgentBackendError("protocol", "orbis.hello may only be called once");
    const validated = parseSchema(v2HelloInputSchema, input, "Hello input");
    if (!validated.supportedVersions.includes(2))
      throw new AgentBackendError(
        "version_unsupported",
        "The client does not support Orbis protocol v2",
      );
    const result = await this.request(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { supportedVersions: [...validated.supportedVersions], device: validated.device },
      parseHello,
      true,
    );
    this.helloResult = result;
    return result;
  }

  listDrivers(): Promise<readonly AgentDriverDescriptor[]> {
    if (this.helloResult === undefined) {
      return Promise.reject(
        new AgentBackendError("protocol", "orbis.hello must complete before listing drivers"),
      );
    }
    return Promise.resolve(this.helloResult.drivers);
  }

  async listModels(input: { readonly driverId?: AgentSessionRef["driverId"] } = {}) {
    return this.request(
      ORBIS_REMOTE_AGENT_V2_METHODS.modelsList,
      input.driverId === undefined ? {} : { driverId: input.driverId },
      (value) => {
        const output = record(value, "Models result");
        return {
          models: array(output, "models", "Models").map((item) =>
            parseSchema(v2ModelMetadataSchema, item, "Model metadata"),
          ),
          revision: string(output, "revision", "Model revision"),
        };
      },
    );
  }

  async listWorkspaces(input: { readonly driverId: AgentSessionRef["driverId"] }) {
    return this.request(
      ORBIS_REMOTE_AGENT_V2_METHODS.workspacesList,
      { driverId: input.driverId },
      (value) => {
        const output = record(value, "Workspaces result");
        return array(output, "workspaces", "Workspaces").map((item) =>
          parseSchema(v2WorkspaceSchema, item, "Workspace metadata"),
        );
      },
    );
  }

  async browseWorkspaces(input: RemoteAgentV2WorkspaceBrowseInput) {
    return this.request(
      ORBIS_REMOTE_AGENT_V2_METHODS.workspacesBrowse,
      input.folderRef === undefined
        ? { driverId: input.driverId }
        : { driverId: input.driverId, folderRef: input.folderRef },
      (value) => {
        const output = record(value, "Workspace browse result");
        return {
          breadcrumbs: array(output, "breadcrumbs", "Workspace breadcrumbs").map((item) =>
            parseSchema(v2WorkspaceFolderSchema, item, "Workspace folder"),
          ),
          current:
            output.current === null
              ? null
              : parseSchema(v2WorkspaceFolderSchema, output.current, "Current workspace folder"),
          entries: array(output, "entries", "Workspace folders").map((item) =>
            parseSchema(v2WorkspaceFolderSchema, item, "Workspace folder"),
          ),
          truncated: boolean(output, "truncated", "Workspace truncation flag"),
        };
      },
      false,
      input.signal,
    );
  }

  async createWorkspaceFolder(input: RemoteAgentV2WorkspaceCreateFolderInput) {
    return this.request(ORBIS_REMOTE_AGENT_V2_METHODS.workspacesCreateFolder, input, (value) =>
      parseSchema(v2WorkspaceFolderSchema, value, "Created workspace folder"),
    );
  }

  async registerWorkspace(input: RemoteAgentV2WorkspaceRegisterInput) {
    return this.request(ORBIS_REMOTE_AGENT_V2_METHODS.workspacesRegister, input, (value) => {
      const output = record(value, "Workspace registration result");
      return {
        created: boolean(output, "created", "Workspace created flag"),
        workspace: parseSchema(v2WorkspaceSchema, output.workspace, "Workspace metadata"),
      };
    });
  }

  async listSessions(
    input: {
      readonly driverId?: AgentSessionRef["driverId"];
      readonly limit?: number;
      readonly cursor?: string;
    } = {},
  ) {
    return this.request(ORBIS_REMOTE_AGENT_V2_METHODS.sessionsList, input, (value) => {
      const output = record(value, "Session list result");
      return {
        sessions: array(output, "sessions", "Sessions").map(parseSummary),
        ...(output.nextCursor === undefined
          ? {}
          : { nextCursor: string(output, "nextCursor", "Next cursor") }),
      };
    });
  }

  async createSession(input: RemoteAgentV2CreateInput) {
    return this.request(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsCreate,
      input as unknown as JsonValue,
      (value) => {
        const output = record(value, "Created session");
        return {
          ...parseSummary(output),
          createdAt: agentTimestamp(string(output, "createdAt", "Created session time")),
        };
      },
    );
  }

  async sync(input: {
    readonly ref: AgentSessionRef;
    readonly afterCursor?: number;
    readonly afterEntryId?: string | null;
    readonly mode: RemoteAgentV2SyncMode;
    readonly limit?: number;
  }) {
    if ((input.afterCursor === undefined) !== (input.afterEntryId === undefined))
      throw new AgentBackendError(
        "invalid_argument",
        "afterCursor and afterEntryId must be supplied together",
      );
    if (input.afterCursor !== undefined) {
      if (!Number.isSafeInteger(input.afterCursor) || input.afterCursor < 0) {
        throw new AgentBackendError("invalid_argument", "afterCursor is invalid");
      }
      if (input.afterCursor === 0 && input.afterEntryId !== null) {
        throw new AgentBackendError(
          "invalid_argument",
          "afterEntryId must be null when afterCursor is zero",
        );
      }
      if (
        input.afterCursor > 0 &&
        (typeof input.afterEntryId !== "string" || input.afterEntryId.length === 0)
      ) {
        throw new AgentBackendError(
          "invalid_argument",
          "afterEntryId is required for a nonzero afterCursor",
        );
      }
    }
    return this.request(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      { ...input, ref: refPayload(input.ref) },
      parseSync,
    );
  }

  entries(input: {
    readonly ref: AgentSessionRef;
    readonly beforeCursor: number;
    readonly limit?: number;
  }) {
    return this.request(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsEntries,
      { ...input, ref: refPayload(input.ref) },
      (value) => {
        const output = record(value, "Entries result");
        return {
          entries: array(output, "entries", "Entries").map(parseEntry),
          hasOlder: boolean(output, "hasOlder", "Older history flag"),
        };
      },
    );
  }

  prompt(input: RemoteAgentV2PromptInput): Promise<RemoteAgentV2PromptReceipt> {
    return this.request<RemoteAgentV2PromptReceipt>(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt,
      { ...input, ref: refPayload(input.ref) },
      (value) => {
        const output = record(value, "Prompt result");
        return {
          runId: agentRunId(string(output, "runId", "Run id")),
          acceptedAt: agentTimestamp(string(output, "acceptedAt", "Accepted time")),
          queued: boolean(output, "queued", "Queued flag"),
        };
      },
    );
  }

  cancel(input: RemoteAgentV2CancelInput) {
    return this.request(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsCancel,
      { ...input, ref: refPayload(input.ref) },
      (value) => {
        const output = record(value, "Cancel result");
        return { cancelled: boolean(output, "cancelled", "Cancelled flag") };
      },
    );
  }

  update(input: RemoteAgentV2UpdateInput): Promise<{ readonly revision: number }> {
    return this.request<{ readonly revision: number }>(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsUpdate,
      { ...input, ref: refPayload(input.ref) },
      (value) => ({ revision: integer(record(value, "Update result"), "revision", "Revision") }),
    );
  }

  respondPermission(input: {
    readonly ref: AgentSessionRef;
    readonly requestId: string;
    readonly optionId: string;
    readonly idempotencyKey: string;
  }) {
    return this.request(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsRespondPermission,
      { ...input, ref: refPayload(input.ref) },
      (value) => {
        const output = record(value, "Permission result");
        return { accepted: boolean(output, "accepted", "Permission accepted") };
      },
    );
  }

  fork(input: {
    readonly ref: AgentSessionRef;
    readonly fromEntryId?: string;
    readonly title?: string;
    readonly idempotencyKey: string;
  }) {
    return this.request(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsFork,
      { ...input, ref: refPayload(input.ref) },
      parseSummary,
    );
  }

  dispose(input: {
    readonly ref: AgentSessionRef;
    readonly deleteHistory?: boolean;
    readonly idempotencyKey: string;
  }) {
    return this.request(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsDispose,
      { ...input, ref: refPayload(input.ref) },
      (value) => ({
        disposed: boolean(record(value, "Dispose result"), "disposed", "Disposed flag"),
      }),
    );
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  onEvent(listener: (delivery: RemoteAgentV2Delivery) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onProtocolError(listener: (error: AgentBackendError) => void): () => void {
    this.protocolErrorListeners.add(listener);
    return () => this.protocolErrorListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.notifyClosed();
    this.transport.close();
  }

  private async request<TResult>(
    method: string,
    params: unknown,
    parse: (value: JsonValue) => TResult,
    allowBeforeHello = false,
    signal?: AbortSignal,
  ): Promise<TResult> {
    this.assertOpen();
    if (!allowBeforeHello && this.helloResult === undefined)
      throw new AgentBackendError(
        "protocol",
        "orbis.hello must complete before other agent methods",
      );
    if (this.methods !== undefined && !this.methods.has(method))
      throw new AgentBackendError(
        "unsupported",
        "The remote host does not advertise this v2 method",
      );
    try {
      return parse(await this.transport.request(method, toJson(params), { signal }));
    } catch (error) {
      throw parseTransportError(error);
    }
  }

  private receiveEvent(event: TransportEvent): void {
    if (this.closed || event.type !== ORBIS_REMOTE_AGENT_V2_EVENT_TYPE) return;
    try {
      if (this.helloResult === undefined)
        protocolError("orbis.hello must complete before receiving agent events");
      const envelope = record(event.payload, "Orbis event envelope");
      if (integer(envelope, "protocolVersion", "Event protocol version") !== 2)
        protocolError("Event protocol version is invalid");
      const scopeValue = record(
        envelope.scope ?? protocolError("Event scope is missing"),
        "Event scope",
      );
      const kind = string(scopeValue, "kind", "Event scope kind");
      const scope =
        kind === "host"
          ? { kind: "host" as const }
          : {
              kind: "session" as const,
              ref: parseRef(scopeValue.ref ?? protocolError("Session event ref is missing")),
            };
      const parsed = parseEvent(envelope.event ?? protocolError("Event payload is missing"));
      if ("channel" in parsed) {
        if (scope.kind !== "session") protocolError("Session event has a host scope");
        if (
          parsed.sessionId !== scope.ref.sessionId ||
          parsed.source.backendId !== scope.ref.backendId ||
          parsed.source.driverId !== scope.ref.driverId
        ) {
          protocolError("Event session identity does not match envelope scope");
        }
      } else if (scope.kind !== "host") {
        protocolError("Host event has a session scope");
      }
      if ("sessionId" in parsed && parsed.sessionId !== event.sessionId)
        protocolError("Event session identity does not match transport");
      if (
        "channel" in parsed &&
        parsed.channel === "replayable" &&
        event.eventSeq !== parsed.cursor
      )
        protocolError("Replayable event cursor does not match transport sequence");
      const delivery: RemoteAgentV2Delivery = {
        event: parsed,
        scope,
        ...(scope.kind === "session" ? { ref: scope.ref } : {}),
        transportEvent: event,
      };
      for (const listener of this.eventListeners) {
        try {
          listener(delivery);
        } catch {
          /* observers are passive */
        }
      }
    } catch (error) {
      if (error instanceof IgnoredRemoteEvent) return;
      const mapped = parseTransportError(error);
      for (const listener of this.protocolErrorListeners) {
        try {
          listener(mapped);
        } catch {
          /* diagnostics are passive */
        }
      }
    }
  }

  private notifyClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeEvent();
    this.unsubscribeClose();
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch {
        /* passive */
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new AgentBackendError("closed", "The remote agent connection is closed");
  }
}

export function createOrbisRemoteAgentV2Connection(
  connection: OrbisRemoteConnection,
): OrbisRemoteAgentV2Connection {
  return new OrbisRemoteAgentV2Connection({
    methods: connection.welcome.capabilities.methods,
    request: (method, params, options) =>
      connection.request(method, params, jsonValueSchema, options),
    close: () => connection.close(),
    onEvent: (listener) => connection.onEvent(listener),
    onClose: (listener) => connection.onClose(() => listener()),
  });
}
