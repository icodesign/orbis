import type {
  AgentContentBlock,
  AgentDriverDescriptor,
  AgentJsonValue,
  AgentModelMetadata,
  AgentModelSelection,
  AgentSessionRef,
  AgentWorkspaceDescriptor,
  AgentWorkspaceFolderDescriptor,
  AgentWorkspaceFolderListing,
  AgentWorkspaceRegisterResult,
} from "@orbisapp/orbis-agent-backend";
import type {
  AgentBackendId,
  AgentDeliveryCursor,
  AgentEntryId,
  AgentEventId,
  AgentRunId,
  AgentTimestamp,
} from "@orbisapp/orbis-agent-backend";

import type { RemoteAgentHostPeer, RemoteAgentHostRequestContext } from "./host";

export type RemoteAgentV2JsonValue = AgentJsonValue;
export type RemoteAgentV2ContentBlock = AgentContentBlock;

export interface RemoteAgentV2ModelSelection extends AgentModelSelection {}

export interface RemoteAgentV2Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
}

export interface RemoteAgentV2RunSummary {
  readonly runId: AgentRunId;
  readonly startedAt: AgentTimestamp;
  readonly finishedAt?: AgentTimestamp;
  readonly outcome?: "completed" | "cancelled" | "failed";
  readonly error?: { readonly code: string; readonly message: string };
}

export interface RemoteAgentV2QueuedInput {
  readonly id: string;
  readonly kind: "steer" | "follow_up" | "next_run";
  readonly content: readonly RemoteAgentV2ContentBlock[];
  readonly queuedAt: AgentTimestamp;
}

export interface RemoteAgentV2PermissionRequest {
  readonly requestId: string;
  readonly callId?: string;
  readonly title: string;
  readonly detail?: string;
  readonly options: readonly {
    readonly optionId: string;
    readonly label: string;
    readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }[];
  readonly defaultOptionId: string;
  readonly requestedAt: AgentTimestamp;
  readonly expiresAt: AgentTimestamp;
}

export type RemoteAgentV2RunState = "idle" | "running" | "suspended" | "error";

export interface RemoteAgentV2SessionState {
  readonly ref: AgentSessionRef;
  readonly title: string | null;
  readonly model: RemoteAgentV2ModelSelection | null;
  readonly mode: string | null;
  readonly configOptions: Readonly<Record<string, RemoteAgentV2JsonValue>>;
  readonly workspaceRef: string | null;
  readonly cwd: string | null;
  readonly leafEntryId: AgentEntryId | null;
  readonly runState: RemoteAgentV2RunState;
  readonly activeRun?: RemoteAgentV2RunSummary;
  readonly lastRun?: RemoteAgentV2RunSummary;
  readonly pendingInputs: readonly RemoteAgentV2QueuedInput[];
  readonly pendingPermissions: readonly RemoteAgentV2PermissionRequest[];
  readonly usageTotal?: RemoteAgentV2Usage;
  readonly createdAt: AgentTimestamp;
  readonly updatedAt: AgentTimestamp;
  readonly revision: number;
}

/** JSON patches use null to clear optional state fields. */
export type RemoteAgentV2SessionStatePatch = Partial<
  Omit<
    RemoteAgentV2SessionState,
    "ref" | "createdAt" | "revision" | "activeRun" | "lastRun" | "usageTotal"
  >
> & {
  readonly activeRun?: RemoteAgentV2RunSummary | null;
  readonly lastRun?: RemoteAgentV2RunSummary | null;
  readonly usageTotal?: RemoteAgentV2Usage | null;
};

interface RemoteAgentV2EntryBase {
  readonly id: AgentEntryId;
  readonly parentId: AgentEntryId | null;
  /** Host-assigned cursor. Native adapters use 0 before host materialization. */
  readonly cursor: AgentDeliveryCursor;
  readonly createdAt: AgentTimestamp;
  readonly _meta?: RemoteAgentV2JsonValue;
}

export type RemoteAgentV2Entry =
  | (RemoteAgentV2EntryBase & {
      readonly kind: "message";
      readonly role: "user" | "assistant" | "system";
      readonly content: readonly RemoteAgentV2ContentBlock[];
      readonly stopReason?: "stop" | "length" | "tool_use" | "aborted" | "error";
      readonly model?: RemoteAgentV2ModelSelection;
      readonly usage?: RemoteAgentV2Usage;
      readonly errorMessage?: string;
    })
  | (RemoteAgentV2EntryBase & {
      readonly kind: "tool";
      readonly callId: string;
      readonly name: string;
      readonly status: "success" | "error" | "cancelled";
      readonly input?: RemoteAgentV2JsonValue;
      readonly output?: RemoteAgentV2JsonValue;
      readonly content?: readonly RemoteAgentV2ContentBlock[];
    })
  | (RemoteAgentV2EntryBase & {
      readonly kind: "notice";
      readonly code: string;
      readonly message: string;
      readonly level: "info" | "warn" | "error";
    })
  | (RemoteAgentV2EntryBase & {
      readonly kind: "context";
      readonly origin: "inject" | "recall";
      /** Producer name for the reader; absent when the driver's record names none. */
      readonly label?: string;
      readonly content: readonly RemoteAgentV2ContentBlock[];
    });

export interface RemoteAgentV2Overlay {
  readonly runId: AgentRunId;
  readonly streaming?: {
    readonly entryId: AgentEntryId;
    readonly content: readonly RemoteAgentV2ContentBlock[];
    readonly chunkSeq: number;
  };
  readonly runningTools: readonly {
    readonly entryId: AgentEntryId;
    readonly callId: string;
    readonly name: string;
    readonly status: "pending" | "running";
    readonly input?: RemoteAgentV2JsonValue;
    readonly content?: readonly RemoteAgentV2ContentBlock[];
    readonly chunkSeq: number;
  }[];
}

export interface RemoteAgentV2SessionSnapshot {
  readonly state: RemoteAgentV2SessionState;
  readonly entries: readonly RemoteAgentV2Entry[];
  readonly overlay?: RemoteAgentV2Overlay;
}

export interface RemoteAgentV2SessionSummary {
  readonly ref: AgentSessionRef;
  readonly driverId: AgentSessionRef["driverId"];
  readonly title: string | null;
  readonly runState: RemoteAgentV2RunState;
  readonly updatedAt: AgentTimestamp;
}

export interface RemoteAgentV2SessionRecord extends RemoteAgentV2SessionSummary {
  readonly createdAt: AgentTimestamp;
}

export interface RemoteAgentV2HostCapabilities {
  readonly permission: boolean;
  readonly presence: boolean;
  readonly attachments:
    | { readonly maxBytes: number; readonly mimeTypes: readonly string[] }
    | false;
  readonly fork: boolean;
  readonly dispose: boolean;
}

export interface RemoteAgentV2Limits {
  readonly maxReplayBatch: number;
  readonly maxSnapshotWindow: number;
  readonly maxPromptBytes: number;
}

export interface RemoteAgentV2Hello {
  readonly version: 2;
  readonly hostId: AgentBackendId;
  readonly hostRevision: string;
  readonly capabilities: RemoteAgentV2HostCapabilities;
  readonly drivers: readonly AgentDriverDescriptor[];
  readonly limits: RemoteAgentV2Limits;
}

export interface RemoteAgentV2DeviceDescriptor {
  readonly name?: string;
  readonly platform?: string;
}

export interface RemoteAgentV2CreateInput {
  readonly driverId: AgentSessionRef["driverId"];
  readonly model?: RemoteAgentV2ModelSelection;
  readonly mode?: string;
  readonly title?: string;
  readonly workspaceRef?: string;
  readonly nativeSessionId?: string;
  readonly idempotencyKey: string;
}

export interface RemoteAgentV2WorkspaceBrowseInput {
  readonly driverId: AgentSessionRef["driverId"];
  readonly folderRef?: string;
  readonly signal?: AbortSignal;
}

export interface RemoteAgentV2WorkspaceRegisterInput {
  readonly driverId: AgentSessionRef["driverId"];
  readonly folderRef: string;
  readonly idempotencyKey: string;
}

export interface RemoteAgentV2WorkspaceCreateFolderInput {
  readonly driverId: AgentSessionRef["driverId"];
  readonly idempotencyKey: string;
  readonly name: string;
  readonly parentFolderRef: string;
}

export interface RemoteAgentV2PromptInput {
  readonly ref: AgentSessionRef;
  readonly content: readonly RemoteAgentV2ContentBlock[];
  readonly delivery?: "steer" | "follow_up";
  readonly expectedRevision?: number;
  readonly idempotencyKey: string;
}

export interface RemoteAgentV2PromptReceipt {
  readonly runId: AgentRunId;
  readonly acceptedAt: AgentTimestamp;
  readonly queued: boolean;
}

export interface RemoteAgentV2CancelInput {
  readonly ref: AgentSessionRef;
  readonly runId?: AgentRunId;
  readonly keepInbox?: boolean;
  readonly idempotencyKey: string;
}

export interface RemoteAgentV2UpdateInput {
  readonly ref: AgentSessionRef;
  readonly patch: {
    readonly title?: string | null;
    readonly model?: RemoteAgentV2ModelSelection | null;
    readonly mode?: string | null;
    readonly configOptions?: Readonly<Record<string, RemoteAgentV2JsonValue>>;
  };
  readonly expectedRevision?: number;
  readonly idempotencyKey: string;
}

export interface RemoteAgentV2Runtime {
  readonly ref: AgentSessionRef;
  cancel(
    input: Omit<RemoteAgentV2CancelInput, "ref" | "idempotencyKey"> & {
      readonly idempotencyKey?: string;
    },
  ): Promise<{ readonly cancelled: boolean }>;
  close(): Promise<void>;
  prompt(
    input: Omit<RemoteAgentV2PromptInput, "ref" | "idempotencyKey"> & {
      readonly idempotencyKey?: string;
    },
  ): Promise<RemoteAgentV2PromptReceipt>;
  subscribe(listener: (event: RemoteAgentV2SessionEvent) => void): () => void;
}

export interface RemoteAgentV2Backend {
  readonly hostId: AgentBackendId;
  close(): Promise<void>;
  browseWorkspaceFolders(
    driverId: AgentSessionRef["driverId"],
    folderRef?: string,
    signal?: AbortSignal,
  ): Promise<AgentWorkspaceFolderListing>;
  createWorkspaceFolder(
    driverId: AgentSessionRef["driverId"],
    parentFolderRef: string,
    name: string,
  ): Promise<AgentWorkspaceFolderDescriptor>;
  connectRuntime(ref: AgentSessionRef): Promise<RemoteAgentV2Runtime>;
  createSession(
    input: Omit<RemoteAgentV2CreateInput, "idempotencyKey">,
  ): Promise<RemoteAgentV2SessionRecord>;
  listDrivers(): Promise<readonly AgentDriverDescriptor[]>;
  listModels(driverId?: AgentSessionRef["driverId"]): Promise<readonly AgentModelMetadata[]>;
  listWorkspaces(
    driverId: AgentSessionRef["driverId"],
  ): Promise<readonly AgentWorkspaceDescriptor[]>;
  listSessions(input: {
    readonly driverId?: AgentSessionRef["driverId"];
  }): Promise<readonly RemoteAgentV2SessionSummary[]>;
  /**
   * Optional freshness hint for catalog rows the host is not already tracking
   * through a session runtime — a session created or advanced directly in the
   * native harness. The listener carries no payload because `listSessions`
   * remains the catalog authority; a backend without this seam simply leaves
   * clients on their existing list-on-handshake refresh.
   */
  observeCatalog?(listener: () => void): () => void;
  readSession(ref: AgentSessionRef): Promise<RemoteAgentV2SessionSnapshot>;
  registerWorkspace(
    driverId: AgentSessionRef["driverId"],
    folderRef: string,
  ): Promise<AgentWorkspaceRegisterResult>;
  updateSession(ref: AgentSessionRef, patch: RemoteAgentV2UpdateInput["patch"]): Promise<void>;
}

export type RemoteAgentV2EventChannel = "replayable" | "state" | "transient";

interface RemoteAgentV2EventBase {
  readonly eventId: AgentEventId;
  readonly occurredAt: AgentTimestamp;
  readonly sessionId: AgentSessionRef["sessionId"];
  readonly source: {
    readonly backendId: AgentBackendId;
    readonly driverId: AgentSessionRef["driverId"];
    readonly nativeType?: string;
    readonly version?: string;
  };
  readonly channel: RemoteAgentV2EventChannel;
}

export type RemoteAgentV2SessionEvent =
  | (RemoteAgentV2EventBase & {
      readonly channel: "replayable";
      readonly type: "entry.appended";
      readonly cursor: AgentDeliveryCursor;
      readonly entry: RemoteAgentV2Entry;
    })
  | (RemoteAgentV2EventBase & {
      readonly channel: "state";
      readonly type: "session.state.changed";
      readonly patch: RemoteAgentV2SessionStatePatch;
      readonly revision: number;
    })
  | (RemoteAgentV2EventBase & {
      readonly channel: "transient";
      readonly type: "entry.delta";
      readonly entryId: AgentEntryId;
      readonly part: "text" | "thinking" | "tool_output";
      readonly blockIndex: number;
      readonly chunkSeq: number;
      readonly delta: string;
    })
  | (RemoteAgentV2EventBase & {
      readonly channel: "transient";
      readonly type: "run.activity";
      readonly runId: AgentRunId;
      readonly kind: "thinking" | "compaction" | "retry" | "summarizing";
      readonly detail?: string;
    })
  | (RemoteAgentV2EventBase & {
      readonly channel: "transient";
      readonly type: "presence.changed";
      readonly devices: readonly {
        readonly deviceId: string;
        readonly name?: string;
        readonly since: AgentTimestamp;
        readonly viewing: boolean;
      }[];
    });

export type RemoteAgentV2HostEvent =
  | { readonly type: "host.session.added"; readonly session: RemoteAgentV2SessionSummary }
  | {
      readonly type: "host.session.removed";
      readonly sessionId: string;
      readonly reason: "disposed" | "gone";
    }
  | { readonly type: "host.session.changed"; readonly session: RemoteAgentV2SessionSummary }
  | { readonly type: "host.drivers.changed"; readonly drivers: readonly AgentDriverDescriptor[] }
  | { readonly type: "host.models.changed"; readonly revision: string };

export type RemoteAgentV2Event = RemoteAgentV2SessionEvent | RemoteAgentV2HostEvent;

export interface RemoteAgentV2Delivery {
  readonly ref?: AgentSessionRef;
  readonly scope:
    | { readonly kind: "host" }
    | { readonly kind: "session"; readonly ref: AgentSessionRef };
  readonly event: RemoteAgentV2Event;
  readonly transportEvent: import("@orbisapp/transport").TransportEvent;
}

export interface RemoteAgentV2HostRequestContext extends RemoteAgentHostRequestContext {
  readonly peer: RemoteAgentHostPeer;
}
