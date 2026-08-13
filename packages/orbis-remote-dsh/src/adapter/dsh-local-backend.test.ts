import { describe, expect, test } from "vitest";

import {
  agentDriverId,
  agentTimestamp,
  createAgentSessionRef,
  type AgentSessionEvent,
  type AgentTimestamp,
} from "@orbisapp/orbis-agent-backend";

import { DshLocalBackend } from "./dsh-local-backend";
import type {
  DshAgent,
  DshAgentHandle,
  DshAgentInboxEvent,
  DshAgentOptions,
  DshContext,
  DshSession,
  DshSessionCatalogEntry,
  DshSessionEvent,
  DshSessionHeader,
  DshUserMessage,
} from "./dsh-types";

const FIXED_TIME = agentTimestamp("2026-08-10T00:00:00.000Z");
const EPOCH = Date.parse(FIXED_TIME);

function event(type: string, seq: number, data: unknown, offset = seq): DshSessionEvent {
  return { data, seq, time: EPOCH + offset, type };
}

function asUserMessage(text: string): DshUserMessage {
  return { id: `user-${text}` };
}

class TestSession implements DshSession {
  readonly events: DshSessionEvent[];
  readonly header: DshSessionHeader;

  constructor(
    readonly id: string,
    events: readonly DshSessionEvent[] = [],
  ) {
    this.events = [...events];
    this.header = { createdAt: EPOCH, cwd: "/workspace/demo", id };
  }
}

class TestAgent implements DshAgent {
  readonly inbox: { nextStep: DshUserMessage[]; nextTurn: DshUserMessage[] } = {
    nextStep: [],
    nextTurn: [],
  };
  readonly followups: DshUserMessage[] = [];
  readonly steers: DshUserMessage[] = [];
  cancelCalls: Array<{ readonly keepInbox?: boolean }> = [];
  status: "idle" | "running" = "idle";

  constructor(
    readonly id: string,
    readonly session: TestSession,
    readonly options: DshAgentOptions = {},
  ) {}

  cancel(_cause: { readonly kind: "user" }, options?: { readonly keepInbox?: boolean }): void {
    this.cancelCalls.push(options ?? {});
    this.status = "idle";
  }

  followup(message: DshUserMessage): void {
    this.followups.push(message);
    this.status = "running";
  }

  steer(message: DshUserMessage): void {
    this.steers.push(message);
  }
}

class TestDsh {
  readonly attachedSessions: string[] = [];
  readonly context: DshContext;
  readonly createCalls: Array<{
    readonly agentOptions?: DshAgentOptions;
    readonly meta: { readonly cwd: string };
    readonly sessionId: unknown;
  }> = [];
  readonly disposeCalls = new Map<string, number>();
  readonly liveAgents = new Map<string, TestAgent>();
  readonly selectedModels = new Map<
    string,
    { readonly model: string; readonly provider: string }
  >();
  readonly sessions = new Map<string, TestSession>();

  private readonly listeners = new Set<(session: DshSession, native: DshSessionEvent) => void>();
  private readonly inboxListeners = new Map<string, Set<(event: DshAgentInboxEvent) => void>>();
  private readonly materialized = new Set<string>();

  constructor() {
    this.context = {
      apiProxy: {
        llm: {
          models: async ({ rpcId }) => ({
            result: {
              ok: true,
              value: {
                failures: [],
                groups: [
                  {
                    id: "test-provider",
                    models: [
                      {
                        description: "A deterministic test model",
                        id: "test-model",
                        name: "Test Model",
                        reasoning: {
                          defaultEffort: "high",
                          efforts: [
                            { id: "off", name: "Off" },
                            {
                              description: "Use the model's deepest reasoning mode",
                              id: "max",
                              name: "Maximum",
                            },
                          ],
                        },
                      },
                    ],
                    name: "Test Provider",
                  },
                ],
              },
            },
            rpcId,
          }),
        },
        sessions: {
          models: async ({ payload, rpcId }) => {
            const id = String(payload.sessionId);
            const agent = this.liveAgents.get(id);
            if (agent === undefined) {
              return {
                result: {
                  error: { code: "session-not-found", message: "missing session" },
                  ok: false as const,
                },
                rpcId,
              };
            }
            return {
              result: {
                ok: true as const,
                value: {
                  current:
                    this.selectedModels.get(id) ??
                    ({
                      model: agent.options.model ?? "test-model",
                      provider: agent.options.provider ?? "test-provider",
                    } as const),
                },
              },
              rpcId,
            };
          },
          selectModel: async ({ payload, rpcId }) => {
            const id = String(payload.sessionId);
            if (!this.liveAgents.has(id)) {
              return {
                result: {
                  error: { code: "session-not-found", message: "missing session" },
                  ok: false as const,
                },
                rpcId,
              };
            }
            const selected = { model: payload.model, provider: payload.provider };
            this.selectedModels.set(id, selected);
            return { result: { ok: true as const, value: { selected } }, rpcId };
          },
        },
      },
      agents: {
        create: async (input) => {
          const id = String(input.sessionId);
          if (this.sessions.has(id)) throw new Error("duplicate session");
          const session = new TestSession(id);
          this.sessions.set(id, session);
          const agent = new TestAgent(id, session, input.agentOptions);
          this.liveAgents.set(id, agent);
          this.createCalls.push(input);
          return this.handleFor(agent);
        },
        get: (id) => this.liveAgents.get(String(id)),
        resume: async (input) => {
          const id = String(input.resumeSessionId);
          const session = this.sessions.get(id);
          if (session === undefined) throw new Error("missing session");
          const existing = this.liveAgents.get(id);
          if (existing !== undefined) return this.handleFor(existing);
          const agent = new TestAgent(id, session, input.agentOptions);
          this.liveAgents.set(id, agent);
          return this.handleFor(agent);
        },
      },
      on: (event, listener) => {
        if (event === "session/event") {
          const sessionListener = listener as (
            session: DshSession,
            native: DshSessionEvent,
          ) => void;
          this.listeners.add(sessionListener);
          return () => this.listeners.delete(sessionListener);
        }
        const inboxListener = listener as (event: DshAgentInboxEvent) => void;
        const listeners = this.inboxListeners.get(event) ?? new Set();
        listeners.add(inboxListener);
        this.inboxListeners.set(event, listeners);
        return () => listeners.delete(inboxListener);
      },
      sessionPersistence: {
        inspect: async (id) => {
          const session = this.sessions.get(String(id));
          if (session === undefined) throw new Error("missing session");
          return { events: session.events, meta: session.header };
        },
        list: async () =>
          [...this.materialized]
            .map((id) => this.sessions.get(id)?.header)
            .filter((header): header is DshSessionHeader => header !== undefined),
      },
      workspace: {
        get: (id) => {
          if (String(id) !== "workspace-1") return undefined;
          return {
            attachSession: async (sessionId) => {
              this.attachedSessions.push(String(sessionId));
            },
            id,
            path: "/workspace/demo",
            title: "Demo workspace",
          };
        },
        list: () => [
          {
            attachSession: async (sessionId) => {
              this.attachedSessions.push(String(sessionId));
            },
            id: "workspace-1" as never,
            path: "/workspace/demo",
            title: "Demo workspace",
          },
        ],
      },
    };
  }

  addPersistedSession(id: string, events: readonly DshSessionEvent[]): TestSession {
    const session = new TestSession(id, events);
    this.sessions.set(id, session);
    this.materialized.add(id);
    return session;
  }

  agent(id: string): TestAgent {
    const agent = this.liveAgents.get(id);
    if (agent === undefined) throw new Error(`No live agent for ${id}`);
    return agent;
  }

  emit(id: string, native: DshSessionEvent): void {
    const session = this.sessions.get(id);
    if (session === undefined) throw new Error(`No session for ${id}`);
    session.events.push(native);
    this.materialized.add(id);
    for (const listener of this.listeners) listener(session, native);
  }

  emitInbox(id: string, target: "nextStep" | "nextTurn", message: DshUserMessage): void {
    const agent = this.agent(id);
    const native = event(
      "agent/inbox/spliced",
      agent.session.events.length + 1,
      {
        inserted: [message],
        start: agent.inbox[target].length,
        target: target === "nextStep" ? "next-step" : "next-turn",
      },
      0,
    );
    agent.session.events.push(native);
    this.materialized.add(id);
    for (const listener of this.listeners) listener(agent.session, native);
    agent.inbox[target].push(message);
    for (const listener of this.inboxListeners.get("agent/inbox/inserted") ?? [])
      listener({ agent, message });
  }

  private handleFor(agent: TestAgent): DshAgentHandle {
    return {
      agent,
      dispose: async () => {
        const count = this.disposeCalls.get(agent.id) ?? 0;
        this.disposeCalls.set(agent.id, count + 1);
        if (this.liveAgents.get(agent.id) === agent) this.liveAgents.delete(agent.id);
      },
    };
  }
}

function createBackend(
  testDsh: TestDsh,
  listSessionCatalog?: () => Promise<readonly DshSessionCatalogEntry[]>,
  now: () => AgentTimestamp = () => FIXED_TIME,
): DshLocalBackend {
  return new DshLocalBackend({
    context: testDsh.context,
    createSessionId: () => "created-session",
    createUserMessage: ({ content }) => asUserMessage(content[0].text),
    listSessionCatalog:
      listSessionCatalog ??
      (async () =>
        (await testDsh.context.sessionPersistence.list()).map((header) => ({
          createdAt: header.createdAt,
          id: header.id,
          updatedAt: header.createdAt,
        }))),
    now,
    toSessionId: (id) => id,
  });
}

async function expectCode(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("DSH local backend", () => {
  test("projects the DSH provider catalog into v2 model metadata", async () => {
    const backend = createBackend(new TestDsh());

    await expect(backend.listModels({ driverId: agentDriverId("dsh") })).resolves.toEqual([
      {
        defaultThinkingLevel: "high",
        description: "A deterministic test model",
        displayName: "Test Model",
        modelId: "test-model",
        provider: "test-provider",
        providerDisplayName: "Test Provider",
        thinkingLevels: [
          { displayName: "Off", id: "off" },
          {
            description: "Use the model's deepest reasoning mode",
            displayName: "Maximum",
            id: "max",
          },
        ],
      },
    ]);
    await expect(backend.listModels({ driverId: agentDriverId("pi") })).resolves.toEqual([]);
  });

  test("updates one live session model through DSH's shared gateway", async () => {
    const testDsh = new TestDsh();
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await expect(backend.readSession(record.ref)).resolves.toMatchObject({
      metadata: { model: { modelId: "test-model", provider: "test-provider" } },
    });
    await expect(
      backend.updateSession(record.ref, {
        expectedRevision: 0,
        patch: { model: { modelId: "test-model-2", provider: "test-provider" } },
      }),
    ).resolves.toEqual({ revision: 1 });
    expect(testDsh.selectedModels.get("created-session")).toEqual({
      model: "test-model-2",
      provider: "test-provider",
    });
    expect(events).toMatchObject([
      {
        payload: {
          patch: { model: { modelId: "test-model-2", provider: "test-provider" } },
          revision: 1,
        },
        type: "session.state.changed",
      },
    ]);
    await expect(backend.readSession(record.ref)).resolves.toMatchObject({
      metadata: { model: { modelId: "test-model-2", provider: "test-provider" } },
    });
    await expectCode(
      () =>
        backend.updateSession(record.ref, {
          expectedRevision: 0,
          patch: { model: { modelId: "test-model", provider: "test-provider" } },
        }),
      "revision_conflict",
    );
  });

  test("lists the durable catalog without replaying historical transcripts", async () => {
    const testDsh = new TestDsh();
    testDsh.addPersistedSession("legacy", [
      // Deliberately not projectable by the current adapter. It must not hide
      // this or any other catalog row from a paired client.
      event("tool/result", 0, { message: { content: [] } }),
    ]);
    const backend = createBackend(testDsh);

    await expect(backend.listSessions()).resolves.toMatchObject([
      {
        ref: { nativeSessionId: "legacy", sessionId: "legacy" },
        runtimeStatus: "ready",
      },
    ]);
  });

  test("keeps a DSH catalog title available for remote navigation", async () => {
    const testDsh = new TestDsh();
    const backend = createBackend(testDsh, async () => [
      {
        createdAt: EPOCH,
        id: "named",
        title: "  Review the remote implementation  ",
        updatedAt: EPOCH + 1,
      },
    ]);

    await expect(backend.listSessions()).resolves.toMatchObject([
      {
        ref: { nativeSessionId: "named", sessionId: "named" },
        title: "Review the remote implementation",
      },
    ]);
  });

  test("keeps a title listed after a client opens the session", async () => {
    const testDsh = new TestDsh();
    testDsh.addPersistedSession("opened", [event("session/title", 0, { title: "Logged title" })]);
    const backend = createBackend(testDsh, async () => [
      { createdAt: EPOCH, id: "opened", title: "Catalog title", updatedAt: EPOCH + 1 },
    ]);
    const ref = createAgentSessionRef({
      backendId: "local",
      driverId: "dsh",
      nativeSessionId: "opened",
      sessionId: "opened",
    });

    // Opening the session retains a live controller. Its summary replaces the
    // catalog row in the listing, so it must carry the title itself.
    await backend.connectRuntime(ref);

    await expect(backend.listSessions()).resolves.toMatchObject([
      { ref: { sessionId: "opened" }, title: "Logged title" },
    ]);

    // The live controller outranks DSH's throttled projection cache: a rename
    // must reach the listing before the next durable checkpoint does.
    testDsh.emit("opened", event("session/title", 1, { title: "Renamed live" }));

    await expect(backend.listSessions()).resolves.toMatchObject([
      { ref: { sessionId: "opened" }, title: "Renamed live" },
    ]);
  });

  test("falls back to the catalog title when an open session logged none", async () => {
    const testDsh = new TestDsh();
    testDsh.addPersistedSession("untitled", [event("turn/start", 0, { turn: 1 })]);
    const backend = createBackend(testDsh, async () => [
      { createdAt: EPOCH, id: "untitled", title: "Catalog title", updatedAt: EPOCH + 1 },
    ]);

    await backend.connectRuntime(
      createAgentSessionRef({
        backendId: "local",
        driverId: "dsh",
        nativeSessionId: "untitled",
        sessionId: "untitled",
      }),
    );

    await expect(backend.listSessions()).resolves.toMatchObject([
      { ref: { sessionId: "untitled" }, title: "Catalog title" },
    ]);
  });

  test("projects the durable DSH session log instead of a live-agent map", async () => {
    const testDsh = new TestDsh();
    testDsh.addPersistedSession("persisted", [
      event("turn/start", 0, { turn: 1 }),
      event("user/message", 1, {
        content: [{ text: "Read the file", type: "text" }],
        id: "user-1",
        role: "user",
        source: { kind: "user" },
      }),
      event("request/header", 2, {
        header: {
          config: { model: "test-model", provider: "test-provider", reasoningEffort: "high" },
        },
        reason: "initial",
      }),
      event("assistant/message", 3, {
        message: {
          content: [
            { text: "I will inspect it.", type: "text" },
            { text: "I should verify this carefully.", type: "reasoning" },
            {
              arguments: '{"path":"/workspace/demo.ts"}',
              id: "tool-1",
              name: "read",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
        step: 1,
        turn: 1,
      }),
      event("tool/call", 4, {
        arguments: '{"path":"/workspace/demo.ts"}',
        callId: "tool-1",
        name: "read",
        step: 1,
        turn: 1,
      }),
      event("tool/result", 5, {
        message: {
          content: [
            {
              content: [{ text: "contents", type: "text" }],
              toolCallId: "tool-1",
              type: "tool-result",
            },
          ],
          role: "tool",
          source: { callId: "tool-1", kind: "tool" },
        },
        step: 1,
        turn: 1,
      }),
      event("turn/end", 6, { reason: { kind: "completed" }, turn: 1 }),
      event("session/title", 7, { title: "Investigation" }),
    ]);
    const backend = createBackend(testDsh);
    const ref = createAgentSessionRef({
      backendId: "local",
      driverId: "dsh",
      nativeSessionId: "persisted",
      sessionId: "persisted",
    });

    const projection = await backend.readSession(ref);

    expect(projection.metadata).toMatchObject({
      model: { modelId: "test-model", provider: "test-provider", thinkingLevel: "high" },
      title: "Investigation",
    });
    expect(projection.entries).toMatchObject([
      { content: [{ text: "Read the file", type: "text" }], kind: "message", role: "user" },
      {
        content: [
          { text: "I will inspect it.", type: "text" },
          { text: "I should verify this carefully.", type: "thinking" },
          {
            callId: "tool-1",
            input: { path: "/workspace/demo.ts" },
            name: "read",
            type: "tool_call",
          },
        ],
        kind: "message",
        role: "assistant",
      },
      {
        callId: "tool-1",
        input: { path: "/workspace/demo.ts" },
        kind: "tool",
        name: "read",
        output: [{ text: "contents", type: "text" }],
        status: "success",
      },
    ]);
    expect(projection.lastRun).toMatchObject({ id: "turn-1", state: "completed" });
    expect(projection.state).toBe("idle");
  });

  test("projects producer-supplied context as context entries named by producer", async () => {
    const testDsh = new TestDsh();
    testDsh.addPersistedSession("injected", [
      event("user/message", 0, {
        content: [{ text: "Hi", type: "text" }],
        id: "user-1",
        role: "user",
        source: { kind: "user", rpcId: "rpc-1" },
      }),
      event("user/message", 1, {
        content: [
          { text: "<system-reminder>Workspace instructions</system-reminder>", type: "text" },
        ],
        id: "context-1",
        role: "user",
        source: {
          baseline: true,
          changes: [
            { action: "set", digest: "abc", path: "AGENTS.md" },
            { action: "set", digest: "def", path: "apps/mobile/AGENTS.md" },
          ],
          form: "instructions",
          kind: "workspace-instructions",
        },
      }),
      event("user/message", 2, {
        content: [{ text: "Current runtime context.", type: "text" }],
        id: "context-2",
        role: "user",
        source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" },
      }),
      // A producer this adapter has never seen still identifies itself by kind.
      event("user/message", 3, {
        content: [{ text: "<system-reminder>Skills</system-reminder>", type: "text" }],
        id: "context-3",
        role: "user",
        source: { entries: [], form: "catalog", kind: "skill-catalog" },
      }),
      event("user/message", 4, {
        content: [{ text: "Earlier session", type: "text" }],
        id: "context-4",
        role: "user",
        source: { kind: "session-reference", references: [{ label: "Yesterday's run" }] },
      }),
    ]);
    const backend = createBackend(testDsh);

    const projection = await backend.readSession(
      createAgentSessionRef({
        backendId: "local",
        driverId: "dsh",
        nativeSessionId: "injected",
        sessionId: "injected",
      }),
    );

    expect(projection.entries).toMatchObject([
      { kind: "message", role: "user" },
      { kind: "context", label: "AGENTS.md, apps/mobile/AGENTS.md", origin: "inject" },
      { kind: "context", label: "@deepseek-ai/dsh-system-prompt", origin: "inject" },
      { kind: "context", label: "skill-catalog", origin: "inject" },
      { kind: "context", label: "Yesterday's run", origin: "recall" },
    ]);
    // A human prompt carries no driver record: `_meta` is for what a client
    // cannot reconstruct from the canonical fields.
    expect(projection.entries[0]?._meta).toBeUndefined();
    // The context entries carry their durable source verbatim, so a DSH-aware
    // client can present the fields this contract does not name -- here the
    // reconciled file list with the action taken on each.
    expect(projection.entries[1]?._meta).toEqual({
      dsh: {
        baseline: true,
        changes: [
          { action: "set", digest: "abc", path: "AGENTS.md" },
          { action: "set", digest: "def", path: "apps/mobile/AGENTS.md" },
        ],
        form: "instructions",
        kind: "workspace-instructions",
      },
    });
  });

  test("keeps a DSH agent running across runtime facades and reconnects to it", async () => {
    const testDsh = new TestDsh();
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      model: { modelId: "test-model", provider: "test-provider" },
      workspaceRef: "workspace-1",
    });
    const firstRuntime = await backend.connectRuntime(record.ref);
    const firstEvents: AgentSessionEvent[] = [];
    firstRuntime.subscribe((native) => firstEvents.push(native));

    const receipt = await firstRuntime.prompt({ text: "Keep running" });
    expect(receipt).toMatchObject({ acceptedAt: FIXED_TIME, runId: "turn-1" });
    expect(testDsh.agent("created-session").followups).toHaveLength(1);
    testDsh.emit("created-session", event("turn/start", 0, { turn: 1 }));
    await firstRuntime.close();

    expect(firstRuntime.getStatus()).toBe("closed");
    expect(testDsh.disposeCalls.get("created-session") ?? 0).toBe(0);
    expect(firstEvents.map((native) => native.type)).toEqual(["session.state.changed"]);

    const reconnected = await backend.connectRuntime(record.ref);
    const reconnectedEvents: AgentSessionEvent[] = [];
    reconnected.subscribe((native) => reconnectedEvents.push(native));
    testDsh.emit(
      "created-session",
      event("assistant/chunk", 1, {
        chunk: { type: "block-start" },
        step: 1,
        turn: 1,
      }),
    );
    testDsh.emit(
      "created-session",
      event("assistant/chunk", 2, {
        chunk: { index: 2, text: "Still running after the page changed.", type: "text-delta" },
        step: 1,
        turn: 1,
      }),
    );
    testDsh.emit(
      "created-session",
      event("assistant/message", 3, {
        message: {
          content: [{ text: "Still running after the page changed.", type: "text" }],
          role: "assistant",
        },
        step: 1,
        turn: 1,
      }),
    );
    testDsh.agent("created-session").status = "idle";
    testDsh.emit(
      "created-session",
      event("turn/end", 4, { reason: { kind: "completed" }, turn: 1 }),
    );

    expect(reconnected.getStatus()).toBe("ready");
    expect(reconnectedEvents.map((native) => native.type)).toEqual([
      "entry.delta",
      "entry.appended",
      "session.state.changed",
    ]);
    expect(reconnectedEvents[0]).toMatchObject({ payload: { blockIndex: 2 } });
    expect(await backend.listSessions()).toHaveLength(1);
  });

  test("projects DSH inbox mutations as live queued-input state", async () => {
    const testDsh = new TestDsh();
    let now = FIXED_TIME;
    const backend = createBackend(testDsh, undefined, () => now);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    await expect(backend.readSession(record.ref)).resolves.toMatchObject({
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    testDsh.emitInbox("created-session", "nextStep", {
      content: [{ text: "Steer the active run", type: "text" }],
      id: "steer-1",
    });
    testDsh.emitInbox("created-session", "nextTurn", {
      content: [{ text: "Follow up after the turn", type: "text" }],
      id: "follow-up-1",
    });
    now = agentTimestamp("2026-08-11T00:00:00.000Z");

    expect(runtime.pendingInputs()).toEqual([
      {
        content: [{ text: "Steer the active run", type: "text" }],
        id: "steer-1",
        kind: "steer",
        queuedAt: FIXED_TIME,
      },
      {
        content: [{ text: "Follow up after the turn", type: "text" }],
        id: "follow-up-1",
        kind: "follow_up",
        queuedAt: FIXED_TIME,
      },
    ]);
    expect(events).toMatchObject([
      { payload: { patch: { pendingInputs: [{ id: "steer-1" }] } }, type: "session.state.changed" },
      {
        payload: { patch: { pendingInputs: [{ id: "steer-1" }, { id: "follow-up-1" }] } },
        type: "session.state.changed",
      },
    ]);
  });

  test("requires a registered workspace and preserves DSH model and run controls", async () => {
    const testDsh = new TestDsh();
    const backend = createBackend(testDsh);

    expect(await backend.listWorkspaces({ driverId: agentDriverId("dsh") })).toEqual([
      { displayName: "Demo workspace", ref: "workspace-1" },
    ]);

    await expectCode(
      () => backend.createSession({ driverId: agentDriverId("dsh"), workspaceRef: "missing" }),
      "not_found",
    );
    expect(testDsh.createCalls).toHaveLength(0);

    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      model: { modelId: "test-model", provider: "test-provider" },
      workspaceRef: "workspace-1",
    });
    expect(testDsh.createCalls[0]).toMatchObject({
      agentOptions: { model: "test-model", provider: "test-provider" },
      meta: { cwd: "/workspace/demo" },
      sessionId: "created-session",
    });
    expect(testDsh.attachedSessions).toEqual(["created-session"]);

    const runtime = await backend.connectRuntime(record.ref);
    await expectCode(
      () => runtime.prompt({ delivery: "follow_up", text: "Queued before a run" }),
      "conflict",
    );
    expect(testDsh.agent("created-session").followups).toHaveLength(0);

    await runtime.prompt({ text: "Start" });
    const queued = await runtime.prompt({ delivery: "steer", text: "Change direction" });
    expect(String(queued.runId)).toBe("turn-1");
    expect(testDsh.agent("created-session").steers).toHaveLength(1);
    expect(await runtime.cancel({ keepInbox: true })).toEqual({ cancelled: true });
    expect(testDsh.agent("created-session").cancelCalls).toEqual([{ keepInbox: true }]);
  });

  test("announces catalog movement for sessions this backend does not own", async () => {
    const testDsh = new TestDsh();
    testDsh.addPersistedSession("web-session", []);
    const backend = createBackend(testDsh);
    const changes: string[] = [];
    const unobserve = backend.observeCatalog(({ ref }) => changes.push(ref.nativeSessionId));

    // DSH Web drives this session; the Orbis host has no controller for it.
    testDsh.emit("web-session", event("turn/start", 0, { turn: 1 }));
    expect(changes).toEqual(["web-session"]);

    // A session this backend does own reports through its runtime instead, so
    // re-announcing it in the catalog channel would only duplicate delivery.
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    await backend.connectRuntime(record.ref);
    testDsh.emit("created-session", event("turn/start", 0, { turn: 1 }));
    expect(changes).toEqual(["web-session"]);

    unobserve();
    testDsh.emit("web-session", event("turn/start", 1, { turn: 2 }));
    expect(changes).toEqual(["web-session"]);
  });
});
