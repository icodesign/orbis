import type {
  AgentBackendId,
  AgentDeliveryCursor,
  AgentDriverId,
  AgentEntryId,
  AgentEventId,
  AgentRunId,
  AgentSessionId,
  AgentTimestamp,
} from "./identifiers";

export type AgentJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AgentJsonValue[]
  | { readonly [key: string]: AgentJsonValue };

export interface AgentModelSelection {
  readonly modelId: string;
  readonly provider: string;
  readonly thinkingLevel?: string;
}

export interface AgentSessionMetadata {
  readonly createdAt: AgentTimestamp;
  readonly model?: AgentModelSelection | null;
  readonly title?: string | null;
  readonly updatedAt: AgentTimestamp;
}

export interface AgentSessionMetadataPatch {
  readonly model?: AgentModelSelection | null;
  readonly title?: string | null;
}

export type AgentMessageRole = "assistant" | "system" | "user";

export type AgentContentBlock =
  | { readonly text: string; readonly type: "text" }
  | { readonly data: string; readonly mimeType: string; readonly type: "image" }
  | { readonly redacted?: boolean; readonly text: string; readonly type: "thinking" }
  | {
      readonly callId: string;
      readonly input?: AgentJsonValue;
      readonly name: string;
      readonly type: "tool_call";
    }
  | { readonly name: string; readonly type: "resource"; readonly uri: string };

interface AgentSessionEntryBase {
  readonly createdAt: AgentTimestamp;
  /** Parent in the driver's durable entry tree; host adapters may materialize it. */
  readonly id: AgentEntryId;
  readonly parentId: AgentEntryId | null;
  /** Host cursor, or zero before a remote host materializes the entry. */
  readonly cursor: AgentDeliveryCursor;
  readonly _meta?: AgentJsonValue;
}

export interface AgentMessageEntry extends AgentSessionEntryBase {
  readonly content: readonly AgentContentBlock[];
  readonly errorMessage?: string;
  readonly kind: "message";
  readonly model?: AgentModelSelection;
  readonly role: AgentMessageRole;
  readonly stopReason?: "aborted" | "error" | "length" | "stop" | "tool_use";
  readonly usage?: AgentUsage;
}

export interface AgentToolEntry extends AgentSessionEntryBase {
  readonly callId: string;
  readonly content?: readonly AgentContentBlock[];
  readonly input?: AgentJsonValue;
  readonly kind: "tool";
  readonly name: string;
  readonly output?: AgentJsonValue;
  readonly status: "cancelled" | "error" | "success";
}

export interface AgentNoticeEntry extends AgentSessionEntryBase {
  readonly code: string;
  readonly kind: "notice";
  readonly level: "error" | "info" | "warn";
  readonly message: string;
}

/**
 * Which role a producer-supplied context plays on the model surface. `recall` is
 * material lifted out of another session's transcript; `inject` is everything a
 * producer contributed to this one.
 */
export type AgentContextOrigin = "inject" | "recall";

/**
 * Content a producer put in front of the model that no human typed: workspace
 * instruction files, runtime snapshots, skill catalogs, recalled sessions.
 *
 * It is a timeline entry rather than a `system`-role message because a reader
 * needs to know who produced it before deciding to read it, and because it is
 * addressed to the model rather than to them. `label` carries that producer
 * name; it is absent only when the driver's own record names none.
 */
export interface AgentContextEntry extends AgentSessionEntryBase {
  readonly content: readonly AgentContentBlock[];
  readonly kind: "context";
  readonly label?: string;
  readonly origin: AgentContextOrigin;
}

/** Product-facing durable timeline entries. Harness-native payloads are not valid entries. */
export type AgentSessionEntry =
  | AgentContextEntry
  | AgentMessageEntry
  | AgentNoticeEntry
  | AgentToolEntry;

export interface AgentUsage {
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AgentQueuedInput {
  readonly content: readonly AgentContentBlock[];
  readonly id: string;
  readonly kind: "follow_up" | "next_run" | "steer";
  readonly queuedAt: AgentTimestamp;
}

export interface AgentPermissionRequest {
  readonly callId?: string;
  readonly defaultOptionId: string;
  readonly detail?: string;
  readonly expiresAt: AgentTimestamp;
  readonly options: readonly {
    readonly kind: "allow_always" | "allow_once" | "reject_always" | "reject_once";
    readonly label: string;
    readonly optionId: string;
  }[];
  readonly requestedAt: AgentTimestamp;
  readonly requestId: string;
  readonly title: string;
}

export interface AgentPublicError {
  readonly code: string;
  readonly message: string;
}

export type AgentRunOutcome = "cancelled" | "completed" | "failed";

export interface AgentEventSource {
  readonly backendId: AgentBackendId;
  readonly driverId: AgentDriverId;
  readonly nativeType?: string;
  readonly version?: string;
}

interface AgentSessionEventBase {
  readonly eventId: AgentEventId;
  readonly occurredAt: AgentTimestamp;
  readonly sessionId: AgentSessionId;
  readonly source: AgentEventSource;
}

interface AgentDurableEventBase extends AgentSessionEventBase {
  readonly cursor: AgentDeliveryCursor;
  readonly durability: "durable";
}

interface AgentTransientEventBase extends AgentSessionEventBase {
  readonly cursor?: never;
  readonly durability: "transient";
}

export interface AgentEntryAppendedEvent extends AgentDurableEventBase {
  readonly payload: { readonly entry: AgentSessionEntry };
  readonly type: "entry.appended";
}

export type AgentSessionRunState = "error" | "idle" | "running" | "suspended";

export interface AgentSessionStatePatch {
  readonly activeRun?: {
    readonly id: AgentRunId;
    readonly startedAt: AgentTimestamp;
  } | null;
  readonly configOptions?: Readonly<Record<string, AgentJsonValue>>;
  readonly cwd?: string | null;
  readonly lastRun?: {
    readonly error?: AgentPublicError;
    readonly finishedAt?: AgentTimestamp;
    readonly id: AgentRunId;
    readonly outcome?: AgentRunOutcome;
    readonly startedAt: AgentTimestamp;
  } | null;
  readonly leafEntryId?: AgentEntryId | null;
  readonly mode?: string | null;
  readonly model?: AgentModelSelection | null;
  readonly pendingInputs?: readonly AgentQueuedInput[];
  readonly pendingPermissions?: readonly AgentPermissionRequest[];
  readonly runState?: AgentSessionRunState;
  readonly title?: string | null;
  readonly updatedAt?: AgentTimestamp;
  readonly usageTotal?: AgentUsage | null;
  readonly workspaceRef?: string | null;
}

export interface AgentSessionStateChangedEvent extends AgentTransientEventBase {
  readonly payload: { readonly patch: AgentSessionStatePatch; readonly revision: number };
  readonly type: "session.state.changed";
}

export interface AgentEntryDeltaEvent extends AgentTransientEventBase {
  readonly payload: {
    readonly blockIndex: number;
    readonly chunkSeq: number;
    readonly delta: string;
    readonly entryId: AgentEntryId;
    readonly part: "text" | "thinking" | "tool_output";
  };
  readonly type: "entry.delta";
}

export interface AgentRunActivityEvent extends AgentTransientEventBase {
  readonly payload: {
    readonly detail?: string;
    readonly kind: "compaction" | "retry" | "summarizing" | "thinking";
    readonly runId: AgentRunId;
  };
  readonly type: "run.activity";
}

export interface AgentPresenceDevice {
  readonly deviceId: string;
  readonly name?: string;
  readonly since: AgentTimestamp;
  readonly viewing: boolean;
}

export interface AgentPresenceChangedEvent extends AgentTransientEventBase {
  readonly payload: { readonly devices: readonly AgentPresenceDevice[] };
  readonly type: "presence.changed";
}

export type AgentDurableSessionEvent = AgentEntryAppendedEvent;

export type AgentTransientSessionEvent =
  | AgentEntryDeltaEvent
  | AgentPresenceChangedEvent
  | AgentRunActivityEvent
  | AgentSessionStateChangedEvent;

export type AgentSessionEvent = AgentDurableSessionEvent | AgentTransientSessionEvent;

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
