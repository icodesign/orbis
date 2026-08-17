import type { AgentDriverDescriptor } from "./capabilities";
import { AgentBackendError } from "./errors";
import type {
  AgentJsonValue,
  AgentModelSelection,
  AgentPermissionResponseInput,
  AgentPermissionResponseResult,
  AgentSessionEventListener,
} from "./events";
import type {
  AgentBackendId,
  AgentDriverId,
  AgentNativeSessionId,
  AgentRunId,
  AgentSessionId,
  AgentSessionRef,
  AgentTimestamp,
} from "./identifiers";
import { agentBackendId } from "./identifiers";
import type { AgentSessionProjection } from "./projection";

export type AgentBackendKind = "local" | "remote";

export interface AgentBackendDescriptor {
  readonly displayName: string;
  readonly id: AgentBackendId;
  readonly kind: AgentBackendKind;
}

export interface AgentBackendDescriptorInput {
  readonly displayName: string;
  readonly id: string;
  readonly kind: AgentBackendKind;
}

export function createAgentBackendDescriptor(
  input: AgentBackendDescriptorInput,
): AgentBackendDescriptor {
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 256) {
    throw new AgentBackendError("invalid_argument", "Backend display name is invalid");
  }
  return { displayName, id: agentBackendId(input.id), kind: input.kind };
}

export type AgentRuntimeStatus =
  | "closed"
  | "disconnected"
  | "error"
  | "opening"
  | "ready"
  | "running";

export interface AgentSessionRecord {
  readonly createdAt: AgentTimestamp;
  readonly ref: AgentSessionRef;
  readonly updatedAt: AgentTimestamp;
}

export interface AgentSessionSummary extends AgentSessionRecord {
  readonly runtimeStatus: AgentRuntimeStatus;
  readonly title?: string | null;
}

export interface AgentSessionListInput {
  readonly driverId?: AgentDriverId;
  readonly limit?: number;
}

export interface AgentSessionCreateInput {
  readonly driverId: AgentDriverId;
  readonly model?: AgentModelSelection;
  readonly nativeSessionId?: AgentNativeSessionId;
  readonly title?: string;
  readonly workspaceRef?: string;
}

/** One driver-owned thinking level offered for an exact model route. */
export interface AgentModelThinkingLevelMetadata {
  readonly description?: string;
  readonly displayName: string;
  readonly id: string;
}

/** Display-safe model metadata supplied by the driver that owns the route. */
export interface AgentModelMetadata extends AgentModelSelection {
  readonly contextWindow?: number;
  readonly defaultThinkingLevel?: string;
  readonly description?: string;
  readonly displayName: string;
  readonly providerDisplayName?: string;
  readonly thinkingLevels?: readonly AgentModelThinkingLevelMetadata[];
}

export interface AgentModelListInput {
  readonly driverId?: AgentDriverId;
}

/** Display-safe workspace choice. `ref` remains opaque to clients and routes. */
export interface AgentWorkspaceDescriptor {
  readonly displayName: string;
  readonly ref: string;
}

export interface AgentWorkspaceListInput {
  readonly driverId: AgentDriverId;
}

/** Display-safe server folder metadata. `ref` is opaque and host-issued. */
export interface AgentWorkspaceFolderDescriptor {
  readonly displayName: string;
  readonly hidden: boolean;
  readonly ref: string;
  readonly selectable: boolean;
}

export interface AgentWorkspaceFolderListing {
  readonly breadcrumbs: readonly AgentWorkspaceFolderDescriptor[];
  readonly current: AgentWorkspaceFolderDescriptor | null;
  readonly entries: readonly AgentWorkspaceFolderDescriptor[];
  readonly truncated: boolean;
}

export interface AgentWorkspaceBrowseInput {
  readonly driverId: AgentDriverId;
  readonly folderRef?: string;
  readonly signal?: AbortSignal;
}

export interface AgentWorkspaceRegisterInput {
  readonly driverId: AgentDriverId;
  readonly folderRef: string;
}

export interface AgentWorkspaceCreateFolderInput {
  readonly driverId: AgentDriverId;
  readonly name: string;
  readonly parentFolderRef: string;
}

export interface AgentWorkspaceRegisterResult {
  readonly created: boolean;
  readonly workspace: AgentWorkspaceDescriptor;
}

/** Client-writable session state. Runtime and transcript fields are event-owned. */
export interface AgentSessionUpdatePatch {
  readonly configOptions?: Readonly<Record<string, AgentJsonValue>>;
  readonly mode?: string | null;
  readonly model?: AgentModelSelection | null;
  readonly title?: string | null;
}

export interface AgentSessionUpdateInput {
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
  readonly patch: AgentSessionUpdatePatch;
}

export interface AgentSessionUpdateResult {
  readonly revision: number;
}

/**
 * A queued input is admitted to the current run rather than starting another
 * run. Drivers report which queue semantics they implement via capabilities.
 */
export type AgentPromptDelivery =
  /** Deliver at the driver's next follow-up/continuation point. */
  | "follow_up"
  /** Deliver at the driver's next steering point within the active run. */
  | "steer";

export interface AgentPromptInput {
  readonly delivery?: AgentPromptDelivery;
  readonly idempotencyKey?: string;
  readonly text: string;
}

export interface AgentPromptReceipt {
  readonly acceptedAt: AgentTimestamp;
  readonly runId: AgentRunId;
}

export interface AgentCancelInput {
  readonly keepInbox?: boolean;
}

export interface AgentCancelResult {
  readonly cancelled: boolean;
}

export interface AgentSessionRuntime {
  readonly ref: AgentSessionRef;

  cancel(input?: AgentCancelInput): Promise<AgentCancelResult>;
  close(): Promise<void>;
  getStatus(): AgentRuntimeStatus;
  prompt(input: AgentPromptInput): Promise<AgentPromptReceipt>;
  respondPermission(input: AgentPermissionResponseInput): Promise<AgentPermissionResponseResult>;
  subscribe(listener: AgentSessionEventListener): () => void;
}

/**
 * A driver owns harness semantics. A backend composes one or more drivers under
 * one execution location and stable catalog namespace.
 */
export interface AgentHarnessDriver {
  readonly descriptor: AgentDriverDescriptor;

  close(): Promise<void>;
  connectRuntime(ref: AgentSessionRef): Promise<AgentSessionRuntime>;
  createSession(input?: Omit<AgentSessionCreateInput, "driverId">): Promise<AgentSessionRecord>;
  listModels(): Promise<readonly AgentModelMetadata[]>;
  listWorkspaces(): Promise<readonly AgentWorkspaceDescriptor[]>;
  listSessions(
    input?: Omit<AgentSessionListInput, "driverId">,
  ): Promise<readonly AgentSessionSummary[]>;
  readSession(ref: AgentSessionRef): Promise<AgentSessionProjection>;
  updateSession(
    ref: AgentSessionRef,
    input: AgentSessionUpdateInput,
  ): Promise<AgentSessionUpdateResult>;
}

/**
 * Backend is the execution placement boundary, not a React view model and not a
 * harness type. A LocalBackend can expose Pi and DSH simultaneously.
 */
export interface AgentBackend {
  readonly descriptor: AgentBackendDescriptor;

  close(): Promise<void>;
  browseWorkspaceFolders(input: AgentWorkspaceBrowseInput): Promise<AgentWorkspaceFolderListing>;
  createWorkspaceFolder(
    input: AgentWorkspaceCreateFolderInput,
  ): Promise<AgentWorkspaceFolderDescriptor>;
  connectRuntime(ref: AgentSessionRef): Promise<AgentSessionRuntime>;
  createSession(input: AgentSessionCreateInput): Promise<AgentSessionRecord>;
  listDrivers(): Promise<readonly AgentDriverDescriptor[]>;
  listModels(input?: AgentModelListInput): Promise<readonly AgentModelMetadata[]>;
  listWorkspaces(input: AgentWorkspaceListInput): Promise<readonly AgentWorkspaceDescriptor[]>;
  listSessions(input?: AgentSessionListInput): Promise<readonly AgentSessionSummary[]>;
  readSession(ref: AgentSessionRef): Promise<AgentSessionProjection>;
  registerWorkspace(input: AgentWorkspaceRegisterInput): Promise<AgentWorkspaceRegisterResult>;
  updateSession(
    ref: AgentSessionRef,
    input: AgentSessionUpdateInput,
  ): Promise<AgentSessionUpdateResult>;
}

/** Product-facing mapping from route id to the backend/driver/native locator. */
export interface AgentSessionCatalog {
  get(sessionId: AgentSessionId): Promise<AgentSessionRecord | undefined>;
  list(input?: AgentSessionListInput): Promise<readonly AgentSessionRecord[]>;
  remove(sessionId: AgentSessionId): Promise<void>;
  upsert(record: AgentSessionRecord): Promise<void>;
}
