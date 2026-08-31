/**
 * Structural ports for the fixed DSH host runtime. Keeping these interfaces
 * here means the generic backend does not import Cordis or DSH implementation
 * packages; the DSH bundle is the sole runtime composition point.
 */

import type {
  AgentPromptReferenceCompletionResult,
  AgentPromptReferenceSource,
  AgentSessionConfigOption,
} from "@orbisapp/orbis-agent-backend";

export type DshWorkspaceId = string & { readonly __dshWorkspaceId: unique symbol };

export interface DshSessionHeader {
  readonly agentPreset?: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly id: unknown;
}

/**
 * A lightweight durable-catalog row. It intentionally carries no transcript
 * events: listing a server must remain independent of whether every historical
 * log can be projected by the current adapter.
 */
export interface DshSessionCatalogEntry {
  readonly createdAt: number;
  readonly id: unknown;
  readonly origin?: "subagent";
  readonly parentSession?: unknown;
  /** Optional log-folded title supplied by the DSH session-query service. */
  readonly title?: string;
  readonly updatedAt: number;
}

export interface DshSessionEvent {
  readonly data: unknown;
  readonly ignorable?: true;
  readonly seq: number;
  readonly time: number;
  readonly type: string;
}

export interface DshSession {
  readonly events: readonly DshSessionEvent[];
  readonly header: DshSessionHeader;
  readonly id: unknown;
}

export interface DshSessionInspection {
  readonly events: readonly DshSessionEvent[];
  readonly meta: DshSessionHeader;
}

/** Optional host-owned bridge for DSH's session permission preset service. */
export interface DshSessionPermissionProvider {
  describe(nativeSessionId: string): AgentSessionConfigOption | undefined;
  set(nativeSessionId: string, value: string): void | Promise<void>;
}

/** Narrow composition seam for DSH's logged plan-mode service. */
export interface DshSessionModeProvider {
  get(agent: DshAgent): { readonly active: boolean; readonly pending?: boolean };
  set(
    agent: DshAgent,
    active: boolean,
  ):
    | "committed"
    | "queued"
    | "cancelled"
    | "noop"
    | Promise<"committed" | "queued" | "cancelled" | "noop">;
}

/** DSH-owned grammar and candidate discovery for prompt references. */
export interface DshPromptReferenceProvider {
  complete(
    input: {
      readonly cursor: number;
      readonly limit: number;
      readonly signal?: AbortSignal;
      readonly source: AgentPromptReferenceSource;
      readonly text: string;
    } & ({ readonly agent: DshAgent } | { readonly workspacePath: string }),
  ): Promise<AgentPromptReferenceCompletionResult | undefined>;
}

/**
 * Narrow composition seam for DSH's authoritative descendant listing. The
 * plugin maps the official DSH rows into this structural shape; the adapter
 * owns conversion to canonical AgentSessionRef values and validation.
 */
export type DshSessionSubagentEntry =
  | {
      readonly activity: "inactive" | "running";
      readonly depth: number;
      readonly hasChildren: boolean;
      readonly id: unknown;
      readonly kind: "child";
      readonly label?: string;
      readonly mode: "continuable" | "one-shot";
      readonly parentId: unknown;
    }
  | {
      readonly depth: number;
      readonly id: unknown;
      readonly kind: "diagnostic";
      readonly parentId: unknown;
      readonly reason: "corrupt" | "unavailable" | "unsupported";
    };

export interface DshSessionSubagentProvider {
  listDescendants(
    nativeSessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly DshSessionSubagentEntry[]>;
}

/** DSH's durable session catalog and append-only history seam. */
export interface DshSessionPersistence {
  inspect(id: unknown, signal?: AbortSignal): Promise<DshSessionInspection>;
  list(signal?: AbortSignal): Promise<readonly DshSessionHeader[]>;
  locate?(header: DshSessionHeader): { readonly path: string } | undefined;
}

export interface DshUserMessage {
  readonly content?: readonly unknown[];
  readonly id: unknown;
}

/** DSH's provider-neutral durable image reference. */
export interface DshImageAttachmentReference {
  readonly attachmentId: string;
  readonly bytes: number;
  readonly height: number;
  readonly mediaType: string;
  readonly name?: string;
  readonly width: number;
}

export interface DshEncodedImageAttachment {
  readonly data: string;
  readonly mediaType: string;
  readonly name?: string;
}

/** Narrow attachment port owned by the DSH plugin composition. */
export interface DshSessionAttachmentPort {
  admitEncodedImages(
    images: readonly DshEncodedImageAttachment[],
  ): Promise<readonly DshImageAttachmentReference[]>;
  readImage(
    reference: DshImageAttachmentReference,
    signal?: AbortSignal,
  ): Promise<{ readonly data: Uint8Array; readonly reference: DshImageAttachmentReference }>;
}

export type DshUserMessageContent =
  | { readonly text: string; readonly type: "text" }
  | { readonly attachment: DshImageAttachmentReference; readonly type: "image" };

export interface DshInbox {
  readonly nextStep: readonly DshUserMessage[];
  readonly nextTurn: readonly DshUserMessage[];
}

export interface DshAgentOptions {
  readonly maxTokens?: number;
  readonly model?: string;
  readonly provider?: string;
}

export interface DshModelCatalogModel {
  readonly description?: string;
  readonly id: string;
  readonly name: string;
  readonly reasoning?: DshModelReasoning;
}

export interface DshModelReasoningEffort {
  readonly description?: string;
  readonly id: string;
  readonly name: string;
}

export interface DshModelReasoning {
  readonly defaultEffort?: string;
  readonly efforts: readonly DshModelReasoningEffort[];
}

export interface DshModelProviderGroup {
  readonly id: string;
  readonly models: readonly DshModelCatalogModel[];
  readonly name: string;
}

export interface DshModelTarget {
  readonly model: string;
  readonly provider: string;
  readonly reasoningEffort?: string;
}

export interface DshQuestionOption {
  readonly description?: string;
  readonly label: string;
}

export interface DshQuestionIntent {
  readonly approve: string;
  readonly kind: "plan-review";
}

export interface DshQuestionItem {
  readonly detail?: string;
  readonly header?: string;
  readonly id: string;
  readonly intent?: DshQuestionIntent;
  readonly multiSelect?: boolean;
  readonly options?: readonly DshQuestionOption[];
  readonly question: string;
}

export interface DshQuestionAnswerItem {
  readonly custom?: string;
  readonly id: string;
  readonly selected: readonly string[];
}

export type DshApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export interface DshApprovalRequest {
  readonly agent: DshAgent;
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

export interface DshQuestionRequest {
  readonly agent?: DshAgent;
  readonly questions: readonly DshQuestionItem[];
  readonly signal?: AbortSignal;
}

export interface DshQuestionAnswer {
  readonly answers: readonly DshQuestionAnswerItem[];
}

/** Host-owned presence seam used to claim DSH interactions only while Orbis can answer. */
export interface DshInteractionAvailability {
  isAvailable(sessionId: string): boolean;
  subscribe(listener: (sessionId: string, available: boolean) => void): () => void;
}

/** DSH alpha Host product service replacing the removed APIProxy session namespace. */
export interface DshSessionController {
  create(request: {
    readonly agentPreset?: string;
    readonly cwd?: string;
    readonly sessionId?: unknown;
    readonly workspaceId?: unknown;
  }): Promise<{ readonly agentPreset?: string; readonly sessionId: unknown }>;
  modelCatalog(): Promise<{
    readonly failures: readonly {
      readonly id: string;
      readonly message: string;
      readonly name: string;
    }[];
    readonly groups: readonly DshModelProviderGroup[];
  }>;
  selectModel(request: DshModelTarget & { readonly sessionId: unknown }): Promise<{
    readonly selected: DshModelTarget;
  }>;
}

/** Exact projection cut installed by DSH's alpha Session Controller. */
export interface DshSessionProjectionRegistry {
  snapshot(session: DshSession): {
    readonly values: {
      readonly modelSelection?: {
        readonly lastUsed: DshModelTarget | null;
        readonly next: DshModelTarget | null;
      };
    };
  };
}

export interface DshAgent {
  readonly inbox: DshInbox;
  readonly id: unknown;
  readonly options: DshAgentOptions;
  readonly session: DshSession;
  readonly status: "idle" | "running";
  cancel(cause: { readonly kind: "user" }, options?: { readonly keepInbox?: boolean }): void;
  followup(message: DshUserMessage): void;
  steer(message: DshUserMessage): void;
}

export interface DshAgentHandle {
  readonly agent: DshAgent;
  dispose(): Promise<void>;
}

export interface DshAgentRegistry {
  create(options: {
    readonly agentOptions?: DshAgentOptions;
    readonly meta: { readonly cwd: string };
    readonly sessionId: unknown;
    readonly signal?: AbortSignal;
  }): Promise<DshAgentHandle>;
  get(id: unknown): DshAgent | undefined;
  resume(options: {
    readonly agentOptions?: DshAgentOptions;
    readonly resumeSessionId: unknown;
    readonly signal?: AbortSignal;
  }): Promise<DshAgentHandle>;
}

export interface DshWorkspace {
  readonly id: DshWorkspaceId;
  readonly path: string;
  readonly sessionIds?: readonly unknown[];
  readonly title: string;
  attachSession(sessionId: unknown): Promise<void>;
}

export interface DshWorkspaceRegistry {
  get(id: DshWorkspaceId): DshWorkspace | undefined;
  list(): readonly DshWorkspace[];
}

export interface DshAgentInboxEvent {
  readonly agent: DshAgent;
  readonly message: DshUserMessage;
  readonly turn?: number;
}

export interface DshContext {
  readonly agents: DshAgentRegistry;
  readonly planMode?: DshSessionModeProvider;
  readonly sessionController: DshSessionController;
  readonly sessionPersistence: DshSessionPersistence;
  readonly sessionProjections: DshSessionProjectionRegistry;
  readonly workspace: DshWorkspaceRegistry;
  on(
    event: "session/event",
    listener: (session: DshSession, event: DshSessionEvent) => void,
  ): () => void;
  on(
    event: "agent/inbox/inserted" | "agent/inbox/claimed" | "agent/inbox/discarded",
    listener: (event: DshAgentInboxEvent) => void,
  ): () => void;
  on(
    event: "approval/request",
    listener: (
      request: DshApprovalRequest,
      next: () => Promise<DshApprovalOutcome>,
    ) => Promise<DshApprovalOutcome>,
    options?: { readonly prepend?: boolean },
  ): () => void;
  on(
    event: "user-questions/request",
    listener: (
      request: DshQuestionRequest,
      next: () => Promise<DshQuestionAnswer>,
    ) => Promise<DshQuestionAnswer>,
    options?: { readonly prepend?: boolean },
  ): () => void;
}
