import {
  agentDriverId,
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
  DshApiInteractionResponse,
  DshApiMuxRequest,
  DshContext,
  DshImageAttachmentReference,
  DshSession,
  DshSessionCatalogEntry,
  DshSessionAttachmentPort,
  DshSessionEvent,
  DshSessionHeader,
  DshSessionModeProvider,
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
  readonly approvalResponses: DshApiInteractionResponse[] = [];
  approvalResponse: {
    readonly accepted: boolean;
    readonly reason?: "not-pending" | "bad-response";
  } = { accepted: true };
  readonly sessions = new Map<string, TestSession>();
  currentPreset = "standard";

  private readonly listeners = new Set<(session: DshSession, native: DshSessionEvent) => void>();
  private readonly inboxListeners = new Map<string, Set<(event: DshAgentInboxEvent) => void>>();
  private readonly materialized = new Set<string>();

  constructor(readonly approvals = false) {
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
          create: async ({ payload, rpcId }) => {
            this.sessionCreateCalls.push(payload);
            const id = String(payload.sessionId);
            const workspace =
              payload.workspaceId === undefined
                ? undefined
                : this.context.workspace.get(String(payload.workspaceId) as never);
            if (payload.workspaceId !== undefined && workspace === undefined) {
              return {
                result: {
                  error: { code: "workspace-not-found", message: "missing workspace" },
                  ok: false as const,
                },
                rpcId,
              };
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
            return {
              result: {
                ok: true as const,
                value: { agentPreset: session.header.agentPreset, sessionId: id },
              },
              rpcId,
            };
          },
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
            const selected = {
              model: payload.model,
              provider: payload.provider,
              ...(payload.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: payload.reasoningEffort }),
            };
            this.selectedModels.set(id, selected);
            return { result: { ok: true as const, value: { selected } }, rpcId };
          },
        },
        ...(this.approvals
          ? {
              events: {
                mux: (_request: unknown, signal: AbortSignal) => this.approvalMux(signal),
              },
              respond: async (message: DshApiInteractionResponse) => {
                this.approvalResponses.push(message);
                return this.approvalResponse;
              },
            }
          : {}),
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

  private readonly approvalWaiters: Array<(request: DshApiMuxRequest | undefined) => void> = [];
  private readonly approvalQueue: DshApiMuxRequest[] = [];

  emitApproval(request: DshApiMuxRequest): void {
    const waiter = this.approvalWaiters.shift();
    if (waiter === undefined) this.approvalQueue.push(request);
    else waiter(request);
  }

  private async *approvalMux(signal: AbortSignal): AsyncIterable<DshApiMuxRequest> {
    while (!signal.aborted) {
      const request = await new Promise<DshApiMuxRequest | undefined>((resolve) => {
        if (signal.aborted) {
          resolve(undefined);
          return;
        }
        const queued = this.approvalQueue.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const abort = () => {
          signal.removeEventListener("abort", abort);
          resolve(undefined);
        };
        signal.addEventListener("abort", abort, { once: true });
        this.approvalWaiters.push((value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        });
      });
      if (request === undefined) return;
      yield request;
    }
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
    ...(planMode === undefined ? {} : { planMode }),
    ...(onError === undefined ? {} : { onError }),
    ...(attachments === undefined ? {} : { attachments }),
    ...(subagents === undefined ? {} : { subagents }),
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

function approvalRequested(approvalId: string, toolName: string): DshApiMuxRequest {
  return {
    payload: {
      approvalId,
      callId: `call-${approvalId}`,
      reason: "line one\nline two",
      sessionId: "created-session",
      toolName,
      type: "approval/requested",
    },
    rpcId: `rpc-${approvalId}`,
  };
}

function questionRequested(rpcId: string): DshApiMuxRequest {
  return {
    payload: {
      questions: [
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
      ],
      sessionId: "created-session",
      type: "question/requested",
    },
    rpcId,
  };
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

  test("bridges permission interactions, responses, resolution, and reconnect state", async () => {
    const testDsh = new TestDsh(true);
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    testDsh.emitApproval(approvalRequested("approval-1", "read"));
    testDsh.emitApproval(approvalRequested("approval-2", "write"));
    await waitFor(() => pendingPermissionIds(events).join(",") === "approval-1,approval-2");

    await expect(
      runtime.respondPermission({ requestId: "approval-1", optionId: "allow_once" }),
    ).resolves.toEqual({ accepted: true });
    expect(testDsh.approvalResponses).toMatchObject([
      {
        result: {
          ok: true,
          value: {
            approvalId: "approval-1",
            outcome: "allowed-once",
            sessionId: "created-session",
          },
        },
        rpcId: "rpc-approval-1",
      },
    ]);
    await waitFor(() => pendingPermissionIds(events).join(",") === "approval-2");

    await expect(
      runtime.respondPermission({ requestId: "approval-1", optionId: "allow_once" }),
    ).resolves.toEqual({ accepted: false });

    testDsh.emitApproval(approvalRequested("approval-3", "copy"));
    await waitFor(() => pendingPermissionIds(events).join(",") === "approval-2,approval-3");
    testDsh.emitApproval({
      payload: {
        approvalId: "approval-2",
        sessionId: "created-session",
        type: "approval/resolved",
      },
      rpcId: "rpc-resolved-2",
    });
    await waitFor(() => pendingPermissionIds(events).join(",") === "approval-3");

    await runtime.close();
    const reconnected = await backend.connectRuntime(record.ref);
    const reconnectEvents: AgentSessionEvent[] = [];
    reconnected.subscribe((native) => reconnectEvents.push(native));
    expect(pendingPermissionIds(reconnectEvents)).toEqual(["approval-3"]);

    await backend.close();
  });

  test("settles DSH approval races without leaving stale pending requests", async () => {
    const testDsh = new TestDsh(true);
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    testDsh.emitApproval(approvalRequested("approval-race", "read"));
    await waitFor(() => pendingPermissionIds(events).join(",") === "approval-race");
    testDsh.approvalResponse = { accepted: false, reason: "not-pending" };
    await expect(
      runtime.respondPermission({ requestId: "approval-race", optionId: "allow_once" }),
    ).resolves.toEqual({ accepted: false });
    await waitFor(() => pendingPermissionIds(events).length === 0);

    testDsh.emitApproval(approvalRequested("approval-bad", "write"));
    await waitFor(() => pendingPermissionIds(events).join(",") === "approval-bad");
    testDsh.approvalResponse = { accepted: false, reason: "bad-response" };
    await expectCode(
      () => runtime.respondPermission({ requestId: "approval-bad", optionId: "allow_once" }),
      "protocol",
    );
    expect(pendingPermissionIds(events)).toEqual(["approval-bad"]);

    await backend.close();
  });

  test("bridges a full Ask User batch with opaque option ids and reconnect replay", async () => {
    const testDsh = new TestDsh(true);
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    testDsh.emitApproval(questionRequested("question-rpc-1"));
    await waitFor(() => pendingQuestions(events).length === 1);
    const request = pendingQuestions(events)[0];
    expect(request?.requestId).toBe("question-rpc-1");
    expect(request?.questions[0]?.questionId).toBe("plan-review");
    expect(request?.questions[0]?.intent?.approveOptionId).toBe("dsh-option-0-0");
    expect(request?.questions[0]?.options.map((option) => option.label)).toEqual([
      "Approve",
      "Keep planning",
    ]);
    expect(request?.questions[0]?.options.map((option) => option.optionId)).not.toEqual([
      "Approve",
      "Keep planning",
    ]);
    const requestedAt = request?.requestedAt;

    await expect(
      runtime.respondQuestion({
        requestId: "question-rpc-1",
        response: {
          answers: [
            { optionIds: ["dsh-option-1-0", "dsh-option-1-1"], questionId: "format" },
            { optionIds: ["dsh-option-0-0"], questionId: "plan-review" },
          ],
          kind: "answered",
        },
      }),
    ).resolves.toEqual({ accepted: true });
    expect(testDsh.approvalResponses.at(-1)).toMatchObject({
      result: {
        ok: true,
        value: {
          answer: {
            answers: [
              { id: "plan-review", selected: ["Approve"] },
              { id: "format", selected: ["JSON", "Markdown"] },
            ],
          },
          sessionId: "created-session",
        },
      },
      rpcId: "question-rpc-1",
    });
    await waitFor(() => pendingQuestions(events).length === 0);

    testDsh.emitApproval(questionRequested("question-rpc-2"));
    await waitFor(() => pendingQuestions(events).length === 1);
    const beforeReconnect = pendingQuestions(events)[0]?.requestedAt;
    expect(beforeReconnect).toBe(requestedAt);
    await runtime.close();
    const reconnected = await backend.connectRuntime(record.ref);
    const reconnectEvents: AgentSessionEvent[] = [];
    reconnected.subscribe((native) => reconnectEvents.push(native));
    expect(pendingQuestions(reconnectEvents)[0]?.requestedAt).toBe(beforeReconnect);

    await expect(
      reconnected.respondQuestion({ requestId: "question-rpc-2", response: { kind: "cancelled" } }),
    ).resolves.toEqual({ accepted: true });
    expect(testDsh.approvalResponses.at(-1)).toMatchObject({
      result: { error: { code: "cancelled" }, ok: false },
      rpcId: "question-rpc-2",
    });
    await backend.close();
  });

  test("keeps a pending question after a bad native response receipt", async () => {
    const testDsh = new TestDsh(true);
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));
    testDsh.emitApproval(questionRequested("question-bad"));
    await waitFor(() => pendingQuestions(events).length === 1);
    testDsh.approvalResponse = { accepted: false, reason: "bad-response" };
    await expectCode(
      () =>
        runtime.respondQuestion({
          requestId: "question-bad",
          response: { kind: "cancelled" },
        }),
      "protocol",
    );
    expect(pendingQuestions(events)).toHaveLength(1);
    expect(pendingQuestions(events)[0]?.requestId).toBe("question-bad");
    await backend.close();
  });

  test("resolves a pending question from the shared interaction mux", async () => {
    const testDsh = new TestDsh(true);
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    testDsh.emitApproval(questionRequested("question-resolved"));
    await waitFor(() => pendingQuestions(events).length === 1);
    testDsh.emitApproval({
      payload: {
        questionRpcId: "question-resolved",
        sessionId: "created-session",
        type: "question/resolved",
      },
      rpcId: "question-resolution-receipt",
    });
    await waitFor(() => pendingQuestions(events).length === 0);
    await backend.close();
  });

  test("rejects interaction replays that change the native request payload", async () => {
    const errors: string[] = [];
    const testDsh = new TestDsh(true);
    const backend = createBackend(
      testDsh,
      undefined,
      () => FIXED_TIME,
      undefined,
      (error) => {
        errors.push(error.code);
      },
    );
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    const request = approvalRequested("approval-replay", "read");
    testDsh.emitApproval(request);
    await waitFor(() => pendingPermissionIds(events).join(",") === "approval-replay");
    testDsh.emitApproval({
      payload: { ...request.payload, reason: "changed" },
      rpcId: request.rpcId,
    });
    await waitFor(() => errors.includes("protocol"));
    expect(pendingPermissionIds(events)).toEqual(["approval-replay"]);
    await backend.close();
  });

  test("rejects a permission replay when its rpc id changes", async () => {
    const errors: string[] = [];
    const testDsh = new TestDsh(true);
    const backend = createBackend(
      testDsh,
      undefined,
      () => FIXED_TIME,
      undefined,
      (error) => {
        errors.push(error.code);
      },
    );
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    const request = approvalRequested("approval-rpc-replay", "read");
    testDsh.emitApproval(request);
    await waitFor(() => pendingPermissionIds(events).join(",") === "approval-rpc-replay");
    testDsh.emitApproval({ ...request, rpcId: "different-rpc-id" });
    await waitFor(() => errors.includes("protocol"));
    expect(pendingPermissionIds(events)).toEqual(["approval-rpc-replay"]);
    await backend.close();
  });

  test("rejects a question replay when its payload changes under one rpc id", async () => {
    const errors: string[] = [];
    const testDsh = new TestDsh(true);
    const backend = createBackend(
      testDsh,
      undefined,
      () => FIXED_TIME,
      undefined,
      (error) => {
        errors.push(error.code);
      },
    );
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    const request = questionRequested("question-payload-replay");
    testDsh.emitApproval(request);
    await waitFor(() => pendingQuestions(events).length === 1);
    testDsh.emitApproval({
      payload: {
        ...request.payload,
        questions: request.payload.questions?.map((question, index) =>
          index === 0 ? { ...question, question: "Changed after replay" } : question,
        ),
      },
      rpcId: request.rpcId,
    });
    await waitFor(() => errors.includes("protocol"));
    expect(pendingQuestions(events)[0]?.requestId).toBe("question-payload-replay");
    await backend.close();
  });

  test("rejects duplicate native option labels before exposing a question", async () => {
    const testDsh = new TestDsh(true);
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));
    testDsh.emitApproval({
      payload: {
        questions: [
          {
            id: "duplicate",
            options: [{ label: "same" }, { label: "same" }],
            question: "Invalid?",
          },
        ],
        sessionId: "created-session",
        type: "question/requested",
      },
      rpcId: "question-duplicate",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pendingQuestions(events)).toEqual([]);
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
      get: (agent) => ({
        active:
          agent.session.events.at(-1)?.type === "plan/mode" &&
          (agent.session.events.at(-1)?.data as { readonly active?: boolean }).active === true,
      }),
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
    await expect((await backend.listDrivers())[0]?.capabilities).not.toContain("plan.select");
    await backend.close();
  });

  test("keeps a pending approval visible when native DSH cancel fails", async () => {
    const testDsh = new TestDsh(true);
    const backend = createBackend(testDsh);
    const record = await backend.createSession({
      driverId: agentDriverId("dsh"),
      workspaceRef: "workspace-1",
    });
    const runtime = await backend.connectRuntime(record.ref);
    const events: AgentSessionEvent[] = [];
    runtime.subscribe((native) => events.push(native));

    await runtime.prompt({ content: [{ text: "Start a run", type: "text" }] });
    testDsh.emitApproval(approvalRequested("approval-cancel", "delete"));
    await waitFor(() => pendingPermissionIds(events).join(",") === "approval-cancel");
    testDsh.agent("created-session").cancelFailure = true;

    await expectCode(() => runtime.cancel(), "unavailable");
    await expect(backend.readSession(record.ref)).resolves.toMatchObject({
      pendingPermissions: [{ requestId: "approval-cancel" }],
    });
    expect(testDsh.approvalResponses).toHaveLength(0);

    await backend.close();
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
