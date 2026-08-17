/**
 * Orbis Remote Agent Protocol v2.
 *
 * The package owns only the wire contract and the host/client adapters. The
 * mobile cache-facing projection port lives in the mobile app, while Pi/DSH
 * native semantics stay in their respective host adapters.
 */
export {
  ORBIS_REMOTE_AGENT_V2_EVENT_TYPE,
  ORBIS_REMOTE_AGENT_V2_METHOD_LIST,
  ORBIS_REMOTE_AGENT_V2_METHOD_SCOPES,
  ORBIS_REMOTE_AGENT_V2_METHODS,
  ORBIS_REMOTE_AGENT_V2_PROTOCOL_VERSION,
} from "./v2-constants";

export {
  createOrbisRemoteAgentV2Connection,
  OrbisRemoteAgentV2Connection,
  type RemoteAgentV2Connection,
  type RemoteAgentV2SyncMode,
  type RemoteAgentV2SyncResult,
} from "./v2-connection";

export {
  OrbisRemoteAgentV2Host,
  type RemoteAgentV2HostOptions,
  type RemoteAgentV2HostScheduler,
  type RemoteAgentV2HostStore,
  type RemoteAgentV2IdempotencyClaim,
  type RemoteAgentV2StoredEntryIndex,
  type RemoteAgentV2StoredSessionIndex,
} from "./v2-host";

export {
  createRemoteAgentV2HostRequestHandler,
  OrbisRemoteAgentV2HostTransport,
} from "./v2-host-transport";

export type {
  RemoteAgentHostDeliveryTransport,
  RemoteAgentHostPeer,
  RemoteAgentHostRequestContext,
} from "./host";

export { createRemoteAgentHostPeer } from "./host";

export type {
  RemoteAgentV2Backend,
  RemoteAgentV2CancelInput,
  RemoteAgentV2ContentBlock,
  RemoteAgentV2CreateInput,
  RemoteAgentV2Delivery,
  RemoteAgentV2DeviceDescriptor,
  RemoteAgentV2Entry,
  RemoteAgentV2Event,
  RemoteAgentV2EventChannel,
  RemoteAgentV2Hello,
  RemoteAgentV2HostCapabilities,
  RemoteAgentV2HostEvent,
  RemoteAgentV2JsonValue,
  RemoteAgentV2Limits,
  RemoteAgentV2ModelSelection,
  RemoteAgentV2Overlay,
  RemoteAgentV2PermissionRequest,
  RemoteAgentV2PermissionResponseInput,
  RemoteAgentV2PromptInput,
  RemoteAgentV2PromptReceipt,
  RemoteAgentV2QueuedInput,
  RemoteAgentV2RunState,
  RemoteAgentV2RunSummary,
  RemoteAgentV2Runtime,
  RemoteAgentV2SessionEvent,
  RemoteAgentV2SessionRecord,
  RemoteAgentV2SessionSnapshot,
  RemoteAgentV2SessionState,
  RemoteAgentV2SessionStatePatch,
  RemoteAgentV2SessionSummary,
  RemoteAgentV2Usage,
  RemoteAgentV2UpdateInput,
  RemoteAgentV2WorkspaceBrowseInput,
  RemoteAgentV2WorkspaceCreateFolderInput,
  RemoteAgentV2WorkspaceRegisterInput,
} from "./v2-types";
