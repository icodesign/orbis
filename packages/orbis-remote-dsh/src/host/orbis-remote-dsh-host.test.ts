import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentDriverId } from "@orbisapp/orbis-agent-backend";
import {
  ORBIS_REMOTE_AGENT_V2_METHOD_LIST,
  ORBIS_REMOTE_AGENT_V2_METHODS,
  OrbisRemoteAgentV2Connection,
  type RemoteAgentV2Delivery,
} from "@orbisapp/remote-agent-protocol";
import type {
  JsonValue,
  RemoteHostPeer,
  TransportEvent,
  WebSocketEvent,
} from "@orbisapp/transport";
import { expect, test } from "vitest";

import type {
  DshAgent,
  DshAgentInboxEvent,
  DshContext,
  DshQuestionAnswer,
  DshQuestionRequest,
  DshSession,
  DshSessionEvent,
  DshSessionHeader,
  DshUserMessage,
} from "../adapter";
import { OrbisRemoteDshHost } from "./orbis-remote-dsh-host";

const peer: RemoteHostPeer = {
  descriptor: { deviceId: "phone-a", role: "client", version: "1" },
  handshakeId: "handshake-a",
  keyId: "sha256:phone-key",
  mode: "authenticated",
  publicKey: "public-key",
  scopes: ["host:connect", "agent:read", "agent:write"],
};

class TestHostConnection {
  readonly peers: readonly RemoteHostPeer[] = [peer];

  private readonly closeListeners = new Set<(event: WebSocketEvent) => void>();
  private readonly eventListeners = new Set<(event: TransportEvent) => void>();

  close(): void {
    for (const listener of this.closeListeners) listener({});
  }

  onClose(listener: (event: WebSocketEvent) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onEvent(listener: (event: TransportEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async sendEvent(handshakeId: string, event: TransportEvent): Promise<void> {
    if (handshakeId !== peer.handshakeId) throw new Error("unexpected test peer");
    for (const listener of this.eventListeners) listener(event);
  }
}

async function eventually(operation: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (operation()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the v2 transport event");
}

/**
 * Builds a fake native DSH session behind the port `DshLocalBackend` reads:
 * an `eventAt`/`seq`/`snapshotEvents` view over a mutable backing array. The
 * array is also returned so a test can push new native events directly, the
 * way DSH itself appends to a live session's log.
 */
function createTestDshSession(
  id: string,
  header: Omit<DshSessionHeader, "id">,
  initialEvents: readonly DshSessionEvent[] = [],
): { readonly events: DshSessionEvent[]; readonly session: DshSession } {
  const events: DshSessionEvent[] = [...initialEvents];
  const session: DshSession = {
    eventAt: (seq) => events.find((candidate) => candidate.seq === seq),
    header: { ...header, id },
    id,
    get seq() {
      const last = events.at(-1);
      return last === undefined ? 0 : last.seq + 1;
    },
    snapshotEvents: (fromSeq, toSeqExclusive) => {
      if (fromSeq === undefined && toSeqExclusive === undefined) return events;
      return events.filter(
        (candidate) =>
          (fromSeq === undefined || candidate.seq >= fromSeq) &&
          (toSeqExclusive === undefined || candidate.seq < toSeqExclusive),
      );
    },
  };
  return { events, session };
}

test("composes a remote DSH catalog behind the v2 request handler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbis-remote-dsh-host-"));
  const sessions = new Map<string, DshSession>();
  const sessionEvents = new Map<string, DshSessionEvent[]>();
  const agents = new Map<string, DshAgent>();
  const selectedModels = new Map<string, { readonly model: string; readonly provider: string }>();
  const nativeListeners = new Set<(session: DshSession, event: DshSessionEvent) => void>();
  const inboxes = new Map<string, { nextStep: DshUserMessage[]; nextTurn: DshUserMessage[] }>();
  const nativeInboxListeners = new Map<string, Set<(event: DshAgentInboxEvent) => void>>();
  const host = new OrbisRemoteDshHost({
    dsh: {
      context: {
        sessionController: {
          create: async (payload) => {
            const id = String(payload.sessionId);
            const { events, session } = createTestDshSession(id, {
              agentPreset: payload.agentPreset ?? "standard",
              createdAt: Date.parse("2026-08-10T00:00:00.000Z"),
              cwd: "/workspace",
            });
            sessions.set(id, session);
            sessionEvents.set(id, events);
            const inbox = { nextStep: [] as DshUserMessage[], nextTurn: [] as DshUserMessage[] };
            inboxes.set(id, inbox);
            const agent: DshAgent = {
              cancel: () => {},
              followup: () => {},
              id,
              inbox,
              options: {},
              session,
              status: "idle",
              steer: () => {},
            };
            agents.set(id, agent);
            return { agentPreset: session.header.agentPreset, sessionId: id };
          },
          modelCatalog: async () => ({
            failures: [],
            groups: [
              {
                id: "test-provider",
                models: [
                  {
                    description: "A deterministic test model",
                    id: "test-model",
                    name: "Test Model",
                  },
                ],
                name: "Test Provider",
              },
            ],
          }),
          selectModel: async (payload) => {
            const id = String(payload.sessionId);
            if (!agents.has(id)) throw new Error("missing session");
            const selected = { model: payload.model, provider: payload.provider };
            selectedModels.set(id, selected);
            return { selected };
          },
        },
        agents: {
          create: async ({ agentOptions, sessionId }) => {
            const id = String(sessionId);
            const { events, session } = createTestDshSession(id, {
              createdAt: Date.parse("2026-08-10T00:00:00.000Z"),
              cwd: "/workspace",
            });
            sessions.set(id, session);
            sessionEvents.set(id, events);
            const inbox = { nextStep: [] as DshUserMessage[], nextTurn: [] as DshUserMessage[] };
            inboxes.set(id, inbox);
            const agent: DshAgent = {
              cancel: () => {},
              followup: () => {},
              id,
              inbox,
              options: agentOptions ?? {},
              session,
              status: "idle",
              steer: () => {},
            };
            agents.set(id, agent);
            return {
              agent,
              dispose: async (): Promise<void> => {
                agents.delete(id);
              },
            };
          },
          get: (id) => agents.get(String(id)),
          resume: async ({ resumeSessionId }) => {
            const id = String(resumeSessionId);
            const agent = agents.get(id);
            if (agent === undefined) throw new Error("session not found");
            return {
              agent,
              dispose: async (): Promise<void> => {
                agents.delete(id);
              },
            };
          },
        },
        on: (event, listener) => {
          if (event === "session/event") {
            const sessionListener = listener as (
              session: DshSession,
              native: DshSessionEvent,
            ) => void;
            nativeListeners.add(sessionListener);
            return () => nativeListeners.delete(sessionListener);
          }
          const inboxListener = listener as (event: DshAgentInboxEvent) => void;
          const listeners = nativeInboxListeners.get(event) ?? new Set();
          listeners.add(inboxListener);
          nativeInboxListeners.set(event, listeners);
          return () => listeners.delete(inboxListener);
        },
        sessionPersistence: {
          inspect: async (id) => {
            if (String(id) === "legacy") {
              throw new Error("A catalog request must not inspect this historic transcript");
            }
            const session = sessions.get(String(id));
            if (session === undefined) throw new Error("session not found");
            return { events: session.snapshotEvents(), meta: session.header };
          },
          list: async () => [...sessions.values()].map((session) => session.header),
        },
        sessionProjections: {
          snapshot: (session) => {
            const next = selectedModels.get(String(session.id)) ?? {
              model: "test-model",
              provider: "test-provider",
            };
            return { values: { modelSelection: { lastUsed: next, next } } };
          },
        },
        workspace: {
          get: (id) =>
            String(id) === "workspace-a"
              ? {
                  attachSession: async () => {},
                  id,
                  path: "/workspace",
                  sessionIds: ["native-a"],
                  title: "Workspace",
                }
              : undefined,
          list: () => [],
        },
      },
      createSessionId: () => "native-a",
      createUserMessage: () => ({ id: "message" }),
      listSessionCatalog: async () => [
        {
          createdAt: Date.parse("2026-08-09T00:00:00.000Z"),
          id: "legacy",
          title: "Existing DSH session",
          updatedAt: Date.parse("2026-08-10T01:00:00.000Z"),
        },
      ],
      toSessionId: (id) => id,
    },
    hostId: "host-a",
    hostKeyId: "sha256:host-key",
    state: { path: join(directory, "agent-state.json") },
  });
  const emitInbox = (
    id: string,
    target: "nextStep" | "nextTurn",
    message: DshUserMessage,
  ): void => {
    const agent = agents.get(id);
    const events = sessionEvents.get(id);
    const inbox = inboxes.get(id);
    if (agent === undefined || inbox === undefined || events === undefined) {
      throw new Error("missing test agent inbox");
    }
    const native: DshSessionEvent = {
      data: {
        inserted: [message],
        start: inbox[target].length,
        target: target === "nextStep" ? "next-step" : "next-turn",
      },
      seq: agent.session.seq,
      time: Date.parse("2026-08-10T00:00:00.000Z"),
      type: "agent/inbox/spliced",
    };
    events.push(native);
    for (const listener of nativeListeners) listener(agent.session, native);
    inbox[target].push(message);
    for (const listener of nativeInboxListeners.get("agent/inbox/inserted") ?? [])
      listener({ agent, message });
  };
  try {
    const result = await host.requestHandler(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { supportedVersions: [2], device: { name: "Test phone", platform: "ios" } },
      {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: "request-a",
        signal: new AbortController().signal,
      },
    );

    expect(result).toMatchObject({
      capabilities: { presence: true },
      drivers: [{ displayName: "DeepSeek Harness", id: "dsh" }],
      version: 2,
    });
    const models = await host.requestHandler(
      ORBIS_REMOTE_AGENT_V2_METHODS.modelsList,
      { driverId: "dsh" },
      {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: "request-models",
        signal: new AbortController().signal,
      },
    );
    expect(models).toMatchObject({
      models: [
        {
          description: "A deterministic test model",
          displayName: "Test Model",
          modelId: "test-model",
          provider: "test-provider",
        },
      ],
      revision: "1",
    });
    const listed = await host.requestHandler(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsList,
      { driverId: "dsh" },
      {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: "request-list",
        signal: new AbortController().signal,
      },
    );
    expect(listed).toMatchObject({
      sessions: [
        {
          ref: {
            backendId: "remote:host-a",
            driverId: "dsh",
            nativeSessionId: "legacy",
            sessionId: "legacy",
          },
          title: "Existing DSH session",
        },
      ],
    });
    const created = await host.requestHandler(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsCreate,
      {
        driverId: "dsh",
        workspaceRef: "workspace-a",
        idempotencyKey: "create-a",
      },
      {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: "request-create",
        signal: new AbortController().signal,
      },
    );
    expect(created).toMatchObject({
      ref: {
        backendId: "remote:host-a",
        driverId: "dsh",
        nativeSessionId: "native-a",
        sessionId: "native-a",
      },
    });
    const duplicateCreate = await host.requestHandler(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsCreate,
      {
        driverId: "dsh",
        workspaceRef: "workspace-a",
        idempotencyKey: "create-a",
      },
      {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: "request-create-duplicate",
        signal: new AbortController().signal,
      },
    );
    expect(duplicateCreate).toEqual(created);
    const createdRef = (created as { readonly ref: JsonValue }).ref;
    emitInbox("native-a", "nextTurn", {
      content: [{ text: "Queued before sync", type: "text" }],
      id: "follow-up-before-sync",
    });
    const synced = await host.requestHandler(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      { mode: "once", ref: createdRef },
      {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: "request-sync",
        signal: new AbortController().signal,
      },
    );
    expect(synced).toMatchObject({
      baseline: true,
      entries: [],
      state: {
        cwd: "/workspace",
        pendingInputs: [{ id: "follow-up-before-sync", kind: "follow_up" }],
        runState: "idle",
        workspaceRef: "workspace-a",
      },
    });
    const modelUpdated = await host.requestHandler(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsUpdate,
      {
        idempotencyKey: "model-update-a",
        patch: { model: { modelId: "test-model-2", provider: "test-provider" } },
        ref: createdRef,
      },
      {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: "request-model-update",
        signal: new AbortController().signal,
      },
    );
    const duplicateModelUpdate = await host.requestHandler(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsUpdate,
      {
        idempotencyKey: "model-update-a",
        patch: { model: { modelId: "test-model-2", provider: "test-provider" } },
        ref: createdRef,
      },
      {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: "request-model-update-duplicate",
        signal: new AbortController().signal,
      },
    );
    expect(duplicateModelUpdate).toEqual(modelUpdated);
    expect(selectedModels.get("native-a")).toEqual({
      model: "test-model-2",
      provider: "test-provider",
    });
    const modelSnapshot = await host.requestHandler(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      { mode: "once", ref: createdRef },
      {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: "request-model-sync",
        signal: new AbortController().signal,
      },
    );
    expect(modelSnapshot).toMatchObject({
      state: { model: { modelId: "test-model-2", provider: "test-provider" } },
    });
    emitInbox("native-a", "nextStep", {
      content: [{ text: "Steer the active run", type: "text" }],
      id: "steer-after-sync",
    });
    const updated = await host.requestHandler(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      { mode: "once", ref: createdRef },
      {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: "request-sync-after-inbox",
        signal: new AbortController().signal,
      },
    );
    expect(updated).toMatchObject({
      baseline: true,
      state: {
        cwd: "/workspace",
        pendingInputs: [
          { id: "steer-after-sync", kind: "steer" },
          { id: "follow-up-before-sync", kind: "follow_up" },
        ],
      },
    });
    const prompted = await host.requestHandler(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt,
      {
        content: [{ text: "hello", type: "text" }],
        idempotencyKey: "prompt-a",
        ref: createdRef,
      },
      {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: "request-prompt",
        signal: new AbortController().signal,
      },
    );
    const duplicatePrompt = await host.requestHandler(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt,
      {
        content: [{ text: "hello", type: "text" }],
        idempotencyKey: "prompt-a",
        ref: createdRef,
      },
      {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: "request-prompt-duplicate",
        signal: new AbortController().signal,
      },
    );
    expect(duplicatePrompt).toEqual(prompted);
    const nativeSession = sessions.get("native-a");
    const nativeEvents = sessionEvents.get("native-a");
    if (nativeSession === undefined || nativeEvents === undefined) {
      throw new Error("created DSH session is missing");
    }
    const emitNative = (event: DshSessionEvent): void => {
      nativeEvents.push(event);
      for (const listener of nativeListeners) listener(nativeSession, event);
    };
    emitNative({
      data: { turn: 1 },
      seq: 1,
      time: Date.parse("2026-08-10T00:00:01.000Z"),
      type: "turn/start",
    });
    emitNative({
      data: { chunk: { type: "block-start" }, step: 1, turn: 1 },
      seq: 2,
      time: Date.parse("2026-08-10T00:00:02.000Z"),
      type: "assistant/chunk",
    });
    emitNative({
      data: { chunk: { index: 0, text: "streaming", type: "text-delta" }, step: 1, turn: 1 },
      seq: 3,
      time: Date.parse("2026-08-10T00:00:03.000Z"),
      type: "assistant/chunk",
    });
    const liveSnapshot = await host.requestHandler(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      { mode: "once", ref: createdRef },
      {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: "request-overlay",
        signal: new AbortController().signal,
      },
    );
    expect(liveSnapshot).toMatchObject({
      baseline: true,
      overlay: {
        runId: "turn-1",
        streaming: {
          chunkSeq: 1,
          blocks: [{ blockIndex: 0, content: { text: "streaming", type: "text" } }],
          entryId: "message-1-1",
        },
      },
    });
    emitNative({
      data: {
        chunk: {
          argumentsDelta: '{"path":"/workspace/demo.ts"}',
          id: "call-1",
          index: 1,
          name: "read",
          type: "tool-call-delta",
        },
        step: 1,
        turn: 1,
      },
      seq: 4,
      time: Date.parse("2026-08-10T00:00:03.500Z"),
      type: "assistant/chunk",
    });
    const toolSnapshot = await host.requestHandler(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      { mode: "once", ref: createdRef },
      {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: "request-tool-overlay",
        signal: new AbortController().signal,
      },
    );
    expect(toolSnapshot).toMatchObject({
      overlay: {
        runningTools: [
          {
            callId: "call-1",
            entryId: "tool-call-1",
            input: { path: "/workspace/demo.ts" },
            name: "read",
            status: "pending",
          },
        ],
      },
    });
    emitNative({
      data: {
        message: { content: [{ text: "streaming", type: "text" }], role: "assistant" },
        step: 1,
        turn: 1,
      },
      seq: 5,
      time: Date.parse("2026-08-10T00:00:04.000Z"),
      type: "assistant/message",
    });
    const settledSnapshot = await host.requestHandler(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      { mode: "once", ref: createdRef },
      {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: "request-settled",
        signal: new AbortController().signal,
      },
    );
    expect(settledSnapshot).toMatchObject({
      baseline: true,
      entries: [{ id: "message-1-1" }],
    });
    expect(settledSnapshot).not.toHaveProperty("overlay.streaming");
    expect(String(host.nativeBackend.descriptor.id)).toBe("dsh-host");
  } finally {
    await host.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("delivers DSH v2 live entries through the attached host transport", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbis-remote-dsh-host-transport-"));
  const sessions = new Map<string, DshSession>();
  const sessionEvents = new Map<string, DshSessionEvent[]>();
  const agents = new Map<string, DshAgent>();
  const nativeListeners = new Set<(session: DshSession, event: DshSessionEvent) => void>();
  let questionListener:
    | ((
        request: DshQuestionRequest,
        next: () => Promise<DshQuestionAnswer>,
      ) => Promise<DshQuestionAnswer>)
    | undefined;
  const host = new OrbisRemoteDshHost({
    dsh: {
      context: {
        sessionController: {
          create: async (payload) => {
            const id = String(payload.sessionId);
            const { events, session } = createTestDshSession(id, {
              agentPreset: payload.agentPreset ?? "standard",
              createdAt: Date.parse("2026-08-10T00:00:00.000Z"),
              cwd: "/workspace",
            });
            sessions.set(id, session);
            sessionEvents.set(id, events);
            const agent: DshAgent = {
              cancel: () => {},
              followup: () => {},
              id,
              inbox: { nextStep: [], nextTurn: [] },
              options: {},
              session,
              status: "idle",
              steer: () => {},
            };
            agents.set(id, agent);
            return { agentPreset: session.header.agentPreset, sessionId: id };
          },
          modelCatalog: async () => ({ failures: [], groups: [] }),
          selectModel: async (payload) => ({
            selected: { model: payload.model, provider: payload.provider },
          }),
        },
        agents: {
          create: async ({ agentOptions, sessionId }) => {
            const id = String(sessionId);
            const { events, session } = createTestDshSession(id, {
              createdAt: Date.parse("2026-08-10T00:00:00.000Z"),
              cwd: "/workspace",
            });
            sessions.set(id, session);
            sessionEvents.set(id, events);
            const agent: DshAgent = {
              cancel: () => {},
              followup: () => {},
              id,
              inbox: { nextStep: [], nextTurn: [] },
              options: agentOptions ?? {},
              session,
              status: "idle",
              steer: () => {},
            };
            agents.set(id, agent);
            return {
              agent,
              dispose: async (): Promise<void> => {
                agents.delete(id);
              },
            };
          },
          get: (id) => agents.get(String(id)),
          resume: async ({ resumeSessionId }) => {
            const id = String(resumeSessionId);
            const agent = agents.get(id);
            if (agent === undefined) throw new Error("session not found");
            return {
              agent,
              dispose: async (): Promise<void> => {
                agents.delete(id);
              },
            };
          },
        },
        on: ((event: string, listener: unknown) => {
          if (event === "user-questions/request") {
            questionListener = listener as NonNullable<typeof questionListener>;
            return () => {
              questionListener = undefined;
            };
          }
          if (event !== "session/event") return () => {};
          const sessionListener = listener as (
            session: DshSession,
            native: DshSessionEvent,
          ) => void;
          nativeListeners.add(sessionListener);
          return () => nativeListeners.delete(sessionListener);
        }) as DshContext["on"],
        sessionPersistence: {
          inspect: async (id) => {
            const session = sessions.get(String(id));
            if (session === undefined) throw new Error("session not found");
            return { events: session.snapshotEvents(), meta: session.header };
          },
          list: async () => [...sessions.values()].map((session) => session.header),
        },
        sessionProjections: {
          snapshot: () => ({
            values: {
              modelSelection: {
                lastUsed: { model: "test-model", provider: "test-provider" },
                next: { model: "test-model", provider: "test-provider" },
              },
            },
          }),
        },
        workspace: {
          get: (id) =>
            String(id) === "workspace-a"
              ? {
                  attachSession: async () => {},
                  id,
                  path: "/workspace",
                  title: "Workspace",
                }
              : undefined,
          list: () => [],
        },
      },
      createSessionId: () => "native-transport",
      createUserMessage: () => ({ id: "message" }),
      listSessionCatalog: async () => [],
      toSessionId: (id) => id,
    },
    hostId: "host-transport",
    hostKeyId: "sha256:host-transport-key",
    state: { path: join(directory, "agent-state.json") },
  });
  const hostConnection = new TestHostConnection();
  const detach = host.attach(hostConnection);
  let requestCount = 0;
  const clientTransport = {
    methods: ORBIS_REMOTE_AGENT_V2_METHOD_LIST,
    request: async (method: string, params: JsonValue): Promise<JsonValue> =>
      await host.requestHandler(method, params, {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: `transport-request-${++requestCount}`,
        signal: new AbortController().signal,
      }),
    close: () => hostConnection.close(),
    onEvent: (listener: (event: TransportEvent) => void) => hostConnection.onEvent(listener),
    onClose: (listener: () => void) => hostConnection.onClose(() => listener()),
  };
  const client = new OrbisRemoteAgentV2Connection(clientTransport);
  const deliveries: RemoteAgentV2Delivery[] = [];
  const removeDeliveries = client.onEvent((delivery) => deliveries.push(delivery));

  try {
    const hello = await client.hello({
      device: { name: "Transport test", platform: "node" },
      supportedVersions: [2],
    });
    expect(hello).toMatchObject({ hostId: "remote:host-transport", version: 2 });
    const created = await client.createSession({
      driverId: agentDriverId("dsh"),
      idempotencyKey: "transport-create",
      workspaceRef: "workspace-a",
    });
    const live = await client.sync({ mode: "live", ref: created.ref });
    expect(live).toMatchObject({ baseline: true, entries: [] });

    const nativeSession = sessions.get("native-transport");
    const nativeEvents = sessionEvents.get("native-transport");
    if (nativeSession === undefined || nativeEvents === undefined) {
      throw new Error("transport test session is missing");
    }
    const emitNative = (event: DshSessionEvent): void => {
      nativeEvents.push(event);
      for (const listener of nativeListeners) listener(nativeSession, event);
    };
    emitNative({
      data: {
        message: { content: [{ text: "live", type: "text" }], role: "assistant" },
        step: 1,
        turn: 1,
      },
      seq: 1,
      time: Date.parse("2026-08-10T00:00:01.000Z"),
      type: "assistant/message",
    });

    emitNative({
      data: { active: true },
      seq: 2,
      time: Date.parse("2026-08-10T00:00:05.000Z"),
      type: "plan/mode",
    });
    emitNative({
      data: {
        createdAt: Date.parse("2026-08-10T00:00:06.000Z"),
        goal: {
          id: "goal-host",
          maxGoalRounds: 2,
          objective: "Verify the DSH host bridge",
          phase: "active",
          revision: 1,
        },
        kind: "goal/change",
        operation: "create",
        roundsStarted: 0,
        updatedAt: Date.parse("2026-08-10T00:00:06.000Z"),
        version: 1,
      },
      seq: 3,
      time: Date.parse("2026-08-10T00:00:06.000Z"),
      type: "goal/change",
    });
    emitNative({
      data: { todos: [{ content: "Inspect snapshot", status: "in_progress" }] },
      seq: 4,
      time: Date.parse("2026-08-10T00:00:07.000Z"),
      type: "todo/write",
    });
    const nativeAgent = agents.get("native-transport");
    if (nativeAgent === undefined || questionListener === undefined) {
      throw new Error("transport interaction listener is missing");
    }
    const questionResult = questionListener(
      {
        agent: nativeAgent,
        questions: [
          {
            id: "host-question",
            options: [{ label: "Yes" }, { label: "No" }],
            question: "Continue the host bridge test?",
          },
        ],
      },
      async () => ({ answers: [] }),
    );

    await eventually(() =>
      deliveries.some(
        (delivery) =>
          delivery.ref?.sessionId === created.ref.sessionId &&
          delivery.event.type === "entry.appended" &&
          delivery.event.entry.id === "message-1-1",
      ),
    );
    await eventually(
      () =>
        deliveries.some(
          (delivery) =>
            delivery.ref?.sessionId === created.ref.sessionId &&
            delivery.event.type === "session.state.changed" &&
            delivery.event.patch.mode === "plan",
        ) &&
        deliveries.some(
          (delivery) =>
            delivery.ref?.sessionId === created.ref.sessionId &&
            delivery.event.type === "session.state.changed" &&
            delivery.event.patch.workState?.goal?.id === "goal-host" &&
            delivery.event.patch.workState?.todos[0]?.content === "Inspect snapshot",
        ) &&
        deliveries.some(
          (delivery) =>
            delivery.ref?.sessionId === created.ref.sessionId &&
            delivery.event.type === "session.state.changed" &&
            delivery.event.patch.pendingQuestions?.length === 1,
        ),
    );
    // Keep the session live while reading this snapshot: an intentional once
    // sync removes the last subscriber and delegates pending interactions.
    const snapshot = await client.sync({ mode: "live", ref: created.ref });
    expect(snapshot).toMatchObject({
      state: {
        mode: "plan",
        pendingQuestions: [{}],
        workState: {
          goal: { id: "goal-host", objective: "Verify the DSH host bridge" },
          todos: [{ content: "Inspect snapshot", status: "in_progress" }],
        },
      },
    });
    const requestId = snapshot.state.pendingQuestions?.[0]?.requestId;
    if (requestId === undefined) throw new Error("transport question request is missing");
    await expect(
      client.respondQuestion({
        idempotencyKey: "host-question-answer",
        ref: created.ref,
        requestId,
        response: {
          answers: [{ optionIds: ["dsh-option-0-0"], questionId: "host-question" }],
          kind: "answered",
        },
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(questionResult).resolves.toEqual({
      answers: [{ id: "host-question", selected: ["Yes"] }],
    });
    expect(deliveries.some((delivery) => delivery.event.type === "host.session.added")).toBe(true);
  } finally {
    removeDeliveries();
    client.close();
    detach();
    await host.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("pushes a catalog row created outside the host to a listening client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbis-remote-dsh-host-catalog-"));
  const sessions = new Map<string, DshSession>();
  const nativeListeners = new Set<(session: DshSession, event: DshSessionEvent) => void>();
  const addNativeSession = (
    id: string,
  ): { readonly events: DshSessionEvent[]; readonly session: DshSession } => {
    const created = createTestDshSession(id, {
      createdAt: Date.parse("2026-08-10T00:00:00.000Z"),
      cwd: "/workspace",
    });
    sessions.set(id, created.session);
    return created;
  };
  addNativeSession("existing-session");
  const host = new OrbisRemoteDshHost({
    dsh: {
      context: {
        sessionController: {
          create: async () => {
            throw new Error("unused");
          },
          modelCatalog: async () => ({ failures: [], groups: [] }),
          selectModel: async () => {
            throw new Error("unused");
          },
        },
        agents: {
          create: async () => {
            throw new Error("unused");
          },
          get: () => undefined,
          resume: async () => {
            throw new Error("unused");
          },
        },
        on: (event, listener) => {
          if (event !== "session/event") return () => {};
          const sessionListener = listener as (
            session: DshSession,
            native: DshSessionEvent,
          ) => void;
          nativeListeners.add(sessionListener);
          return () => nativeListeners.delete(sessionListener);
        },
        sessionPersistence: {
          inspect: async (id) => {
            const session = sessions.get(String(id));
            if (session === undefined) throw new Error("session not found");
            return { events: session.snapshotEvents(), meta: session.header };
          },
          list: async () => [...sessions.values()].map((session) => session.header),
        },
        sessionProjections: { snapshot: () => ({ values: {} }) },
        workspace: { get: () => undefined, list: () => [] },
      },
      createUserMessage: () => ({ id: "message" }),
      listSessionCatalog: async () =>
        [...sessions.values()].map((session) => ({
          createdAt: session.header.createdAt,
          id: session.header.id,
          updatedAt: session.header.createdAt + session.seq,
        })),
      toSessionId: (id) => id,
    },
    hostId: "host-catalog",
    hostKeyId: "sha256:host-catalog-key",
    state: { path: join(directory, "agent-state.json") },
  });
  const hostConnection = new TestHostConnection();
  const detach = host.attach(hostConnection);
  let requestCount = 0;
  const client = new OrbisRemoteAgentV2Connection({
    methods: ORBIS_REMOTE_AGENT_V2_METHOD_LIST,
    request: async (method: string, params: JsonValue): Promise<JsonValue> =>
      await host.requestHandler(method, params, {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: `catalog-request-${++requestCount}`,
        signal: new AbortController().signal,
      }),
    close: () => hostConnection.close(),
    onEvent: (listener: (event: TransportEvent) => void) => hostConnection.onEvent(listener),
    onClose: (listener: () => void) => hostConnection.onClose(() => listener()),
  });
  const deliveries: RemoteAgentV2Delivery[] = [];
  const removeDeliveries = client.onEvent((delivery) => deliveries.push(delivery));

  try {
    await client.hello({
      device: { name: "Catalog test", platform: "node" },
      supportedVersions: [2],
    });
    const listed = await client.listSessions({});
    expect(listed.sessions.map((session) => String(session.ref.sessionId))).toEqual([
      "existing-session",
    ]);

    // DSH Web adds a session and gives it content. The host never opened it, so
    // its only trace is the native catalog moving underneath.
    const webSession = addNativeSession("web-session");
    const native: DshSessionEvent = {
      data: {
        message: { content: [{ text: "from dsh web", type: "text" }], role: "assistant" },
        step: 1,
        turn: 1,
      },
      seq: 1,
      time: Date.parse("2026-08-10T00:00:01.000Z"),
      type: "assistant/message",
    };
    webSession.events.push(native);
    for (const listener of nativeListeners) listener(webSession.session, native);

    await eventually(() =>
      deliveries.some(
        (delivery) =>
          delivery.event.type === "host.session.added" &&
          delivery.event.session.ref.sessionId === "web-session",
      ),
    );
    expect(
      deliveries.filter((delivery) => delivery.event.type.startsWith("host.session.")),
    ).toHaveLength(1);
  } finally {
    removeDeliveries();
    client.close();
    detach();
    await host.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("reads the full transcript on the first cold sync of a session DSH web created and populated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbis-remote-dsh-host-probe-"));
  const sessions = new Map<string, DshSession>();
  const agents = new Map<string, DshAgent>();
  const nativeListeners = new Set<(session: DshSession, event: DshSessionEvent) => void>();
  // DSH web already ran a full turn before any client ever connected.
  const { session: webSession } = createTestDshSession(
    "web-only",
    { createdAt: Date.parse("2026-08-10T00:00:00.000Z"), cwd: "/workspace" },
    [
      {
        data: { turn: 1 },
        seq: 1,
        time: Date.parse("2026-08-10T00:00:01.000Z"),
        type: "turn/start",
      },
      {
        data: {
          content: [{ text: "hello from web", type: "text" }],
          role: "user",
          source: { kind: "user" },
        },
        seq: 2,
        time: Date.parse("2026-08-10T00:00:02.000Z"),
        type: "user/message",
      },
      {
        data: {
          message: { content: [{ text: "hi from dsh", type: "text" }], role: "assistant" },
          step: 1,
          turn: 1,
        },
        seq: 3,
        time: Date.parse("2026-08-10T00:00:03.000Z"),
        type: "assistant/message",
      },
    ],
  );
  sessions.set("web-only", webSession);
  const host = new OrbisRemoteDshHost({
    dsh: {
      context: {
        sessionController: {
          create: async (payload) => {
            const id = String(payload.sessionId);
            const session = sessions.get(id);
            if (session === undefined) throw new Error("session not found");
            const agent: DshAgent = {
              cancel: () => {},
              followup: () => {},
              id,
              inbox: { nextStep: [], nextTurn: [] },
              options: {},
              session,
              status: "idle",
              steer: () => {},
            };
            agents.set(id, agent);
            return { agentPreset: session.header.agentPreset, sessionId: id };
          },
          modelCatalog: async () => ({ failures: [], groups: [] }),
          selectModel: async (payload) => ({
            selected: { model: payload.model, provider: payload.provider },
          }),
        },
        agents: {
          create: async () => {
            throw new Error("unused");
          },
          get: (id) => agents.get(String(id)),
          resume: async ({ resumeSessionId }) => {
            const id = String(resumeSessionId);
            const session = sessions.get(id);
            if (session === undefined) throw new Error("session not found");
            const agent: DshAgent = {
              cancel: () => {},
              followup: () => {},
              id,
              inbox: { nextStep: [], nextTurn: [] },
              options: {},
              session,
              status: "idle",
              steer: () => {},
            };
            return { agent, dispose: async () => {} };
          },
        },
        on: (event, listener) => {
          if (event !== "session/event") return () => {};
          const sessionListener = listener as (
            session: DshSession,
            native: DshSessionEvent,
          ) => void;
          nativeListeners.add(sessionListener);
          return () => nativeListeners.delete(sessionListener);
        },
        sessionPersistence: {
          inspect: async (id) => {
            const session = sessions.get(String(id));
            if (session === undefined) throw new Error("session not found");
            return { events: session.snapshotEvents(), meta: session.header };
          },
          list: async () => [...sessions.values()].map((session) => session.header),
        },
        sessionProjections: {
          snapshot: () => ({
            values: {
              modelSelection: {
                lastUsed: { model: "test-model", provider: "test-provider" },
                next: { model: "test-model", provider: "test-provider" },
              },
            },
          }),
        },
        workspace: { get: () => undefined, list: () => [] },
      },
      createUserMessage: () => ({ id: "message" }),
      listSessionCatalog: async () =>
        [...sessions.values()].map((session) => ({
          createdAt: session.header.createdAt,
          id: session.header.id,
          updatedAt: session.header.createdAt + session.seq,
        })),
      toSessionId: (id) => id,
    },
    hostId: "host-probe",
    hostKeyId: "sha256:host-probe-key",
    state: { path: join(directory, "agent-state.json") },
  });
  const hostConnection = new TestHostConnection();
  const detach = host.attach(hostConnection);
  let requestCount = 0;
  const client = new OrbisRemoteAgentV2Connection({
    methods: ORBIS_REMOTE_AGENT_V2_METHOD_LIST,
    request: async (method: string, params: JsonValue): Promise<JsonValue> =>
      await host.requestHandler(method, params, {
        maxResponseBytes: 1024 * 1024,
        peer,
        requestId: `probe-request-${++requestCount}`,
        signal: new AbortController().signal,
      }),
    close: () => hostConnection.close(),
    onEvent: (listener: (event: TransportEvent) => void) => hostConnection.onEvent(listener),
    onClose: (listener: () => void) => hostConnection.onClose(() => listener()),
  });

  try {
    await client.hello({
      device: { name: "Probe", platform: "node" },
      supportedVersions: [2],
    });
    const listed = await client.listSessions({});
    const publicRef = listed.sessions[0]?.ref;
    if (publicRef === undefined) throw new Error("session not listed");

    // The client has never opened this session before — cold "switch to it".
    const result = await client.sync({ mode: "once", ref: publicRef });
    expect(result).toMatchObject({
      baseline: true,
      entries: [
        { content: [{ text: "hello from web" }], kind: "message", role: "user" },
        { content: [{ text: "hi from dsh" }], kind: "message", role: "assistant" },
      ],
    });
  } finally {
    client.close();
    detach();
    await host.close();
    await rm(directory, { force: true, recursive: true });
  }
});
