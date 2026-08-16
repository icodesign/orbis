import { ORBIS_REMOTE_SCOPES } from "@orbisapp/transport";

export const ORBIS_REMOTE_AGENT_V2_PROTOCOL_VERSION = 2 as const;
export const ORBIS_REMOTE_AGENT_V2_EVENT_TYPE = "orbis.event" as const;

export const ORBIS_REMOTE_AGENT_V2_METHODS = {
  hello: "orbis.hello",
  modelsList: "orbis.models.list",
  workspacesList: "orbis.workspaces.list",
  workspacesBrowse: "orbis.workspaces.browse",
  workspacesCreateFolder: "orbis.workspaces.createFolder",
  workspacesRegister: "orbis.workspaces.register",
  sessionsList: "orbis.sessions.list",
  sessionsCreate: "orbis.sessions.create",
  sessionsSync: "orbis.sessions.sync",
  sessionsEntries: "orbis.sessions.entries",
  sessionsPrompt: "orbis.sessions.prompt",
  sessionsCancel: "orbis.sessions.cancel",
  sessionsUpdate: "orbis.sessions.update",
  sessionsRespondPermission: "orbis.sessions.respondPermission",
  sessionsFork: "orbis.sessions.fork",
  sessionsDispose: "orbis.sessions.dispose",
} as const;

export const ORBIS_REMOTE_AGENT_V2_METHOD_SCOPES = {
  [ORBIS_REMOTE_AGENT_V2_METHODS.hello]: [ORBIS_REMOTE_SCOPES.agentRead],
  [ORBIS_REMOTE_AGENT_V2_METHODS.modelsList]: [ORBIS_REMOTE_SCOPES.agentRead],
  [ORBIS_REMOTE_AGENT_V2_METHODS.workspacesList]: [ORBIS_REMOTE_SCOPES.agentRead],
  [ORBIS_REMOTE_AGENT_V2_METHODS.workspacesBrowse]: [ORBIS_REMOTE_SCOPES.workspaceBrowse],
  [ORBIS_REMOTE_AGENT_V2_METHODS.workspacesCreateFolder]: [
    ORBIS_REMOTE_SCOPES.workspaceBrowse,
    ORBIS_REMOTE_SCOPES.agentWrite,
  ],
  [ORBIS_REMOTE_AGENT_V2_METHODS.workspacesRegister]: [
    ORBIS_REMOTE_SCOPES.workspaceBrowse,
    ORBIS_REMOTE_SCOPES.agentWrite,
  ],
  [ORBIS_REMOTE_AGENT_V2_METHODS.sessionsList]: [ORBIS_REMOTE_SCOPES.agentRead],
  [ORBIS_REMOTE_AGENT_V2_METHODS.sessionsCreate]: [ORBIS_REMOTE_SCOPES.agentWrite],
  [ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync]: [ORBIS_REMOTE_SCOPES.agentRead],
  [ORBIS_REMOTE_AGENT_V2_METHODS.sessionsEntries]: [ORBIS_REMOTE_SCOPES.agentRead],
  [ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt]: [ORBIS_REMOTE_SCOPES.agentWrite],
  [ORBIS_REMOTE_AGENT_V2_METHODS.sessionsCancel]: [ORBIS_REMOTE_SCOPES.agentWrite],
  [ORBIS_REMOTE_AGENT_V2_METHODS.sessionsUpdate]: [ORBIS_REMOTE_SCOPES.agentWrite],
  [ORBIS_REMOTE_AGENT_V2_METHODS.sessionsRespondPermission]: [ORBIS_REMOTE_SCOPES.agentWrite],
  [ORBIS_REMOTE_AGENT_V2_METHODS.sessionsFork]: [ORBIS_REMOTE_SCOPES.agentWrite],
  [ORBIS_REMOTE_AGENT_V2_METHODS.sessionsDispose]: [ORBIS_REMOTE_SCOPES.agentWrite],
} as const;

export const ORBIS_REMOTE_AGENT_V2_METHOD_LIST = Object.values(ORBIS_REMOTE_AGENT_V2_METHODS);
