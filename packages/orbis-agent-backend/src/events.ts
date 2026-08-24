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

/** One selectable value advertised by a session-scoped configuration option. */
export interface AgentSessionConfigOptionChoice {
  readonly description?: string;
  readonly name: string;
  readonly value: string;
}

/** A driver-owned session configuration control exposed to clients. */
export interface AgentSessionConfigOption {
  readonly currentValue: string;
  readonly description?: string;
  readonly id: string;
  readonly name: string;
  readonly options: readonly AgentSessionConfigOptionChoice[];
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
  | {
      readonly data: string;
      readonly mimeType: string;
      readonly name?: string;
      readonly type: "image";
    }
  | {
      readonly attachmentId: string;
      readonly bytes?: number;
      readonly height?: number;
      readonly mimeType: string;
      readonly name?: string;
      readonly type: "image_reference";
      readonly width?: number;
    }
  | { readonly redacted?: boolean; readonly text: string; readonly type: "thinking" }
  | {
      readonly callId: string;
      readonly input?: AgentJsonValue;
      readonly name: string;
      readonly type: "tool_call";
    }
  | { readonly name: string; readonly type: "resource"; readonly uri: string };

/** Prompt content accepted by a backend runtime after attachment admission. */
export type AgentPromptContentBlock =
  | { readonly text: string; readonly type: "text" }
  | {
      readonly data: string;
      readonly mimeType: string;
      readonly name?: string;
      readonly type: "image";
    };

/** Canonical encoded payload returned by the backend attachment read seam. */
export interface AgentAttachmentReadResult {
  readonly attachmentId: string;
  readonly bytes?: number;
  readonly data: string;
  readonly height?: number;
  readonly mimeType: string;
  readonly name?: string;
  readonly width?: number;
}

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

export type AgentGoalPhase = "active" | "blocked" | "complete" | "paused";

export interface AgentGoalBlockedReason {
  readonly code: string;
  readonly message: string;
}

/** Whole durable goal snapshot, independent of any one harness implementation. */
export interface AgentGoal {
  readonly blockedReason?: AgentGoalBlockedReason;
  readonly createdAt: AgentTimestamp;
  readonly id: string;
  readonly maxGoalRounds: number;
  readonly objective: string;
  readonly phase: AgentGoalPhase;
  readonly revision: number;
  readonly roundsStarted: number;
  readonly updatedAt: AgentTimestamp;
}

export interface AgentTodoItem {
  readonly content: string;
  readonly status: "completed" | "in_progress" | "pending";
}

/** Stable whole snapshot used by goal/todo-capable drivers. */
export interface AgentWorkState {
  readonly goal: AgentGoal | null;
  readonly todos: readonly AgentTodoItem[];
}

export type AgentPermissionOptionKind =
  | "allow_always"
  | "allow_once"
  | "reject_always"
  | "reject_once";

export interface AgentPermissionOption {
  readonly kind: AgentPermissionOptionKind;
  readonly label: string;
  readonly optionId: string;
}

export interface AgentPermissionRequest {
  readonly callId?: string;
  readonly detail?: string;
  readonly options: readonly AgentPermissionOption[];
  readonly requestedAt: AgentTimestamp;
  readonly requestId: string;
  readonly title: string;
}

export interface AgentPermissionResponseInput {
  readonly idempotencyKey?: string;
  readonly optionId: string;
  readonly requestId: string;
}

export interface AgentPermissionResponseResult {
  readonly accepted: boolean;
}

/** A display-safe option in a driver-owned Ask User question. */
export interface AgentQuestionOption {
  readonly description?: string;
  /** Opaque protocol identity; clients must not substitute the label here. */
  readonly optionId: string;
  readonly label: string;
}

export interface AgentQuestionPlanReviewIntent {
  readonly approveOptionId: string;
  readonly kind: "plan-review";
}

/** One item in a full-set Ask User request. */
export interface AgentQuestionItem {
  readonly detail?: string;
  readonly header?: string;
  readonly intent?: AgentQuestionPlanReviewIntent;
  readonly multiSelect: boolean;
  readonly options: readonly AgentQuestionOption[];
  readonly question: string;
  readonly questionId: string;
}

/** The complete set of questions owned by one paused driver interaction. */
export interface AgentQuestionRequest {
  readonly questions: readonly AgentQuestionItem[];
  readonly requestedAt: AgentTimestamp;
  readonly requestId: string;
}

export interface AgentQuestionAnswerItem {
  readonly customText?: string;
  readonly optionIds: readonly string[];
  readonly questionId: string;
}

export type AgentQuestionResponse =
  | { readonly answers: readonly AgentQuestionAnswerItem[]; readonly kind: "answered" }
  | { readonly kind: "cancelled" };

export interface AgentQuestionResponseInput {
  readonly idempotencyKey?: string;
  readonly requestId: string;
  readonly response: AgentQuestionResponse;
}

export interface AgentQuestionResponseResult {
  readonly accepted: boolean;
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
  readonly payload: {
    readonly entry: AgentSessionEntry;
    /**
     * Transient entry identity settled by this durable append.  Producers must
     * provide this when a streamed overlay is committed; durable-only/replayed
     * entries intentionally omit it.
     */
    readonly settlesEntryId?: AgentEntryId;
  };
  readonly type: "entry.appended";
}

export type AgentSessionRunState = "error" | "idle" | "running" | "suspended";

export interface AgentSessionStatePatch {
  readonly activeRun?: {
    readonly id: AgentRunId;
    readonly startedAt: AgentTimestamp;
  } | null;
  readonly configOptions?: readonly AgentSessionConfigOption[];
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
  /** Complete current Ask User request set; omitted only when unchanged. */
  readonly pendingQuestions?: readonly AgentQuestionRequest[];
  readonly runState?: AgentSessionRunState;
  readonly title?: string | null;
  readonly updatedAt?: AgentTimestamp;
  readonly usageTotal?: AgentUsage | null;
  readonly workspaceRef?: string | null;
  /** Complete harness-neutral goal/todo snapshot; omitted only when unchanged. */
  readonly workState?: AgentWorkState;
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
    readonly part: "text" | "thinking" | "tool_input" | "tool_output";
  };
  readonly type: "entry.delta";
}

export interface AgentToolStateChangedEvent extends AgentTransientEventBase {
  readonly payload: {
    readonly tool: {
      readonly callId: string;
      readonly content?: readonly AgentContentBlock[];
      readonly entryId: AgentEntryId;
      readonly input?: AgentJsonValue;
      readonly name: string;
      readonly status: "cancelled" | "error" | "pending" | "running" | "success";
    };
  };
  readonly type: "tool.state.changed";
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
  | AgentSessionStateChangedEvent
  | AgentToolStateChangedEvent;

export type AgentSessionEvent = AgentDurableSessionEvent | AgentTransientSessionEvent;

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
