import {
  agentDriverId,
  agentRunId,
  agentTimestamp,
  createAgentSessionRef,
  type AgentSessionEvent,
  type AgentTimestamp,
} from "@orbisapp/orbis-agent-backend";
import { describe, expect, test } from "vitest";

import { DshLocalBackend } from "./dsh-local-backend";
import type {
  DshAgent,
  DshAgentHandle,
  DshAgentInboxEvent,
  DshAgentOptions,
  DshApprovalOutcome,
  DshApprovalRequest,
  DshContext,
  DshImageAttachmentReference,
  DshSession,
  DshSessionCatalogEntry,
  DshSessionAttachmentPort,
  DshSessionEvent,
  DshSessionHeader,
  DshSessionModeProvider,
  DshQuestionAnswer,
  DshQuestionItem,
  DshQuestionRequest,
  DshPromptReferenceProvider,
  DshSessionSubagentProvider,
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
    metadata: { readonly agentPreset?: string; readonly cwd?: string } = {},
  ) {
    this.events = [...events];
    this.header = {
      createdAt: EPOCH,
      cwd: metadata.cwd ?? "/workspace/demo",
      id,
      ...(metadata.agentPreset === undefined ? {} : { agentPreset: metadata.agentPreset }),
    };
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
  cancelFailure = false;
  status: "idle" | "running" = "idle";

  constructor(
    readonly id: string,
    readonly session: TestSession,
    readonly options: DshAgentOptions = {},
  ) {}

  cancel(_cause: { readonly kind: "user" }, options?: { readonly keepInbox?: boolean }): void {
    this.cancelCalls.push(options ?? {});
    if (this.cancelFailure) throw new Error("cancel failed");
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
    { readonly model: string; readonly provider: string; readonly reasoningEffort?: string }
  >();
  readonly sessionCreateCalls: Array<{
    readonly agentPreset?: string;
    readonly cwd?: string;
    readonly sessionId?: unknown;
    readonly workspaceId?: unknown;
  }> = [];
  delegatedApprovals = 0;
  delegatedQuestions = 0;
  sessionCreateFailure?: unknown;
  readonly sessions = new Map<string, TestSession>();
  currentPreset = "standard";

  private readonly listeners = new Set<(session: DshSession, native: DshSessionEvent) => void>();
  private readonly inboxListeners = new Map<string, Set<(event: DshAgentInboxEvent) => void>>();
  private approvalListener:
    | ((
        request: DshApprovalRequest,
        next: () => Promise<DshApprovalOutcome>,
      ) => Promise<DshApprovalOutcome>)
    | undefined;
  private questionListener:
    | ((
        request: DshQuestionRequest,
        next: () => Promise<DshQuestionAnswer>,
      ) => Promise<DshQuestionAnswer>)
    | undefined;
  private readonly availabilityListeners = new Set<
    (sessionId: string, available: boolean) => void
  >();
  private readonly sessionAvailability = new Map<string, boolean>();
  private interactionAvailable: boolean;
  private readonly materialized = new Set<string>();

  constructor(readonly approvals = false) {
    this.interactionAvailable = approvals;
    this.context = {
      sessionController: {
        create: async (payload) => {
          this.sessionCreateCalls.push(payload);
          if (this.sessionCreateFailure !== undefined) {
            if (this.sessionCreateFailure !== true) throw this.sessionCreateFailure;
            throw Object.assign(new Error("missing workspace"), {
              code: "workspace/not-found",
              failure: { code: "workspace-not-found", message: "missing workspace" },
            });
          }
          const id = String(payload.sessionId);
          const workspace =
            payload.workspaceId === undefined
              ? undefined
              : this.context.workspace.get(payload.workspaceId as never);
          if (payload.workspaceId !== undefined && workspace === undefined) {
            throw new Error("missing workspace");
          }
          let session = this.sessions.get(id);
          let agent = this.liveAgents.get(id);
          if (session === undefined) {
            session = new TestSession(id, [], {
              agentPreset: payload.agentPreset ?? this.currentPreset,
              cwd: workspace?.path ?? payload.cwd,
            });
            this.sessions.set(id, session);
          }
          if (agent === undefined) {
            agent = new TestAgent(id, session);
            this.liveAgents.set(id, agent);
          }
          await workspace?.attachSession(id);
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
        }),
        selectModel: async (payload) => {
          const id = String(payload.sessionId);
          if (!this.liveAgents.has(id)) throw new Error("missing session");
          const selected = {
            model: payload.model,
            provider: payload.provider,
            ...(payload.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: payload.reasoningEffort }),
          };
          this.selectedModels.set(id, selected);
          return { selected };
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
      on: ((event: string, listener: unknown) => {
        if (event === "session/event") {
          const sessionListener = listener as (
            session: DshSession,
            native: DshSessionEvent,
          ) => void;
          this.listeners.add(sessionListener);
          return () => this.listeners.delete(sessionListener);
        }
        if (event === "approval/request") {
          this.approvalListener = listener as NonNullable<typeof this.approvalListener>;
          return () => {
            this.approvalListener = undefined;
          };
        }
        if (event === "user-questions/request") {
          this.questionListener = listener as NonNullable<typeof this.questionListener>;
          return () => {
            this.questionListener = undefined;
          };
        }
        const inboxListener = listener as (event: DshAgentInboxEvent) => void;
        const listeners = this.inboxListeners.get(event) ?? new Set();
        listeners.add(inboxListener);
        this.inboxListeners.set(event, listeners);
        return () => listeners.delete(inboxListener);
      }) as DshContext["on"],
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
      sessionProjections: {
        snapshot: (session) => {
          const agent = this.liveAgents.get(String(session.id));
          const next =
            this.selectedModels.get(String(session.id)) ??
            (agent === undefined
              ? null
              : {
                  model: agent.options.model ?? "test-model",
                  provider: agent.options.provider ?? "test-provider",
                });
          return { values: { modelSelection: { lastUsed: next, next } } };
        },
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

  addPersistedSession(
    id: string,
    events: readonly DshSessionEvent[],
    agentPreset?: string,
  ): TestSession {
    const session = new TestSession(id, events, { agentPreset });
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

  requestApproval(
    toolName: string,
    options: { readonly signal?: AbortSignal; readonly sessionId?: string } = {},
  ): Promise<DshApprovalOutcome> {
    const listener = this.approvalListener;
    if (listener === undefined) throw new Error("No DSH approval listener");
    return listener(
      {
        agent: this.agent(options.sessionId ?? "created-session"),
        callId: `call-${toolName}`,
        reason: "line one\nline two",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        toolName,
      },
      async () => {
        this.delegatedApprovals += 1;
        return "rejected";
      },
    );
  }

  requestQuestion(
    questions: readonly DshQuestionItem[],
    options: { readonly signal?: AbortSignal; readonly sessionId?: string } = {},
  ): Promise<DshQuestionAnswer> {
    const listener = this.questionListener;
    if (listener === undefined) throw new Error("No DSH question listener");
    return listener(
      {
        agent: this.agent(options.sessionId ?? "created-session"),
        questions,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      async () => {
        this.delegatedQuestions += 1;
        return { answers: [] };
      },
    );
  }

  setInteractionAvailable(available: boolean, sessionId?: string): void {
    if (sessionId !== undefined) {
      this.sessionAvailability.set(sessionId, available);
      for (const listener of this.availabilityListeners) listener(sessionId, available);
      return;
    }
    this.interactionAvailable = available;
    for (const id of this.sessions.keys()) {
      for (const listener of this.availabilityListeners) listener(id, available);
    }
  }

  interactionAvailability() {
    return {
      isAvailable: (sessionId: string) =>
        this.sessionAvailability.get(sessionId) ?? this.interactionAvailable,
      subscribe: (listener: (sessionId: string, available: boolean) => void) => {
        this.availabilityListeners.add(listener);
        return () => this.availabilityListeners.delete(listener);
      },
    };
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
  planMode?: DshSessionModeProvider,
  onError?: (error: { readonly code: string }) => void,
  attachments?: DshSessionAttachmentPort,
  subagents?: DshSessionSubagentProvider,
  promptReferences?: DshPromptReferenceProvider,
  onUpstreamError?: (error: unknown) => void,
): DshLocalBackend {
  return new DshLocalBackend({
    context: testDsh.context,
    createSessionId: () => "created-session",
    createUserMessage: ({ content }) => {
      const first = content[0];
      if (first?.type === "text" && content.length === 1) return asUserMessage(first.text);
      return { content, id: "user-image" };
    },
    listSessionCatalog:
      listSessionCatalog ??
      (async () =>
        (await testDsh.context.sessionPersistence.list()).map((header) => ({
          createdAt: header.createdAt,
          id: header.id,
          updatedAt: header.createdAt,
        }))),
    now,
    ...(testDsh.approvals ? { interactionAvailability: testDsh.interactionAvailability() } : {}),
    ...(planMode === undefined ? {} : { planMode }),
    ...(onError === undefined ? {} : { onError }),
    ...(attachments === undefined ? {} : { attachments }),
    ...(subagents === undefined ? {} : { subagents }),
    ...(promptReferences === undefined ? {} : { promptReferences }),
    ...(onUpstreamError === undefined ? {} : { onUpstreamError }),
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for DSH approval state");
}

function questionRequest(): readonly DshQuestionItem[] {
  return [
    {
      detail: "# Plan\n\nDo these steps?",
      header: "Review",
      id: "plan-review",
      intent: { approve: "Approve", kind: "plan-review" },
      multiSelect: false,
      options: [
        { description: "Continue with the plan", label: "Approve" },
        { label: "Keep planning" },
      ],
      question: "Approve this plan?",
    },
    {
      id: "format",
      multiSelect: true,
      options: [{ label: "JSON" }, { label: "Markdown" }],
      question: "Which formats?",
    },
  ];
}

function pendingPermissionIds(events: readonly AgentSessionEvent[]): string[] {
  const state = [...events]
    .reverse()
    .find(
      (native): native is Extract<AgentSessionEvent, { type: "session.state.changed" }> =>
        native.type === "session.state.changed" &&
        native.payload.patch.pendingPermissions !== undefined,
    );
  return state?.payload.patch.pendingPermissions?.map((request) => request.requestId) ?? [];
}

function pendingQuestions(events: readonly AgentSessionEvent[]) {
  const state = [...events]
    .reverse()
    .find(
      (native): native is Extract<AgentSessionEvent, { type: "session.state.changed" }> =>
        native.type === "session.state.changed" &&
        native.payload.patch.pendingQuestions !== undefined,
    );
  return state?.payload.patch.pendingQuestions ?? [];
}

describe("DSH local backend", () => {
  test.each([
    ["gateway/bad-request", "invalid_argument"],
    ["session/model-unavailable", "invalid_argument"],
    ["session/not-found", "not_found"],
    ["workspace/not-found", "not_found"],
    ["session/agent-busy", "conflict"],
    ["session/conflict", "conflict"],
  ])("maps alpha.3 RemoteError %s to %s", async (remoteCode, backendCode) => {
    const dsh = new TestDsh();
    dsh.sessionCreateFailure = Object.assign(new Error("DSH request failed"), {
      code: remoteCode,
    });
    const backend = createBackend(dsh);

    await expectCode(
      () =>
        backend.createSession({
          driverId: agentDriverId("dsh"),
          workspaceRef: "workspace-1",
        }),
      backendCode,
    );
  });

  test("reports the original DSH failure before public error mapping", async () => {
    const dsh = new TestDsh();
    const upstream = Object.assign(new Error("provider unavailable"), {
      code: "gateway/internal",
      serverCode: "windows-provider-startup",
    });
    dsh.sessionCreateFailure = upstream;
    const observed: unknown[] = [];
    const backend = createBackend(
      dsh,
      undefined,
      () => FIXED_TIME,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (error) => observed.push(error),
    );

    await expect(
      backend.createSession({
        driverId: agentDriverId("dsh"),
        workspaceRef: "workspace-1",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(observed).toEqual([upstream]);
  });

  test("completes draft references against the selected workspace without creating a session", async () => {
    const dsh = new TestDsh();
    let received: Parameters<DshPromptReferenceProvider["complete"]>[0] | undefined;
    const backend = createBackend(
      dsh,
      undefined,
      () => FIXED_TIME,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        complete: async (input) => {
          received = input;
          return { candidates: [], end: input.cursor, start: 0 };
        },
      },
    );

    await expect(
      backend.completePromptReferences({
        cursor: 1,
        driverId: agentDriverId("dsh"),
        limit: 4,
        source: "files",
        text: "@",
        workspaceRef: "workspace-1",
      }),
    ).resolves.toMatchObject({ end: 1, start: 0 });
    expect(received).toMatchObject({ source: "files", workspacePath: "/workspace/demo" });
    expect(dsh.sessionCreateCalls).toHaveLength(0);
  });

  test("advertises input.attachments only when the composition port is mounted", async () => {
    const withoutAttachments = createBackend(new TestDsh());
    expect(withoutAttachments.driverDescriptor.capabilities).not.toContain("input.attachments");

    const attachments: DshSessionAttachmentPort = {
      admitEncodedImages: async () => [],
      readImage: async (reference) => ({ data: new Uint8Array(), reference }),
    };
    const withAttachments = createBackend(
      new TestDsh(),
      undefined,
      () => FIXED_TIME,
      undefined,
      undefined,
      attachments,
    );
    expect(withAttachments.driverDescriptor.capabilities).toContain("input.attachments");
    await withoutAttachments.close();
    await withAttachments.close();
  });

  test("advertises and maps authoritative subagent descendants only when mounted", async () => {
    const signal = new AbortController().signal;
    let receivedId: string | undefined;
    let receivedSignal: AbortSignal | undefined;
    const subagents: DshSessionSubagentProvider = {
      listDescendants: async (nativeSessionId, requestSignal) => {
        receivedId = nativeSessionId;
        receivedSignal = requestSignal;
        return [
          {
            activity: "running",
            depth: 1,
            hasChildren: true,
            id: "child-1",
            kind: "child",
            mode: "continuable",
            parentId: "root",
            label: "Research",
          },
          {
            activity: "inactive",
            depth: 2,
            hasChildren: false,
            id: "child-2",
            kind: "child",
            mode: "one-shot",
            parentId: "child-1",
          },
          {
            depth: 1,
            id: "diagnostic-1",
            kind: "diagnostic",
            parentId: "root",
            reason: "corrupt",
          },
        ];
      },
    };
    const withoutProvider = createBackend(new TestDsh());
    expect(withoutProvider.driverDescriptor.capabilities).not.toContain("session.subagents.list");
    const rootRef = createAgentSessionRef({
      backendId: "local",
      driverId: "dsh",
      nativeSessionId: "root",
      sessionId: "root",
    });
    await expect(withoutProvider.listSessionSubagents(rootRef)).rejects.toMatchObject({
      code: "unsupported",
    });

    const backend = createBackend(
      new TestDsh(),
      undefined,
      () => FIXED_TIME,
      undefined,
      undefined,
      undefined,
      subagents,
    );
    expect(backend.driverDescriptor.capabilities).toContain("session.subagents.list");
    await expect(backend.listSessionSubagents(rootRef, signal)).resolves.toEqual([
      {
        activity: "running",
        depth: 1,
        hasChildren: true,
        kind: "child",
        label: "Research",
        mode: "continuable",
        parentRef: rootRef,
        ref: createAgentSessionRef({
          backendId: "local",
          driverId: "dsh",
          nativeSessionId: "child-1",
          sessionId: "child-1",
        }),
      },
      {
        activity: "inactive",
        depth: 2,
        hasChildren: false,
        kind: "child",
        mode: "one-shot",
        parentRef: createAgentSessionRef({
          backendId: "local",
          driverId: "dsh",
          nativeSessionId: "child-1",
          sessionId: "child-1",
        }),
        ref: createAgentSessionRef({
          backendId: "local",
          driverId: "dsh",
          nativeSessionId: "child-2",
          sessionId: "child-2",
        }),
      },
      {
        depth: 1,
        kind: "diagnostic",
        parentRef: rootRef,
        reason: "corrupt",
        ref: createAgentSessionRef({
          backendId: "local",
          driverId: "dsh",
          nativeSessionId: "diagnostic-1",
          sessionId: "diagnostic-1",
        }),
      },
    ]);
    expect(receivedId).toBe("root");
    expect(receivedSignal).toBe(signal);
    await withoutProvider.close();
    await backend.close();
  });

  test("rejects malformed native subagent identities as protocol errors", async () => {
    const backend = createBackend(
      new TestDsh(),
      undefined,
      () => FIXED_TIME,
      undefined,
      undefined,
      undefined,
      {
        listDescendants: async () => [
          {
            activity: "running",
            depth: 1,
            hasChildren: false,
            id: {} as never,
            kind: "child",
            mode: "one-shot",
            parentId: undefined,
          },
        ],
      },
    );
    const rootRef = createAgentSessionRef({
      backendId: "local",
      driverId: "dsh",
      nativeSessionId: "root",
      sessionId: "root",
    });
    await expect(backend.listSessionSubagents(rootRef)).rejects.toMatchObject({ code: "protocol" });
    await backend.close();
  });

  test("maps alpha.3 gateway cancellation to a public unavailable error", async () => {
    const backend = createBackend(
      new TestDsh(),
      undefined,
      () => FIXED_TIME,
      undefined,
      undefined,
      undefined,
      {
        listDescendants: async () => {
          throw { code: "gateway/cancelled" };
        },
      },
    );
    const rootRef = createAgentSessionRef({
      backendId: "local",
      driverId: "dsh",
      nativeSessionId: "root",
      sessionId: "root",
    });
    await expect(backend.listSessionSubagents(rootRef)).rejects.toMatchObject({
      code: "unavailable",
    });
    await backend.close();
  });

  test("rejects continuable descendants without a label as protocol errors", async () => {
    const backend = createBackend(
      new TestDsh(),
      undefined,
      () => FIXED_TIME,
      undefined,
      undefined,
      undefined,
      {
        listDescendants: async () => [
          {
            activity: "running",
            depth: 1,
            hasChildren: false,
            id: "child-1",
            kind: "child",
            mode: "continuable",
            parentId: "root",
          },
        ],
      },
    );
    const rootRef = createAgentSessionRef({
      backendId: "local",
      driverId: "dsh",
      nativeSessionId: "root",
      sessionId: "root",
    });
    await expect(backend.listSessionSubagents(rootRef)).rejects.toMatchObject({ code: "protocol" });
    await backend.close();
  });

  test("admits image-only and mixed prompts as durable DSH attachment refs", async () => {
    const testDsh = new TestDsh();
    const admitted: string[][] = [];
    const attachmentPort: DshSessionAttachmentPort = {
      admitEncodedImages: async (images) => {
        admitted.push(images.map((image) => image.data));
        return images.map(
          (image, index): DshImageAttachmentReference => ({
            attachmentId: `attachment-${admitted.length}-${index}`,
            bytes: (image.data.length / 4) * 3,
            height: 10,
            mediaType: image.mediaType,
            width: 10,
          }),
        );
      },
      readImage: async (reference) => ({ data: new Uint8Array([1, 2, 3]), reference }),
    };
    const backend = createBackend(
      testDsh,
      undefined,
      () => FIXED_TIME,
      undefined,
      undefined,
      attachmentPort,
    );
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);

    await runtime.prompt({
      content: [{ data: "AQID", mimeType: "image/png", type: "image" }],
    });
    expect(admitted).toEqual([["AQID"]]);
    expect(testDsh.agent("created-session").followups[0]?.content).toEqual([
      {
        attachment: {
          attachmentId: "attachment-1-0",
          bytes: 3,
          height: 10,
          mediaType: "image/png",
          width: 10,
        },
        type: "image",
      },
    ]);

    await runtime.cancel();
    await runtime.prompt({
      content: [
        { text: "Describe these", type: "text" },
        { data: "BAUG", mimeType: "image/png", type: "image" },
        { data: "BwgJ", mimeType: "image/jpeg", type: "image" },
      ],
    });
    expect(admitted).toEqual([["AQID"], ["BAUG", "BwgJ"]]);
    expect(testDsh.agent("created-session").followups.at(-1)?.content).toMatchObject([
      { text: "Describe these", type: "text" },
      { type: "image", attachment: { attachmentId: "attachment-2-0" } },
      { type: "image", attachment: { attachmentId: "attachment-2-1" } },
    ]);
  });

  test("projects image references and authorizes DSH attachment reads by session log", async () => {
    const testDsh = new TestDsh();
    const reference: DshImageAttachmentReference = {
      attachmentId: "history-image",
      bytes: 3,
      height: 2,
      mediaType: "image/png",
      name: "diagram.png",
      width: 3,
    };
    testDsh.addPersistedSession("image-history", [
      event("user/message", 0, {
        content: [{ attachment: reference, type: "image" }],
        id: "user-image",
        role: "user",
        source: { kind: "user" },
      }),
    ]);
    testDsh.addPersistedSession("other-history", []);
    const reads: string[] = [];
    const backend = createBackend(testDsh, undefined, () => FIXED_TIME, undefined, undefined, {
      admitEncodedImages: async () => [],
      readImage: async (readReference) => {
        reads.push(readReference.attachmentId);
        return { data: new Uint8Array([1, 2, 3]), reference: readReference };
      },
    });
    const ref = createAgentSessionRef({
      backendId: "local",
      driverId: "dsh",
      nativeSessionId: "image-history",
      sessionId: "image-history",
    });
    const projection = await backend.readSession(ref);
    expect(projection.entries[0]).toMatchObject({
      content: [
        {
          attachmentId: "history-image",
          bytes: 3,
          height: 2,
          mimeType: "image/png",
          name: "diagram.png",
          type: "image_reference",
          width: 3,
        },
      ],
    });
    await expect(backend.readAttachment(ref, "history-image")).resolves.toMatchObject({
      attachmentId: "history-image",
      data: "AQID",
      mimeType: "image/png",
    });
    await expectCode(() => backend.readAttachment(ref, "missing"), "not_found");
    const otherRef = createAgentSessionRef({
      backendId: "local",
      driverId: "dsh",
      nativeSessionId: "other-history",
      sessionId: "other-history",
    });
    await expectCode(() => backend.readAttachment(otherRef, "history-image"), "not_found");
    expect(reads).toEqual(["history-image"]);
  });

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
        content: [{ text: "contents", type: "text" }],
        input: { path: "/workspace/demo.ts" },
        kind: "tool",
        name: "read",
        output: [{ text: "contents", type: "text" }],
        status: "success",
      },
    ]);
    expect(projection.entries[1]).not.toHaveProperty("stopReason");
    expect(projection.lastRun).toMatchObject({ id: "turn-1", state: "completed" });
    expect(projection.state).toBe("idle");
  });

  test("preserves usage-only assistant boundaries for run-level accounting", async () => {
    const testDsh = new TestDsh();
    testDsh.addPersistedSession("usage-only", [
      event("turn/start", 0, { turn: 1 }),
      event("user/message", 1, {
        content: [{ text: "Answer briefly", type: "text" }],
        id: "user-1",
        role: "user",
        source: { kind: "user" },
      }),
      event("step/start", 2, { step: 1, turn: 1 }),
      event("assistant/message", 3, {
        message: { content: [], role: "assistant" },
        step: 1,
        turn: 1,
        usage: {
          cacheReadTokens: 8,
          inputTokens: 100,
          outputTokens: 20,
        },
      }),
      event("step/end", 4, { step: 1, turn: 1 }),
      event("turn/end", 5, { reason: { kind: "max-tokens" }, turn: 1 }),
    ]);

    const projection = await createBackend(testDsh).readSession(
      createAgentSessionRef({
        backendId: "local",
        driverId: "dsh",
        nativeSessionId: "usage-only",
        sessionId: "usage-only",
      }),
    );

    expect(projection.entries.at(-1)).toMatchObject({
      content: [],
      kind: "message",
      role: "assistant",
      scope: { runId: agentRunId("turn-1"), stepId: "1" },
      usage: { cacheReadTokens: 8, inputTokens: 100, outputTokens: 20 },
    });
  });

  test("projects scoped system prompts only at visible request-series boundaries", async () => {
    const testDsh = new TestDsh();
    testDsh.addPersistedSession("system-prompts", [
      event("turn/start", 0, { turn: 1 }),
      event("user/message", 1, {
        content: [{ text: "First question", type: "text" }],
        id: "user-1",
        role: "user",
        source: { kind: "user" },
      }),
      event("step/start", 2, { step: 1, turn: 1 }),
      event("request/header", 3, {
        header: {
          config: { model: "model-a", provider: "provider-a" },
          system: "First line\nSecond line",
        },
        reason: "initial",
      }),
      event("assistant/message", 4, {
        message: { content: [{ text: "Working", type: "text" }], role: "assistant" },
        step: 1,
        turn: 1,
      }),
      event("step/end", 5, { step: 1, turn: 1 }),
      event("step/start", 6, { step: 2, turn: 1 }),
      event("request/header", 7, {
        header: {
          config: { model: "model-b", provider: "provider-a" },
          system: "First line\nSecond line",
        },
        reason: "change",
      }),
      event("assistant/message", 8, {
        message: { content: [{ text: "Final answer", type: "text" }], role: "assistant" },
        step: 2,
        turn: 1,
      }),
      event("step/end", 9, { step: 2, turn: 1 }),
      event("turn/end", 10, { reason: { kind: "completed" }, turn: 1 }),
      event("turn/start", 11, { turn: 2 }),
      event("user/message", 12, {
        content: [{ text: "Second question", type: "text" }],
        id: "user-2",
        role: "user",
        source: { kind: "user" },
      }),
      event("step/start", 13, { step: 1, turn: 2 }),
      event("request/header", 14, {
        header: {
          config: { model: "model-b", provider: "provider-a" },
          system: "First line\nSecond line",
        },
        reason: "series",
      }),
      event("assistant/message", 15, {
        message: { content: [{ text: "Second answer", type: "text" }], role: "assistant" },
        step: 1,
        turn: 2,
      }),
      event("step/end", 16, { step: 1, turn: 2 }),
      event("turn/end", 17, { reason: { kind: "completed" }, turn: 2 }),
    ]);
    const backend = createBackend(testDsh);
    const projection = await backend.readSession(
      createAgentSessionRef({
        backendId: "local",
        driverId: "dsh",
        nativeSessionId: "system-prompts",
        sessionId: "system-prompts",
      }),
    );

    const systemEntries = projection.entries.filter(
      (entry) => entry.kind === "message" && entry.role === "system",
    );
    expect(systemEntries).toMatchObject([
      {
        content: [{ text: "First line\nSecond line", type: "text" }],
        scope: { runId: agentRunId("turn-1"), stepId: "1" },
      },
      {
        content: [{ text: "First line\nSecond line", type: "text" }],
        scope: { runId: agentRunId("turn-2"), stepId: "1" },
      },
    ]);
    expect(projection.entries.filter((entry) => entry.scope?.runId === "turn-1")).toHaveLength(4);
    expect(projection.entries.find((entry) => entry.id === "message-1-2")?.scope).toEqual({
      runId: agentRunId("turn-1"),
      stepId: "2",
    });
  });

  test("projects DSH interrupted assistant messages as canonical aborted entries", async () => {
    const interruptedMessage = {
      message: {
        content: [{ text: "The response was interrupted.", type: "text" }],
        role: "assistant",
      },
      interrupted: true,
      step: 1,
      turn: 1,
    };
    const testDsh = new TestDsh();
    testDsh.addPersistedSession("interrupted", [
      event("turn/start", 0, { turn: 1 }),
      event("assistant/message", 1, interruptedMessage),
      event("turn/end", 2, { reason: { kind: "aborted" }, turn: 1 }),
    ]);
    const backend = createBackend(testDsh);
    const ref = createAgentSessionRef({
      backendId: "local",
      driverId: "dsh",
      nativeSessionId: "interrupted",
      sessionId: "interrupted",
    });

    const projection = await backend.readSession(ref);

    expect(projection.entries).toMatchObject([
      {
        content: [{ text: "The response was interrupted.", type: "text" }],
        kind: "message",
        role: "assistant",
        stopReason: "aborted",
      },
    ]);
    expect(projection.entries[0]).not.toHaveProperty("interrupted");

    const liveRecord = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(liveRecord.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    testDsh.emit("created-session", event("assistant/message", 1, interruptedMessage));

    expect(events.find((native) => native.type === "entry.appended")).toMatchObject({
      payload: {
        entry: {
          kind: "message",
          role: "assistant",
          stopReason: "aborted",
        },
      },
    });
  });

  test("emits DSH tool input and execution state as distinct transient events", async () => {
    const testDsh = new TestDsh();
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    testDsh.emit("created-session", event("turn/start", 0, { turn: 1 }));
    testDsh.emit(
      "created-session",
      event("assistant/chunk", 1, {
        chunk: {
          argumentsDelta: '{"path":"/workspace/demo.ts"}',
          id: "tool-1",
          index: 2,
          name: "read",
          type: "tool-call-delta",
        },
        step: 1,
        turn: 1,
      }),
    );
    testDsh.emit(
      "created-session",
      event("tool/call", 2, {
        arguments: '{"path":"/workspace/demo.ts"}',
        callId: "tool-1",
        name: "read",
        step: 1,
        turn: 1,
      }),
    );
    testDsh.emit(
      "created-session",
      event("tool/result", 3, {
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
    );

    expect(events.filter((native) => native.type === "entry.delta")).toMatchObject([
      {
        payload: {
          blockIndex: 2,
          delta: '{"path":"/workspace/demo.ts"}',
          entryId: "tool-tool-1",
          part: "tool_input",
        },
      },
    ]);
    expect(events.filter((native) => native.type === "tool.state.changed")).toMatchObject([
      { payload: { tool: { callId: "tool-1", name: "read", status: "pending" } } },
      {
        payload: {
          tool: {
            callId: "tool-1",
            input: { path: "/workspace/demo.ts" },
            name: "read",
            status: "running",
          },
        },
      },
      {
        payload: {
          tool: {
            callId: "tool-1",
            content: [{ text: "contents", type: "text" }],
            status: "success",
          },
        },
      },
    ]);
    expect(events.map((native) => native.type).slice(-2)).toEqual([
      "tool.state.changed",
      "entry.appended",
    ]);
    expect(events.find((native) => native.type === "entry.appended")).toMatchObject({
      payload: { settlesEntryId: "tool-tool-1" },
    });
  });

  test("coalesces contiguous DSH deltas before assigning public chunk sequences", async () => {
    const testDsh = new TestDsh();
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    testDsh.emit("created-session", event("turn/start", 0, { turn: 1 }));
    testDsh.emit(
      "created-session",
      event("assistant/chunk", 1, {
        chunk: { index: 0, text: "a", type: "text-delta" },
        step: 1,
        turn: 1,
      }),
    );
    testDsh.emit(
      "created-session",
      event("assistant/chunk", 2, {
        chunk: { index: 0, text: "b", type: "text-delta" },
        step: 1,
        turn: 1,
      }),
    );

    expect(events.filter((native) => native.type === "entry.delta")).toEqual([]);

    testDsh.emit(
      "created-session",
      event("assistant/message", 3, {
        message: {
          content: [{ text: "ab", type: "text" }],
          role: "assistant",
        },
        step: 1,
        turn: 1,
      }),
    );
    testDsh.emit(
      "created-session",
      event("assistant/chunk", 4, {
        chunk: { index: 0, text: "c", type: "text-delta" },
        step: 1,
        turn: 1,
      }),
    );
    testDsh.emit(
      "created-session",
      event("turn/end", 5, { reason: { kind: "completed" }, turn: 1 }),
    );

    expect(events.filter((native) => native.type === "entry.delta")).toMatchObject([
      { payload: { chunkSeq: 1, delta: "ab", entryId: "message-1-1" } },
      { payload: { chunkSeq: 2, delta: "c", entryId: "message-1-1" } },
    ]);

    await backend.close();
  });

  test("flushes a pending delta before disconnect and keeps its sequence across reconnect", async () => {
    const testDsh = new TestDsh();
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    testDsh.emit("created-session", event("turn/start", 0, { turn: 1 }));
    testDsh.emit(
      "created-session",
      event("assistant/chunk", 1, {
        chunk: { index: 0, text: "a", type: "text-delta" },
        step: 1,
        turn: 1,
      }),
    );
    expect(events.filter((native) => native.type === "entry.delta")).toEqual([]);

    await runtime.close();
    expect(events.filter((native) => native.type === "entry.delta")).toMatchObject([
      { payload: { chunkSeq: 1, delta: "a" } },
    ]);

    const reconnected = await backend.connectRuntime(record.ref);
    const reconnectEvents: AgentSessionEvent[] = [];
    reconnected.subscribe((native) => reconnectEvents.push(native));
    testDsh.emit(
      "created-session",
      event("assistant/chunk", 2, {
        chunk: { index: 0, text: "b", type: "text-delta" },
        step: 1,
        turn: 1,
      }),
    );
    testDsh.emit(
      "created-session",
      event("turn/end", 3, { reason: { kind: "completed" }, turn: 1 }),
    );

    expect(reconnectEvents.filter((native) => native.type === "entry.delta")).toMatchObject([
      { payload: { chunkSeq: 2, delta: "b" } },
    ]);

    await backend.close();
  });

  test("maps active DSH lifecycle records to canonical run activity", async () => {
    const testDsh = new TestDsh();
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    testDsh.emit("created-session", event("turn/start", 0, { turn: 1 }));
    testDsh.emit("created-session", event("step/start", 1, { step: 1, turn: 1 }));
    testDsh.emit("created-session", event("assistant/chunk", 2, { step: 1, turn: 1 }));
    testDsh.emit("created-session", event("llm/retry-started", 3, { retry: 1, step: 1, turn: 1 }));
    testDsh.emit(
      "created-session",
      event("llm/retry", 4, { delayMs: 250, maxRetries: 3, retry: 2, step: 1, turn: 1 }),
    );
    testDsh.emit(
      "created-session",
      event("compaction/start", 5, { compactionId: "compact-1", turn: 1 }),
    );
    testDsh.emit(
      "created-session",
      event("compaction/start", 6, { compactionId: "compact-standalone", turn: null }),
    );
    testDsh.emit(
      "created-session",
      event("compaction/start", 7, { compactionId: "compact-other-turn", turn: 2 }),
    );
    testDsh.emit(
      "created-session",
      event("turn/end", 8, { reason: { kind: "completed" }, turn: 1 }),
    );
    testDsh.emit(
      "created-session",
      event("compaction/start", 9, { compactionId: "compact-after-end", turn: 1 }),
    );

    expect(events.filter((native) => native.type === "run.activity")).toMatchObject([
      { payload: { kind: "thinking", runId: "turn-1" } },
      { payload: { kind: "thinking", runId: "turn-1" } },
      {
        payload: {
          detail: "Retry 2/3 · waiting 250ms",
          kind: "retry",
          runId: "turn-1",
        },
      },
      { payload: { kind: "summarizing", runId: "turn-1" } },
    ]);
    expect(events.filter((native) => native.type === "run.activity")).toHaveLength(4);
    expect(
      events.some(
        (native) =>
          native.type === "run.activity" && native.source.nativeType === "assistant/chunk",
      ),
    ).toBe(false);

    await backend.close();
  });

  test("reports malformed DSH activity payloads without publishing activity", async () => {
    const errors: string[] = [];
    const testDsh = new TestDsh();
    const backend = createBackend(
      testDsh,
      undefined,
      () => FIXED_TIME,
      undefined,
      (error) => errors.push(error.code),
    );
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    testDsh.emit("created-session", event("turn/start", 0, { turn: 1 }));
    testDsh.emit("created-session", event("step/start", 1, { step: 0, turn: 1 }));

    expect(errors).toContain("protocol");
    expect(events.filter((native) => native.type === "run.activity")).toEqual([]);
    await backend.close();
  });

  test("answers alpha approval waterfalls and keeps pending state across runtime reconnect", async () => {
    const testDsh = new TestDsh(true);
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    const result = testDsh.requestApproval("read");
    await waitFor(() => pendingPermissionIds(events).length === 1);
    const requestId = pendingPermissionIds(events)[0]!;
    await runtime.close();
    const reconnected = await backend.connectRuntime(record.ref);
    const reconnectEvents: AgentSessionEvent[] = [];
    reconnected.subscribe((native) => reconnectEvents.push(native));
    expect(pendingPermissionIds(reconnectEvents)).toEqual([requestId]);

    await expect(
      reconnected.respondPermission({ requestId, optionId: "allow_once" }),
    ).resolves.toEqual({ accepted: true });
    await expect(result).resolves.toBe("allowed-once");
    await expect(
      reconnected.respondPermission({ requestId, optionId: "allow_once" }),
    ).resolves.toEqual({ accepted: false });
    await backend.close();
  });

  test("answers alpha question waterfalls with opaque option ids and cancellation errors", async () => {
    const testDsh = new TestDsh(true);
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));
    const result = testDsh.requestQuestion(questionRequest());
    await waitFor(() => pendingQuestions(events).length === 1);
    const request = pendingQuestions(events)[0]!;
    expect(request.questions[0]?.intent?.approveOptionId).toBe("dsh-option-0-0");
    await expect(
      runtime.respondQuestion({
        requestId: request.requestId,
        response: {
          answers: [
            { optionIds: ["dsh-option-1-0", "dsh-option-1-1"], questionId: "format" },
            { optionIds: ["dsh-option-0-0"], questionId: "plan-review" },
          ],
          kind: "answered",
        },
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(result).resolves.toEqual({
      answers: [
        { id: "plan-review", selected: ["Approve"] },
        { id: "format", selected: ["JSON", "Markdown"] },
      ],
    });

    const cancelled = testDsh.requestQuestion(questionRequest());
    await waitFor(() => pendingQuestions(events).length === 1);
    const cancelledId = pendingQuestions(events)[0]!.requestId;
    await runtime.respondQuestion({ requestId: cancelledId, response: { kind: "cancelled" } });
    await expect(cancelled).rejects.toMatchObject({ code: "ASK_CANCELLED" });
    await backend.close();
  });

  test("delegates pending alpha interactions when the last Orbis connection disappears", async () => {
    const testDsh = new TestDsh(true);
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    const approval = testDsh.requestApproval("delete");
    const question = testDsh.requestQuestion(questionRequest());
    await waitFor(
      () => pendingPermissionIds(events).length === 1 && pendingQuestions(events).length === 1,
    );
    testDsh.setInteractionAvailable(false);
    await expect(approval).resolves.toBe("rejected");
    await expect(question).resolves.toEqual({ answers: [] });
    expect(testDsh.delegatedApprovals).toBe(1);
    expect(testDsh.delegatedQuestions).toBe(1);
    await waitFor(
      () => pendingPermissionIds(events).length === 0 && pendingQuestions(events).length === 0,
    );
    await backend.close();
  });

  test("claims interactions only for sessions with live Orbis availability", async () => {
    const testDsh = new TestDsh(true);
    testDsh.addPersistedSession("session-a", []);
    testDsh.addPersistedSession("session-b", []);
    const backend = createBackend(testDsh);
    const ref = (sessionId: string) =>
      createAgentSessionRef({
        backendId: backend.descriptor.id,
        driverId: agentDriverId("dsh"),
        nativeSessionId: sessionId,
        sessionId,
      });
    const runtimeA = await backend.connectRuntime(ref("session-a"));
    const runtimeB = await backend.connectRuntime(ref("session-b"));
    const eventsA: AgentSessionEvent[] = [];
    const eventsB: AgentSessionEvent[] = [];
    runtimeA.subscribe((native) => eventsA.push(native));
    runtimeB.subscribe((native) => eventsB.push(native));

    testDsh.setInteractionAvailable(false, "session-b");
    const approvalA = testDsh.requestApproval("read", { sessionId: "session-a" });
    await waitFor(() => pendingPermissionIds(eventsA).length === 1);

    // B is unavailable, so its request goes straight to the next handler and
    // cannot affect A's pending interaction.
    await expect(testDsh.requestApproval("write", { sessionId: "session-b" })).resolves.toBe(
      "rejected",
    );
    expect(testDsh.delegatedApprovals).toBe(1);
    expect(pendingPermissionIds(eventsA)).toHaveLength(1);
    expect(pendingPermissionIds(eventsB)).toEqual([]);

    // Losing A's final subscriber delegates only A's pending request.
    testDsh.setInteractionAvailable(false, "session-a");
    await expect(approvalA).resolves.toBe("rejected");
    expect(testDsh.delegatedApprovals).toBe(2);
    await waitFor(() => pendingPermissionIds(eventsA).length === 0);
    await runtimeA.close();
    await runtimeB.close();
    await backend.close();
  });

  test("folds DSH mode, goal tombstones, and whole todo snapshots", async () => {
    const testDsh = new TestDsh();
    testDsh.addPersistedSession("work-state", [
      event("plan/mode", 0, { active: true }),
      event("goal/change", 1, {
        createdAt: EPOCH,
        goal: {
          id: "goal-1",
          maxGoalRounds: 3,
          objective: "Ship the public bridge",
          phase: "active",
          revision: 1,
        },
        kind: "goal/change",
        operation: "create",
        roundsStarted: 0,
        updatedAt: EPOCH,
        version: 1,
      }),
      event("todo/write", 2, {
        todos: [
          { content: "Implement adapter", status: "in_progress" },
          { content: "Add tests", status: "pending" },
        ],
      }),
      event("turn/start", 3, { turn: 1 }),
      event("turn/end", 4, { reason: { kind: "completed" }, turn: 1 }),
      event("todo/write", 5, { todos: [{ content: "Implement adapter", status: "completed" }] }),
      event("turn/start", 6, { turn: 2 }),
      event("goal/change", 7, {
        createdAt: EPOCH,
        goal: {
          id: "goal-1",
          maxGoalRounds: 3,
          objective: "Ship the public bridge",
          phase: "complete",
          revision: 2,
        },
        kind: "goal/change",
        operation: "complete",
        roundsStarted: 1,
        updatedAt: EPOCH + 1_000,
        version: 1,
      }),
      event("goal/change", 8, {
        cleared: { id: "goal-1", revision: 3 },
        clearedAt: EPOCH + 2_000,
        kind: "goal/change",
        operation: "clear",
        version: 1,
      }),
      event("plan/mode", 9, { active: false }),
    ]);
    const backend = createBackend(testDsh);
    const projection = await backend.readSession(
      createAgentSessionRef({
        backendId: "local",
        driverId: "dsh",
        nativeSessionId: "work-state",
        sessionId: "work-state",
      }),
    );
    expect(projection.mode).toBeNull();
    expect(projection.workState).toEqual({ goal: null, todos: [] });
    await backend.close();
  });

  test("publishes committed plan mode and leaves queued selection authoritative", async () => {
    const testDsh = new TestDsh();
    const planMode: DshSessionModeProvider = {
      get: (agent) => {
        const latest = agent.session.events.at(-1);
        return {
          active:
            latest?.type === "plan/mode" &&
            (latest.data as { readonly active?: boolean }).active === true,
        };
      },
      set: (agent, active) => {
        if (agent.status === "running") return "queued";
        testDsh.emit(
          "created-session",
          event("plan/mode", agent.session.events.length + 1, { active }),
        );
        return "committed";
      },
    };
    const backend = createBackend(testDsh, undefined, () => FIXED_TIME, planMode);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    expect((await backend.listDrivers())[0]?.capabilities).toContain("plan.select");
    const runtime = await backend.connectRuntime(record.ref);
    const before = await backend.readStateRevision(record.ref);
    await expect(
      backend.updateSession(record.ref, { patch: { mode: "plan" }, expectedRevision: before }),
    ).resolves.toEqual({ revision: before + 1 });
    await expect(backend.readSession(record.ref)).resolves.toMatchObject({ mode: "plan" });

    await runtime.prompt({ content: [{ text: "Start the run", type: "text" }] });
    const queuedRevision = await backend.readStateRevision(record.ref);
    await expect(
      backend.updateSession(record.ref, {
        patch: { mode: null },
        expectedRevision: queuedRevision,
      }),
    ).resolves.toEqual({ revision: queuedRevision });
    await expect(backend.readSession(record.ref)).resolves.toMatchObject({ mode: "plan" });
    await expectCode(
      () => backend.updateSession(record.ref, { patch: { mode: "interactive" } }),
      "invalid_argument",
    );
    await backend.close();
  });

  test("does not advertise plan.select without the plan-mode seam", async () => {
    const backend = createBackend(new TestDsh());
    expect((await backend.listDrivers())[0]?.capabilities).not.toContain("plan.select");
    await backend.close();
  });

  test("keeps a pending approval visible when native DSH cancel fails", async () => {
    const testDsh = new TestDsh(true);
    const upstreamErrors: unknown[] = [];
    const backend = createBackend(
      testDsh,
      undefined,
      () => FIXED_TIME,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (error) => upstreamErrors.push(error),
    );
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    await runtime.prompt({ content: [{ text: "Start a run", type: "text" }] });
    const approval = testDsh.requestApproval("delete");
    await waitFor(() => pendingPermissionIds(events).length === 1);
    const requestId = pendingPermissionIds(events)[0]!;
    testDsh.agent("created-session").cancelFailure = true;

    await expectCode(() => runtime.cancel(), "unavailable");
    await expect(backend.readSession(record.ref)).resolves.toMatchObject({
      pendingPermissions: [{ requestId }],
    });
    expect(upstreamErrors).toHaveLength(1);
    expect(upstreamErrors[0]).toMatchObject({ message: "cancel failed" });

    await backend.close();
    await expect(approval).resolves.toBe("rejected");
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

    const receipt = await firstRuntime.prompt({
      content: [{ text: "Keep running", type: "text" }],
    });
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
    testDsh.currentPreset = "coding";
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
      model: { modelId: "test-model", provider: "test-provider", thinkingLevel: "max" },
      workspaceRef: "workspace-1",
    });
    expect(testDsh.sessionCreateCalls).toEqual([
      {
        sessionId: "created-session",
        workspaceId: "workspace-1",
      },
    ]);
    expect(testDsh.createCalls).toHaveLength(0);
    expect(testDsh.sessions.get("created-session")?.header.agentPreset).toBe("coding");
    expect(testDsh.selectedModels.get("created-session")).toEqual({
      model: "test-model",
      provider: "test-provider",
      reasoningEffort: "max",
    });
    expect(testDsh.attachedSessions).toEqual(["created-session"]);

    const runtime = await backend.connectRuntime(record.ref);
    await expectCode(
      () =>
        runtime.prompt({
          content: [{ text: "Queued before a run", type: "text" }],
          delivery: "follow_up",
        }),
      "conflict",
    );
    expect(testDsh.agent("created-session").followups).toHaveLength(0);

    await runtime.prompt({ content: [{ text: "Start", type: "text" }] });
    const queued = await runtime.prompt({
      content: [{ text: "Change direction", type: "text" }],
      delivery: "steer",
    });
    expect(String(queued.runId)).toBe("turn-1");
    expect(testDsh.agent("created-session").steers).toHaveLength(1);
    expect(await runtime.cancel({ keepInbox: true })).toEqual({ cancelled: true });
    expect(testDsh.agent("created-session").cancelCalls).toEqual([{ keepInbox: true }]);
  });

  test("reports a structured DSH session-create failure before public error mapping", async () => {
    const testDsh = new TestDsh();
    testDsh.sessionCreateFailure = true;
    const upstreamErrors: unknown[] = [];
    const backend = createBackend(
      testDsh,
      undefined,
      () => FIXED_TIME,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (error) => upstreamErrors.push(error),
    );

    await expectCode(
      () =>
        backend.createSession({
          driverId: agentDriverId("dsh"),
          workspaceRef: "workspace-1",
        }),
      "not_found",
    );
    expect(upstreamErrors[0]).toMatchObject({
      failure: { code: "workspace-not-found", message: "missing workspace" },
      message: "missing workspace",
    });

    await backend.close();
  });

  test("reopens persisted sessions through DSH's preset-aware session gateway", async () => {
    const testDsh = new TestDsh();
    testDsh.currentPreset = "coding";
    testDsh.addPersistedSession("review-session", [], "review");
    const backend = createBackend(testDsh);
    const ref = createAgentSessionRef({
      backendId: "local",
      driverId: "dsh",
      nativeSessionId: "review-session",
      sessionId: "review-session",
    });

    await backend.connectRuntime(ref);

    expect(testDsh.sessionCreateCalls).toEqual([
      { cwd: "/workspace/demo", sessionId: "review-session" },
    ]);
    expect(testDsh.agent("review-session").session.header.agentPreset).toBe("review");
    expect(testDsh.createCalls).toHaveLength(0);
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
