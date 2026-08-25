import {
  AgentBackendError,
  agentBackendId,
  agentDeliveryCursor,
  agentDriverId,
  agentEntryId,
  agentEventId,
  agentRunId,
  agentTimestamp,
  type AgentPromptContentBlock,
  type AgentPromptReferenceCompletionInput,
  createAgentDriverDescriptor,
  createAgentSessionRef,
  type AgentJsonValue,
  type AgentSessionRef,
} from "@orbisapp/orbis-agent-backend";
import { OrbisTransportError, type JsonValue, type TransportEvent } from "@orbisapp/transport";
import { expect, test } from "vitest";

import {
  OrbisRemoteAgentV2Host,
  type RemoteAgentHostDeliveryTransport,
  type RemoteAgentHostPeer,
  type RemoteAgentV2Backend,
  type RemoteAgentV2HostEvent,
  type RemoteAgentV2HostStore,
  type RemoteAgentV2IdempotencyClaim,
  type RemoteAgentV2Runtime,
  type RemoteAgentV2QuestionRequest,
  type RemoteAgentV2SessionEvent,
  type RemoteAgentV2SessionSnapshot,
  type RemoteAgentV2SessionSummary,
  type RemoteAgentV2StoredEntryIndex,
  type RemoteAgentV2StoredSessionIndex,
} from "./index";
import { ORBIS_REMOTE_AGENT_V2_METHODS } from "./v2-constants";

const nativeRef = createAgentSessionRef({
  backendId: "native",
  driverId: "dsh",
  nativeSessionId: "session-a",
  sessionId: "session-a",
});
const publicRef = createAgentSessionRef({
  backendId: "remote:host-a",
  driverId: "dsh",
  nativeSessionId: "session-a",
  sessionId: "session-a",
});
const otherNativeRef = createAgentSessionRef({
  backendId: "native",
  driverId: "dsh",
  nativeSessionId: "session-b",
  sessionId: "session-b",
});
const otherPublicRef = createAgentSessionRef({
  backendId: "remote:host-a",
  driverId: "dsh",
  nativeSessionId: "session-b",
  sessionId: "session-b",
});
const peer = {
  deviceId: "device-a",
  deviceName: "Test Device",
  id: "peer-a",
  transportId: "transport-a",
};
const now = agentTimestamp("2026-08-11T00:00:00.000Z");

class MemoryStore implements RemoteAgentV2HostStore {
  hostRevision = "1";
  readonly idempotency = new Map<
    string,
    { kind: "pending" | "accepted"; result?: AgentJsonValue }
  >();
  index: RemoteAgentV2StoredSessionIndex | undefined;

  async bumpHostRevision(): Promise<string> {
    this.hostRevision = String(Number(this.hostRevision) + 1);
    return this.hostRevision;
  }

  async claimIdempotency(key: string): Promise<RemoteAgentV2IdempotencyClaim> {
    const current = this.idempotency.get(key);
    if (current?.kind === "accepted") return { kind: "accepted", result: current.result! };
    if (current?.kind === "pending") return { kind: "pending" };
    this.idempotency.set(key, { kind: "pending" });
    return { kind: "claimed" };
  }

  async completeIdempotency(key: string, result: AgentJsonValue): Promise<void> {
    this.idempotency.set(key, { kind: "accepted", result });
  }

  async initializeSession(ref: AgentSessionRef, entries: readonly RemoteAgentV2StoredEntryIndex[]) {
    this.index ??= { entries: [...entries], ref };
    return this.index;
  }

  async readHostRevision(): Promise<string> {
    return this.hostRevision;
  }

  async readSessionIndex(): Promise<RemoteAgentV2StoredSessionIndex | undefined> {
    return this.index;
  }

  async replaceSessionIndex(
    ref: AgentSessionRef,
    entries: readonly RemoteAgentV2StoredEntryIndex[],
  ) {
    this.index = { entries: [...entries], ref };
    return this.index;
  }
}

function entry(id: string): RemoteAgentV2SessionSnapshot["entries"][number] {
  return {
    content: [{ text: id, type: "text" }],
    createdAt: now,
    cursor: agentDeliveryCursor(0),
    id: agentEntryId(id),
    kind: "message",
    parentId: null,
    role: "assistant",
  };
}

function snapshot(
  entries: readonly RemoteAgentV2SessionSnapshot["entries"][number][],
  revision = entries.length,
  statePatch: Partial<RemoteAgentV2SessionSnapshot["state"]> = {},
): RemoteAgentV2SessionSnapshot {
  return {
    entries,
    state: {
      configOptions: [],
      createdAt: now,
      cwd: "/workspace",
      leafEntryId: entries.at(-1)?.id ?? null,
      mode: null,
      model: null,
      pendingInputs: [],
      pendingPermissions: [],
      pendingQuestions: [],
      ref: nativeRef,
      revision,
      runState: "idle",
      title: null,
      updatedAt: now,
      workspaceRef: "workspace-a",
      workState: { goal: null, todos: [] },
      ...statePatch,
    },
  };
}

function context(transportId = peer.transportId, maxResponseBytes = 1024 * 1024) {
  return {
    maxResponseBytes,
    peer: { ...peer, transportId },
    signal: new AbortController().signal,
  };
}

function presenceBackend(
  listeners: Set<(event: RemoteAgentV2SessionEvent) => void>,
  options: {
    readonly onPrompt?: (content: readonly AgentPromptContentBlock[]) => void;
    readonly readAttachment?: RemoteAgentV2Backend["readAttachment"];
  } = {},
): RemoteAgentV2Backend {
  const runtime: RemoteAgentV2Runtime = {
    cancel: async () => ({ cancelled: false }),
    close: async () => undefined,
    prompt: async (input) => {
      options.onPrompt?.(input.content);
      return { acceptedAt: now, queued: false, runId: agentRunId("run-1") };
    },
    respondPermission: async () => ({ accepted: true }),
    respondQuestion: async () => ({ accepted: true }),
    ref: nativeRef,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    browseWorkspaceFolders: async () => ({
      breadcrumbs: [],
      current: null,
      entries: [],
      truncated: false,
    }),
    close: async () => undefined,
    completePromptReferences: async () => undefined,
    connectRuntime: async () => runtime,
    createSession: async () => {
      throw new Error("unused");
    },
    createWorkspaceFolder: async () => {
      throw new Error("unused");
    },
    hostId: agentBackendId("native"),
    listDrivers: async () => [],
    listModels: async () => [],
    listSessions: async () => [],
    listSessionSubagents: async () => [],
    listWorkspaces: async () => [],
    readSession: async () => snapshot([]),
    readAttachment:
      options.readAttachment ??
      (async () => {
        throw new Error("unused");
      }),
    registerWorkspace: async () => {
      throw new Error("unused");
    },
    updateSession: async () => undefined,
  };
}

function sessionEventFromTransport(event: TransportEvent): RemoteAgentV2SessionEvent | undefined {
  const payload = event.payload as { readonly event?: unknown };
  return typeof payload.event === "object" && payload.event !== null
    ? (payload.event as RemoteAgentV2SessionEvent)
    : undefined;
}

function params(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

test("v2 host completes draft workspace references without a session owner", async () => {
  const listeners = new Set<(event: RemoteAgentV2SessionEvent) => void>();
  let received: AgentPromptReferenceCompletionInput | undefined;
  const backend: RemoteAgentV2Backend = {
    ...presenceBackend(listeners),
    completePromptReferences: async (input) => {
      received = input;
      return { candidates: [], end: 1, start: 0 };
    },
    listDrivers: async () => [
      createAgentDriverDescriptor({
        capabilities: ["prompt.references.files"],
        displayName: "DSH",
        id: "dsh",
        promptReferenceSyntax: "at-token",
      }),
    ],
  };
  const host = new OrbisRemoteAgentV2Host({
    backend,
    backendId: "remote:host-a",
    store: new MemoryStore(),
    transport: { send: async () => undefined },
  });
  try {
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test", platform: "node" }, supportedVersions: [2] },
      context(),
    );
    await expect(
      host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.promptReferencesFiles,
        {
          cursor: 1,
          driverId: "dsh",
          limit: 4,
          source: "files",
          text: "@",
          workspaceRef: "workspace-a",
        },
        context(),
      ),
    ).resolves.toEqual({ candidates: [], end: 1, start: 0 });
    expect(received).toMatchObject({
      driverId: "dsh",
      source: "files",
      workspaceRef: "workspace-a",
    });
    expect(received === undefined ? true : "ref" in received).toBe(false);
  } finally {
    await host.close();
  }
});

test("v2 host replays native entries from its cursor index without ACK state", async () => {
  const store = new MemoryStore();
  let current = snapshot([]);
  const runtimeListeners = new Set<(event: RemoteAgentV2SessionEvent) => void>();
  let prompts = 0;
  let permissionResponses = 0;
  let updates = 0;
  const runtime: RemoteAgentV2Runtime = {
    cancel: async () => ({ cancelled: false }),
    close: async () => undefined,
    prompt: async () => {
      prompts += 1;
      return { acceptedAt: now, queued: false, runId: agentRunId("run-1") };
    },
    respondPermission: async (input) => {
      permissionResponses += 1;
      expect(input).toMatchObject({ optionId: "allow-once", requestId: "permission-1" });
      return { accepted: true };
    },
    respondQuestion: async () => ({ accepted: true }),
    ref: nativeRef,
    subscribe: (listener) => {
      runtimeListeners.add(listener);
      return () => {
        runtimeListeners.delete(listener);
      };
    },
  };
  const backend: RemoteAgentV2Backend = {
    browseWorkspaceFolders: async () => ({
      breadcrumbs: [],
      current: null,
      entries: [],
      truncated: false,
    }),
    close: async () => undefined,
    completePromptReferences: async () => undefined,
    connectRuntime: async () => runtime,
    createSession: async () => ({
      createdAt: now,
      driverId: agentDriverId("dsh"),
      ref: otherNativeRef,
      runState: "idle" as const,
      title: null,
      updatedAt: now,
    }),
    createWorkspaceFolder: async () => ({
      displayName: "New Folder",
      hidden: false,
      ref: "folder-new",
      selectable: true,
    }),
    hostId: agentBackendId("native"),
    listDrivers: async () => [
      createAgentDriverDescriptor({
        capabilities: [
          "model.select",
          "permission.respond",
          "plan.select",
          "question.respond",
          "session.subagents.list",
          "session.list",
          "workspace.open",
        ],
        displayName: "DSH",
        id: "dsh",
      }),
    ],
    listModels: async () => [],
    listWorkspaces: async () => [{ displayName: "Orbis", ref: "workspace-a" }],
    listSessions: async () => [
      {
        driverId: agentDriverId("dsh"),
        ref: nativeRef,
        runState: "idle",
        title: null,
        updatedAt: now,
      },
      {
        driverId: agentDriverId("dsh"),
        ref: otherNativeRef,
        runState: "idle",
        title: null,
        updatedAt: agentTimestamp("2026-08-11T00:00:01.000Z"),
      },
    ],
    listSessionSubagents: async (ref) => {
      const childRef = createAgentSessionRef({
        backendId: ref.backendId,
        driverId: ref.driverId,
        nativeSessionId: "session-a-child",
        sessionId: "session-a-child",
      });
      const diagnosticRef = createAgentSessionRef({
        backendId: ref.backendId,
        driverId: ref.driverId,
        nativeSessionId: "session-a-diagnostic",
        sessionId: "session-a-diagnostic",
      });
      return [
        {
          activity: "running" as const,
          depth: 1,
          hasChildren: true,
          kind: "child" as const,
          label: "Worker",
          mode: "continuable" as const,
          parentRef: ref,
          ref: childRef,
        },
        {
          depth: 2,
          kind: "diagnostic" as const,
          parentRef: childRef,
          reason: "unavailable" as const,
          ref: diagnosticRef,
        },
      ];
    },
    readSession: async () => current,
    readAttachment: async () => {
      throw new Error("unused");
    },
    registerWorkspace: async () => ({
      created: true,
      workspace: { displayName: "Orbis", ref: "workspace-a" },
    }),
    updateSession: async (_ref, patch) => {
      updates += 1;
      const revision = current.state.revision + 1;
      current = {
        ...current,
        state: {
          ...current.state,
          ...(patch.model === undefined ? {} : { model: patch.model }),
          revision,
        },
      };
      for (const listener of runtimeListeners) {
        listener({
          channel: "state",
          eventId: agentEventId(`model-update-${revision}`),
          occurredAt: now,
          patch: patch.model === undefined ? {} : { model: patch.model },
          revision,
          sessionId: nativeRef.sessionId,
          source: { backendId: nativeRef.backendId, driverId: nativeRef.driverId },
          type: "session.state.changed",
        });
      }
    },
  };
  const sent: TransportEvent[] = [];
  const host = new OrbisRemoteAgentV2Host({
    backend,
    backendId: "remote:host-a",
    limits: { maxPromptBytes: 64 },
    store,
    transport: {
      send: async (_target, event) => {
        sent.push(event);
      },
    },
  });
  try {
    let protocolError: unknown;
    try {
      await host.handleRequest(ORBIS_REMOTE_AGENT_V2_METHODS.sessionsList, {}, context());
    } catch (error) {
      protocolError = error;
    }
    expect(protocolError).toMatchObject({ code: "protocol" });
    const hello = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test", platform: "node" }, supportedVersions: [2] },
      context(),
    );
    expect(hello).toMatchObject({ hostId: "remote:host-a", version: 2 });

    await expect(
      host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSubagentsList,
        params({ ref: publicRef }),
        context(),
      ),
    ).resolves.toEqual({
      entries: [
        expect.objectContaining({ depth: 1, kind: "child", parentRef: publicRef }),
        expect.objectContaining({ depth: 2, kind: "diagnostic" }),
      ],
    });

    expect(
      await host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.workspacesList,
        params({ driverId: "dsh" }),
        context(),
      ),
    ).toEqual({ workspaces: [{ displayName: "Orbis", ref: "workspace-a" }] });
    expect(
      await host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.workspacesBrowse,
        params({ driverId: "dsh" }),
        context(),
      ),
    ).toEqual({ breadcrumbs: [], current: null, entries: [], truncated: false });
    expect(
      await host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.workspacesCreateFolder,
        params({
          driverId: "dsh",
          idempotencyKey: "create-folder-1",
          name: "New Folder",
          parentFolderRef: "folder-a",
        }),
        context(),
      ),
    ).toEqual({
      displayName: "New Folder",
      hidden: false,
      ref: "folder-new",
      selectable: true,
    });
    expect(
      await host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.workspacesRegister,
        params({ driverId: "dsh", folderRef: "folder-a", idempotencyKey: "register-1" }),
        context(),
      ),
    ).toEqual({
      created: true,
      workspace: { displayName: "Orbis", ref: "workspace-a" },
    });

    let invalidPair: unknown;
    try {
      await host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
        params({ afterCursor: 0, afterEntryId: "entry-a", mode: "once", ref: publicRef }),
        context(),
      );
    } catch (error) {
      invalidPair = error;
    }
    expect(invalidPair).toMatchObject({ code: "invalid_argument" });

    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsCreate,
      params({ driverId: "dsh", idempotencyKey: "create-1" }),
      context(),
    );
    expect(sent[0]).toMatchObject({
      durability: "transient",
      payload: { event: { type: "host.session.added" }, scope: { kind: "host" } },
      sessionId: "host:remote:host-a",
    });

    const firstPage = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsList,
      params({ limit: 1 }),
      context(),
    );
    expect(firstPage).toMatchObject({ sessions: [{ ref: { sessionId: "session-b" } }] });
    const nextCursor = (firstPage as { nextCursor?: string }).nextCursor;
    expect(nextCursor).toEqual(expect.any(String));
    const secondPage = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsList,
      params({ cursor: nextCursor, limit: 1 }),
      context(),
    );
    expect(secondPage).toMatchObject({ sessions: [{ ref: { sessionId: "session-a" } }] });

    const baseline = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "live", ref: publicRef }),
      context(),
    );
    expect(baseline).toMatchObject({
      baseline: true,
      entries: [],
      hasMore: false,
      hasOlder: false,
      hostRevision: "1",
      oldestCursor: 0,
      throughCursor: 0,
    });

    const nextEntry = entry("entry-1");
    const burstEntry = entry("entry-2");
    current = snapshot([nextEntry, burstEntry]);
    const nativeEvent: RemoteAgentV2SessionEvent = {
      channel: "replayable",
      cursor: agentDeliveryCursor(0),
      entry: nextEntry,
      eventId: agentEventId("native-entry-1"),
      occurredAt: now,
      sessionId: nativeRef.sessionId,
      source: { backendId: nativeRef.backendId, driverId: nativeRef.driverId, nativeType: "test" },
      type: "entry.appended",
    };
    runtimeListeners.forEach((listener) => listener(nativeEvent));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(3);
    expect(sent[1]).toMatchObject({ durability: "durable", eventSeq: 1, type: "orbis.event" });
    expect(sent[2]).toMatchObject({
      durability: "durable",
      eventSeq: 2,
      payload: { event: { entry: { id: "entry-2" } } },
      type: "orbis.event",
    });

    runtimeListeners.forEach((listener) =>
      listener({
        channel: "transient",
        eventId: agentEventId("native-tool-state-1"),
        occurredAt: now,
        sessionId: nativeRef.sessionId,
        source: { backendId: nativeRef.backendId, driverId: nativeRef.driverId },
        tool: {
          callId: "call-1",
          entryId: agentEntryId("tool-call-1"),
          input: { path: "/workspace/demo.ts" },
          name: "read",
          status: "running",
        },
        type: "tool.state.changed",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(4);
    expect(sent[3]).toMatchObject({
      durability: "transient",
      payload: {
        event: {
          tool: { callId: "call-1", name: "read", status: "running" },
          type: "tool.state.changed",
        },
      },
      type: "orbis.event",
    });

    const replay = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ afterCursor: 0, afterEntryId: null, mode: "once", ref: publicRef }),
      context(),
    );
    expect(replay).toMatchObject({
      baseline: false,
      entries: [
        { cursor: 1, id: "entry-1" },
        { cursor: 2, id: "entry-2" },
      ],
      hasMore: false,
      hasOlder: false,
      oldestCursor: 1,
      throughCursor: 2,
    });
    // A continuation returns its entries inline; it must never push separate
    // entry.appended event frames the way the old replay shape did.
    expect(sent).toHaveLength(4);

    const older = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsEntries,
      params({ beforeCursor: 2, limit: 1, ref: publicRef }),
      context(),
    );
    expect(older).toMatchObject({
      entries: [{ id: "entry-1", cursor: 1 }],
      hasOlder: false,
    });

    const prompt = {
      content: [{ text: "hello", type: "text" }],
      idempotencyKey: "prompt-1",
      ref: publicRef,
    };
    let revisionConflict: unknown;
    try {
      await host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt,
        params({ ...prompt, expectedRevision: 0, idempotencyKey: "prompt-conflict" }),
        context(),
      );
    } catch (error) {
      revisionConflict = error;
    }
    expect(revisionConflict).toMatchObject({ serverCode: "revision_conflict" });
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt,
      params(prompt),
      context(),
    );
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt,
      params(prompt),
      context(),
    );
    expect(prompts).toBe(1);

    const permission = {
      idempotencyKey: "permission-1",
      optionId: "allow-once",
      ref: publicRef,
      requestId: "permission-1",
    };
    await expect(
      host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsRespondPermission,
        params(permission),
        context(),
      ),
    ).resolves.toEqual({ accepted: true });
    await expect(
      host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsRespondPermission,
        params(permission),
        context(),
      ),
    ).resolves.toEqual({ accepted: true });
    expect(permissionResponses).toBe(1);

    const pendingQuestion: RemoteAgentV2QuestionRequest = {
      questions: [
        {
          multiSelect: false,
          options: [{ label: "Approve", optionId: "approve" }],
          question: "Continue?",
          questionId: "question-item-1",
        },
      ],
      requestId: "question-1",
      requestedAt: now,
    };
    current = snapshot([nextEntry, burstEntry], 2, { pendingQuestions: [pendingQuestion] });
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "once", ref: publicRef }),
      context(),
    );
    await expect(
      host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsRespondQuestion,
        params({
          idempotencyKey: "question-invalid-option",
          ref: publicRef,
          requestId: "question-1",
          response: {
            answers: [{ optionIds: ["unknown"], questionId: "question-item-1" }],
            kind: "answered",
          },
        }),
        context(),
      ),
    ).rejects.toMatchObject({ code: "invalid_argument" });

    const question = {
      idempotencyKey: "question-cancel-1",
      ref: publicRef,
      requestId: "question-1",
      response: { kind: "cancelled" },
    };
    await expect(
      host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsRespondQuestion,
        params(question),
        context(),
      ),
    ).resolves.toEqual({ accepted: true });
    await expect(
      host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsRespondQuestion,
        params(question),
        context(),
      ),
    ).resolves.toEqual({ accepted: true });

    const retryablePrompt = {
      ...prompt,
      expectedRevision: 2,
      idempotencyKey: "prompt-retry-after-state-change",
    };
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt,
      params(retryablePrompt),
      context(),
    );
    current = snapshot([entry("replacement")], 3);
    const rebuilt = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "once", ref: publicRef }),
      context(),
    );
    expect(rebuilt).toMatchObject({ baseline: true, hasMore: false, hostRevision: "2" });
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt,
      params(retryablePrompt),
      context(),
    );
    expect(prompts).toBe(2);

    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test reconnect", platform: "node" }, supportedVersions: [2] },
      context("transport-b"),
    );
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt,
      params(prompt),
      context("transport-b"),
    );
    expect(prompts).toBe(2);

    let oversized: unknown;
    try {
      await host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt,
        params({
          ...prompt,
          content: [{ text: "x".repeat(128), type: "text" }],
          idempotencyKey: "prompt-oversized",
        }),
        context("transport-b"),
      );
    } catch (error) {
      oversized = error;
    }
    expect(oversized).toMatchObject({ code: "invalid_argument" });
    expect(prompts).toBe(2);

    const modelUpdate = {
      expectedRevision: 3,
      idempotencyKey: "model-update-1",
      patch: { model: { modelId: "model-b", provider: "provider-a" } },
      ref: publicRef,
    };
    const updateResult = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsUpdate,
      params(modelUpdate),
      context("transport-b"),
    );
    const duplicateUpdate = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsUpdate,
      params(modelUpdate),
      context("transport-b"),
    );
    expect(updateResult).toEqual({ revision: 4 });
    expect(duplicateUpdate).toEqual(updateResult);
    expect(updates).toBe(1);

    const largeEntries = Array.from({ length: 256 }, (_, index) => ({
      ...entry(`large-entry-${index}`),
      content: [{ text: `${index}:${"x".repeat(4_000)}`, type: "text" as const }],
    }));
    current = snapshot(largeEntries, 4);
    const snapshotBudget = 780_000;
    const pagedSnapshot = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "once", ref: publicRef }),
      context("transport-b", snapshotBudget),
    );
    const snapshotPage = pagedSnapshot as unknown as {
      entries: Array<{ cursor: number }>;
      hasOlder: boolean;
    };
    expect(snapshotPage.entries.length).toBeGreaterThan(0);
    expect(snapshotPage.entries.length).toBeLessThan(largeEntries.length);
    expect(snapshotPage.hasOlder).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(pagedSnapshot)).byteLength).toBeLessThanOrEqual(
      snapshotBudget,
    );

    const sentBeforeContinuationProbes = sent.length;

    const truncatedContinuationBudget = 20_000;
    const continuationPage = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ afterCursor: 0, afterEntryId: null, mode: "once", ref: publicRef }),
      context("transport-b", truncatedContinuationBudget),
    );
    const continuationEntries = (continuationPage as { entries: Array<{ cursor: number }> })
      .entries;
    expect(continuationEntries.length).toBeGreaterThan(0);
    expect(continuationEntries.length).toBeLessThan(largeEntries.length);
    // Cursors are dense: a continuation page must be a contiguous run starting
    // at afterCursor + 1, never sparse or offset.
    expect(continuationEntries.map((item) => item.cursor)).toEqual(
      Array.from({ length: continuationEntries.length }, (_, index) => index + 1),
    );
    expect(continuationPage).toMatchObject({
      baseline: false,
      hasMore: true,
      hasOlder: false,
      oldestCursor: 1,
      throughCursor: continuationEntries.at(-1)?.cursor,
    });
    expect(
      new TextEncoder().encode(JSON.stringify(continuationPage)).byteLength,
    ).toBeLessThanOrEqual(truncatedContinuationBudget);

    let continuationEntryTooLarge: unknown;
    try {
      await host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
        params({ afterCursor: 0, afterEntryId: null, mode: "once", ref: publicRef }),
        context("transport-b", 1_024),
      );
    } catch (error) {
      continuationEntryTooLarge = error;
    }
    expect(continuationEntryTooLarge).toMatchObject({ serverCode: "entry_too_large" });

    // Both continuation calls above return their entries inline; neither may
    // push separate entry.appended event frames the old replay shape did.
    expect(sent).toHaveLength(sentBeforeContinuationProbes);

    const historyBudget = 64_000;
    const historyPage = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsEntries,
      params({
        beforeCursor: snapshotPage.entries[0]?.cursor,
        limit: 256,
        ref: publicRef,
      }),
      context("transport-b", historyBudget),
    );
    expect(historyPage).toMatchObject({ hasOlder: true });
    expect(new TextEncoder().encode(JSON.stringify(historyPage)).byteLength).toBeLessThanOrEqual(
      historyBudget,
    );

    let entryTooLarge: unknown;
    try {
      await host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
        params({ mode: "once", ref: publicRef }),
        context("transport-b", 1_024),
      );
    } catch (error) {
      entryTooLarge = error;
    }
    expect(entryTooLarge).toMatchObject({ serverCode: "entry_too_large" });
  } finally {
    await host.close();
  }
});

test("v2 sync continuation with no pending work is empty, and a stale afterEntryId falls back to baseline", async () => {
  const store = new MemoryStore();
  const runtimeListeners = new Set<(event: RemoteAgentV2SessionEvent) => void>();
  const entryA = entry("entry-a");
  const entryB = entry("entry-b");
  const current = snapshot([entryA, entryB]);
  const backendBase = presenceBackend(runtimeListeners);
  const backend: RemoteAgentV2Backend = { ...backendBase, readSession: async () => current };
  const host = new OrbisRemoteAgentV2Host({
    backend,
    backendId: "remote:host-a",
    store,
    transport: { send: async () => undefined },
  });
  try {
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test", platform: "node" }, supportedVersions: [2] },
      context(),
    );
    const baseline = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "once", ref: publicRef }),
      context(),
    );
    expect(baseline).toMatchObject({
      baseline: true,
      entries: [
        { cursor: 1, id: "entry-a" },
        { cursor: 2, id: "entry-b" },
      ],
      hasMore: false,
      hasOlder: false,
      oldestCursor: 1,
      throughCursor: 2,
    });

    // The client is already caught up: no entries follow cursor 2, so the
    // continuation page is empty and both cursors collapse to afterCursor.
    const empty = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ afterCursor: 2, afterEntryId: "entry-b", mode: "once", ref: publicRef }),
      context(),
    );
    expect(empty).toMatchObject({
      baseline: false,
      entries: [],
      hasMore: false,
      hasOlder: false,
      oldestCursor: 2,
      throughCursor: 2,
    });

    // The cursor exists in the host's index but the entry id at that cursor
    // does not match what the client claims — the client's transcript has
    // diverged (e.g. a fork or history rewrite) and the host cannot safely
    // continue forward, so it must fall back to a full baseline.
    const stale = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ afterCursor: 2, afterEntryId: "entry-not-real", mode: "once", ref: publicRef }),
      context(),
    );
    expect(stale).toMatchObject({
      baseline: true,
      entries: [
        { cursor: 1, id: "entry-a" },
        { cursor: 2, id: "entry-b" },
      ],
      hasMore: false,
      hasOlder: false,
      oldestCursor: 1,
      throughCursor: 2,
    });
  } finally {
    await host.close();
  }
});

test("v2 sync continuation caps entries at maxReplayBatch when the count cap binds before the byte budget", async () => {
  const store = new MemoryStore();
  const runtimeListeners = new Set<(event: RemoteAgentV2SessionEvent) => void>();
  const entries = Array.from({ length: 10 }, (_, index) => entry(`entry-${index}`));
  const current = snapshot(entries);
  const backendBase = presenceBackend(runtimeListeners);
  const backend: RemoteAgentV2Backend = { ...backendBase, readSession: async () => current };
  const host = new OrbisRemoteAgentV2Host({
    backend,
    backendId: "remote:host-a",
    limits: { maxReplayBatch: 3 },
    store,
    transport: { send: async () => undefined },
  });
  try {
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test", platform: "node" }, supportedVersions: [2] },
      context(),
    );
    // `context()` grants a generous 1 MiB byte budget and these entries are
    // tiny, so the byte budget never binds here — the count cap does, the
    // mirror image of the byte-cap-binds-first case covered above.
    const page = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ afterCursor: 0, afterEntryId: null, mode: "once", ref: publicRef }),
      context(),
    );
    expect(page).toMatchObject({
      baseline: false,
      entries: [
        { cursor: 1, id: "entry-0" },
        { cursor: 2, id: "entry-1" },
        { cursor: 3, id: "entry-2" },
      ],
      hasMore: true,
      hasOlder: false,
      oldestCursor: 1,
      throughCursor: 3,
    });
  } finally {
    await host.close();
  }
});

test("v2 host does not replay transient backlog to a peer joining live sync", async () => {
  const streamEntryId = agentEntryId("stream-1");
  const runId = agentRunId("run-1");
  const preSyncChunkCount = 3;
  const queuedAfterSyncChunkSeq = preSyncChunkCount + 1;
  const postSyncChunkSeq = queuedAfterSyncChunkSeq + 1;
  const peerB: RemoteAgentHostPeer = {
    deviceId: "device-b",
    deviceName: "Test Device B",
    id: "peer-b",
    transportId: "transport-b",
  };
  const peerBReconnect = { ...peerB, transportId: "transport-b-reconnect" };
  const contextB = { ...context(peerB.transportId), peer: peerB };
  const contextBReconnect = {
    ...context(peerBReconnect.transportId),
    peer: peerBReconnect,
  };
  const runtimeListeners = new Set<(event: RemoteAgentV2SessionEvent) => void>();
  const delivered: Array<{
    readonly event: RemoteAgentV2SessionEvent;
    readonly target: string;
    readonly transportId: string;
  }> = [];
  const protocolErrors: AgentBackendError[] = [];
  let current = snapshot([]);
  let readSessionCalls = 0;
  let firstTransient = true;
  let releaseFirstSend: (() => void) | undefined;
  let firstSendStartedResolve: (() => void) | undefined;
  const firstSendStarted = new Promise<void>((resolve) => {
    firstSendStartedResolve = resolve;
  });
  let postSyncDeliveredResolve: (() => void) | undefined;
  const postSyncDelivered = new Promise<void>((resolve) => {
    postSyncDeliveredResolve = resolve;
  });
  let ownerPostSyncDeliveredResolve: (() => void) | undefined;
  const ownerPostSyncDelivered = new Promise<void>((resolve) => {
    ownerPostSyncDeliveredResolve = resolve;
  });
  let queuedDeliveredResolve: (() => void) | undefined;
  const queuedDelivered = new Promise<void>((resolve) => {
    queuedDeliveredResolve = resolve;
  });
  const backendBase = presenceBackend(runtimeListeners);
  const backend: RemoteAgentV2Backend = {
    ...backendBase,
    readSession: async () => {
      readSessionCalls += 1;
      return current;
    },
  };
  const host = new OrbisRemoteAgentV2Host({
    backend,
    backendId: "remote:host-a",
    onError: (error) => protocolErrors.push(error),
    store: new MemoryStore(),
    transport: {
      send: async (target, frame) => {
        const event = sessionEventFromTransport(frame);
        if (event?.channel !== "transient") return;
        if (firstTransient) {
          firstTransient = false;
          firstSendStartedResolve?.();
          await new Promise<void>((resolve) => {
            releaseFirstSend = resolve;
          });
        }
        delivered.push({ event, target: target.id, transportId: target.transportId });
        if (
          target.transportId === peerBReconnect.transportId &&
          event.type === "entry.delta" &&
          event.chunkSeq === postSyncChunkSeq
        ) {
          postSyncDeliveredResolve?.();
        }
        if (
          target.id === peer.id &&
          event.type === "entry.delta" &&
          event.chunkSeq === queuedAfterSyncChunkSeq
        ) {
          queuedDeliveredResolve?.();
        }
        if (
          target.id === peer.id &&
          event.type === "entry.delta" &&
          event.chunkSeq === postSyncChunkSeq
        ) {
          ownerPostSyncDeliveredResolve?.();
        }
      },
    },
  });
  const emit = (chunkSeq: number, sessionId = nativeRef.sessionId): void => {
    const event: RemoteAgentV2SessionEvent = {
      blockIndex: 0,
      channel: "transient",
      chunkSeq,
      delta: String(chunkSeq),
      entryId: streamEntryId,
      eventId: agentEventId(`delta-${chunkSeq}`),
      occurredAt: now,
      part: "text",
      sessionId,
      source: { backendId: nativeRef.backendId, driverId: nativeRef.driverId },
      type: "entry.delta",
    };
    for (const listener of runtimeListeners) listener(event);
  };
  try {
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test", platform: "node" }, supportedVersions: [2] },
      context(),
    );
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test B", platform: "node" }, supportedVersions: [2] },
      contextB,
    );
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "live", ref: publicRef }),
      context(),
    );
    readSessionCalls = 0;

    for (let chunkSeq = 1; chunkSeq <= preSyncChunkCount; chunkSeq += 1) emit(chunkSeq);
    await firstSendStarted;
    const preSyncOverlay = {
      runId,
      runningTools: [],
      streaming: {
        blocks: [
          {
            blockIndex: 0,
            content: { text: String(preSyncChunkCount), type: "text" as const },
          },
        ],
        chunkSeq: preSyncChunkCount,
        entryId: streamEntryId,
      },
    };
    current = {
      ...snapshot([], 1, {
        activeRun: { runId, startedAt: now },
        runState: "running",
      }),
      overlay: preSyncOverlay,
    };

    const syncResult = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "live", ref: publicRef }),
      contextB,
    );
    expect(syncResult).toMatchObject({
      baseline: true,
      overlay: preSyncOverlay,
      state: { ...current.state, ref: publicRef },
    });
    expect(readSessionCalls).toBe(1);
    expect(delivered.filter(({ target }) => target === peerB.id)).toHaveLength(0);

    emit(queuedAfterSyncChunkSeq);
    const queuedOverlay = {
      ...preSyncOverlay,
      streaming: {
        ...preSyncOverlay.streaming,
        blocks: [
          {
            blockIndex: 0,
            content: { text: String(queuedAfterSyncChunkSeq), type: "text" as const },
          },
        ],
        chunkSeq: queuedAfterSyncChunkSeq,
      },
    };
    current = { ...current, overlay: queuedOverlay };
    const onceResult = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "once", ref: publicRef }),
      contextB,
    );
    expect(onceResult).toMatchObject({
      baseline: true,
      overlay: queuedOverlay,
      state: { ...current.state, ref: publicRef },
    });
    expect(readSessionCalls).toBe(2);
    expect(delivered.filter(({ target }) => target === peerB.id)).toHaveLength(0);

    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test B Reconnected", platform: "node" }, supportedVersions: [2] },
      contextBReconnect,
    );
    releaseFirstSend?.();
    await queuedDelivered;

    readSessionCalls = 0;
    const resyncResult = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "live", ref: publicRef }),
      contextBReconnect,
    );
    expect(resyncResult).toMatchObject({
      baseline: true,
      overlay: queuedOverlay,
      state: { ...current.state, ref: publicRef },
    });
    expect(readSessionCalls).toBe(1);

    emit(postSyncChunkSeq);
    await Promise.all([ownerPostSyncDelivered, postSyncDelivered]);

    const eventsFor = (transportId: string) =>
      delivered
        .filter((delivery) => delivery.transportId === transportId)
        .map(({ event }) => (event.type === "entry.delta" ? event.chunkSeq : 0));
    expect(eventsFor(peer.transportId)).toEqual([1, 2, 3, 4, 5]);
    expect(eventsFor(peerB.transportId)).toEqual([]);
    expect(eventsFor(peerBReconnect.transportId)).toEqual([postSyncChunkSeq]);
    expect(readSessionCalls).toBe(1);
    expect(firstTransient).toBe(false);

    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "once", ref: publicRef }),
      context(),
    );
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "once", ref: publicRef }),
      contextBReconnect,
    );
    emit(99, otherNativeRef.sessionId);
    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]).toMatchObject({ code: "protocol" });
  } finally {
    releaseFirstSend?.();
    await host.close();
  }
});

test("v2 host keeps authoritative sync independent from a blocked transient burst", async () => {
  const chunkCount = 50_000;
  const acceptedTransientCount = 256;
  const postCapacityChunkSeq = chunkCount + 1;
  const streamEntryId = agentEntryId("stream-1");
  const runId = agentRunId("run-1");
  const runtimeListeners = new Set<(event: RemoteAgentV2SessionEvent) => void>();
  let current = snapshot([]);
  let readSessionCalls = 0;
  let firstTransient = true;
  let releaseFirstSend: (() => void) | undefined;
  let firstSendStartedResolve: (() => void) | undefined;
  const firstSendStarted = new Promise<void>((resolve) => {
    firstSendStartedResolve = resolve;
  });
  let acceptedTransientsResolve: (() => void) | undefined;
  const acceptedTransientsDelivered = new Promise<void>((resolve) => {
    acceptedTransientsResolve = resolve;
  });
  let postCapacityDeliveredResolve: (() => void) | undefined;
  const postCapacityDelivered = new Promise<void>((resolve) => {
    postCapacityDeliveredResolve = resolve;
  });
  const sent: RemoteAgentV2SessionEvent[] = [];
  const targets: string[] = [];
  const backendBase = presenceBackend(runtimeListeners);
  const backend: RemoteAgentV2Backend = {
    ...backendBase,
    readSession: async () => {
      readSessionCalls += 1;
      return current;
    },
  };
  const host = new OrbisRemoteAgentV2Host({
    backend,
    backendId: "remote:host-a",
    store: new MemoryStore(),
    transport: {
      send: async (target, frame) => {
        const event = sessionEventFromTransport(frame);
        if (event?.channel !== "transient") return;
        if (firstTransient) {
          firstTransient = false;
          firstSendStartedResolve?.();
          await new Promise<void>((resolve) => {
            releaseFirstSend = resolve;
          });
        }
        sent.push(event);
        targets.push(target.id);
        if (sent.length === acceptedTransientCount) acceptedTransientsResolve?.();
        if (event.type === "entry.delta" && event.chunkSeq === postCapacityChunkSeq) {
          postCapacityDeliveredResolve?.();
        }
      },
    },
  });
  const emit = (chunkSeq: number): void => {
    const event: RemoteAgentV2SessionEvent = {
      blockIndex: 0,
      channel: "transient",
      chunkSeq,
      delta: String(chunkSeq),
      entryId: streamEntryId,
      eventId: agentEventId(`delta-${chunkSeq}`),
      occurredAt: now,
      part: "text",
      sessionId: nativeRef.sessionId,
      source: { backendId: nativeRef.backendId, driverId: nativeRef.driverId },
      type: "entry.delta",
    };
    for (const listener of runtimeListeners) listener(event);
  };
  try {
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test", platform: "node" }, supportedVersions: [2] },
      context(),
    );
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "live", ref: publicRef }),
      context(),
    );
    readSessionCalls = 0;

    const finalOverlay = {
      runId,
      runningTools: [],
      streaming: {
        blocks: [
          {
            blockIndex: 0,
            content: { text: String(chunkCount), type: "text" as const },
          },
        ],
        chunkSeq: chunkCount,
        entryId: streamEntryId,
      },
    };
    current = {
      ...snapshot([], 1, {
        activeRun: { runId, startedAt: now },
        runState: "running",
      }),
      overlay: finalOverlay,
    };

    for (let chunkSeq = 1; chunkSeq <= chunkCount; chunkSeq += 1) emit(chunkSeq);
    const syncPromise = host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "live", ref: publicRef }),
      context(),
    );
    await firstSendStarted;
    const syncResult = await syncPromise;

    expect(releaseFirstSend).toEqual(expect.any(Function));
    expect(readSessionCalls).toBe(1);
    expect(syncResult).toMatchObject({
      baseline: true,
      overlay: finalOverlay,
      state: { ...current.state, ref: publicRef },
    });
    expect(sent).toHaveLength(0);

    releaseFirstSend?.();
    await acceptedTransientsDelivered;
    expect(readSessionCalls).toBe(1);
    expect(sent).toHaveLength(acceptedTransientCount);
    expect(targets.every((target) => target === peer.id)).toBe(true);
    expect(sent.map((event) => (event.type === "entry.delta" ? event.chunkSeq : 0))).toEqual(
      Array.from({ length: acceptedTransientCount }, (_, index) => index + 1),
    );

    emit(postCapacityChunkSeq);
    await postCapacityDelivered;
    expect(sent).toHaveLength(acceptedTransientCount + 1);
    expect(sent.at(-1)).toMatchObject({ chunkSeq: postCapacityChunkSeq });
  } finally {
    releaseFirstSend?.();
    await host.close();
  }
});

test("v2 host announces catalog rows that move outside its own session runtimes", async () => {
  const store = new MemoryStore();
  const catalog = new Map<string, RemoteAgentV2SessionSummary>([
    [
      "session-a",
      {
        driverId: agentDriverId("dsh"),
        ref: nativeRef,
        runState: "idle",
        title: null,
        updatedAt: now,
      },
    ],
  ]);
  let listCalls = 0;
  let notifyCatalog: (() => void) | undefined;
  let detachedCatalog = false;
  const backend: RemoteAgentV2Backend = {
    browseWorkspaceFolders: async () => ({
      breadcrumbs: [],
      current: null,
      entries: [],
      truncated: false,
    }),
    close: async () => undefined,
    completePromptReferences: async () => undefined,
    connectRuntime: async () => {
      throw new Error("unused");
    },
    createSession: async () => {
      throw new Error("unused");
    },
    createWorkspaceFolder: async () => {
      throw new Error("unused");
    },
    hostId: agentBackendId("native"),
    listDrivers: async () => [],
    listModels: async () => [],
    listWorkspaces: async () => [],
    listSessions: async () => {
      listCalls += 1;
      return [...catalog.values()];
    },
    listSessionSubagents: async () => [],
    observeCatalog: (listener) => {
      notifyCatalog = listener;
      return () => {
        detachedCatalog = true;
      };
    },
    readSession: async () => snapshot([]),
    readAttachment: async () => {
      throw new Error("unused");
    },
    registerWorkspace: async () => {
      throw new Error("unused");
    },
    updateSession: async () => {
      throw new Error("unused");
    },
  };
  let pending: (() => void) | undefined;
  const sent: TransportEvent[] = [];
  const host = new OrbisRemoteAgentV2Host({
    backend,
    backendId: "remote:host-a",
    scheduler: {
      cancel: () => {
        pending = undefined;
      },
      schedule: (callback) => {
        pending = callback;
        return 1;
      },
    },
    store,
    transport: {
      send: async (_target, event) => {
        sent.push(event);
      },
    },
  });
  const sweep = async () => {
    const callback = pending;
    pending = undefined;
    callback?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const hostEvents = () =>
    sent.map((event) => (event.payload as unknown as { event: RemoteAgentV2HostEvent }).event);

  try {
    expect(notifyCatalog).toBeDefined();
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test", platform: "node" }, supportedVersions: [2] },
      context(),
    );

    // Before any client has listed there is no shared view to diff against, so
    // a hint only seeds the baseline.
    notifyCatalog?.();
    await sweep();
    expect(sent).toEqual([]);

    await host.handleRequest(ORBIS_REMOTE_AGENT_V2_METHODS.sessionsList, {}, context());
    const listCallsAfterBaseline = listCalls;

    // A burst from one native run collapses into a single catalog listing.
    catalog.set("session-b", {
      driverId: agentDriverId("dsh"),
      ref: otherNativeRef,
      runState: "running",
      title: null,
      updatedAt: agentTimestamp("2026-08-11T00:00:01.000Z"),
    });
    notifyCatalog?.();
    notifyCatalog?.();
    notifyCatalog?.();
    await sweep();
    expect(listCalls).toBe(listCallsAfterBaseline + 1);
    expect(hostEvents()).toEqual([
      {
        session: {
          driverId: agentDriverId("dsh"),
          ref: otherPublicRef,
          runState: "running",
          title: null,
          updatedAt: agentTimestamp("2026-08-11T00:00:01.000Z"),
        },
        type: "host.session.added",
      },
    ]);

    // An unchanged catalog stays silent; only a moved row is announced again.
    sent.length = 0;
    notifyCatalog?.();
    await sweep();
    expect(sent).toEqual([]);

    catalog.set("session-b", {
      ...(catalog.get("session-b") as RemoteAgentV2SessionSummary),
      runState: "idle",
      title: "Second session",
    });
    notifyCatalog?.();
    await sweep();
    expect(hostEvents()).toMatchObject([
      {
        session: { ref: { sessionId: "session-b" }, runState: "idle", title: "Second session" },
        type: "host.session.changed",
      },
    ]);

    sent.length = 0;
    catalog.delete("session-b");
    notifyCatalog?.();
    await sweep();
    expect(hostEvents()).toEqual([
      { reason: "gone", sessionId: "session-b", type: "host.session.removed" },
    ]);
  } finally {
    await host.close();
  }
  expect(detachedCatalog).toBe(true);
});

test("v2 host owns live presence membership and converges disconnects", async () => {
  const runtimeListeners = new Set<(event: RemoteAgentV2SessionEvent) => void>();
  const received = new Map<string, RemoteAgentV2SessionEvent[]>();
  let failedDeviceId: string | undefined;
  let disconnectPeer: ((peer: RemoteAgentHostPeer) => void) | undefined;
  let clockTick = 0;
  const clock = () =>
    agentTimestamp(`2026-08-11T00:00:${String(++clockTick).padStart(2, "0")}.000Z`);
  const transport: RemoteAgentHostDeliveryTransport = {
    onPeerDisconnected: (listener) => {
      disconnectPeer = listener;
      return () => {
        if (disconnectPeer === listener) disconnectPeer = undefined;
      };
    },
    send: async (target, frame) => {
      const event = sessionEventFromTransport(frame);
      if (event?.type === "presence.changed" && target.deviceId === failedDeviceId) {
        throw new Error("peer send failed");
      }
      if (event === undefined) return;
      const events = received.get(target.id) ?? [];
      events.push(event);
      received.set(target.id, events);
    },
  };
  const backend = presenceBackend(runtimeListeners);
  const host = new OrbisRemoteAgentV2Host({
    backend,
    backendId: "remote:host-a",
    capabilities: { presence: true },
    clock,
    store: new MemoryStore(),
    transport,
  });
  const peerA: RemoteAgentHostPeer = {
    deviceId: "device-a",
    deviceName: "Phone A",
    id: "peer-a",
    transportId: "transport-a",
  };
  const peerB: RemoteAgentHostPeer = {
    deviceId: "device-b",
    deviceName: "Phone B",
    id: "peer-b",
    transportId: "transport-b",
  };
  const requestContext = (target: RemoteAgentHostPeer) => ({
    maxResponseBytes: 1024 * 1024,
    peer: target,
    signal: new AbortController().signal,
  });
  const hello = (target: RemoteAgentHostPeer) =>
    host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      {
        device: {
          ...(target.deviceName === undefined ? {} : { name: target.deviceName }),
          platform: "node",
        },
        supportedVersions: [2],
      },
      requestContext(target),
    );
  const sync = (target: RemoteAgentHostPeer, mode: "live" | "once") =>
    host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode, ref: publicRef }),
      requestContext(target),
    );
  const latestPresence = (target: RemoteAgentHostPeer) => {
    const events = received.get(target.id) ?? [];
    const event = [...events].reverse().find((candidate) => candidate.type === "presence.changed");
    if (event?.type !== "presence.changed") throw new Error("Missing presence event");
    return event;
  };

  try {
    await hello(peerA);
    await hello(peerB);
    await sync(peerA, "live");
    const first = latestPresence(peerA);
    expect(first.devices).toEqual([
      { deviceId: "device-a", name: "Phone A", since: "2026-08-11T00:00:01.000Z", viewing: true },
    ]);

    await sync(peerA, "live");
    expect(latestPresence(peerA).devices[0]?.since).toBe(first.devices[0]?.since);

    await sync(peerB, "live");
    expect(latestPresence(peerA).devices).toHaveLength(2);
    expect(latestPresence(peerB).devices).toHaveLength(2);

    const peerBEventCountBeforeDisconnect = (received.get(peerB.id) ?? []).length;
    disconnectPeer?.(peerB);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(latestPresence(peerA).devices).toEqual([
      { deviceId: "device-a", name: "Phone A", since: first.devices[0]?.since, viewing: true },
    ]);
    expect((received.get(peerB.id) ?? []).length).toBe(peerBEventCountBeforeDisconnect);
    await hello(peerB);
    await sync(peerB, "live");

    const peerBEventCount = (received.get(peerB.id) ?? []).length;
    await sync(peerB, "once");
    expect(latestPresence(peerA).devices).toEqual([
      { deviceId: "device-a", name: "Phone A", since: first.devices[0]?.since, viewing: true },
    ]);
    expect((received.get(peerB.id) ?? []).length).toBe(peerBEventCount);

    const peerAReconnect: RemoteAgentHostPeer = { ...peerA, transportId: "transport-a-new" };
    await hello(peerAReconnect);
    await sync(peerAReconnect, "live");
    expect(latestPresence(peerAReconnect).devices[0]?.since).toBe(first.devices[0]?.since);
    disconnectPeer?.(peerA);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await sync(peerAReconnect, "live");
    expect(latestPresence(peerAReconnect).devices[0]?.deviceId).toBe("device-a");

    await sync(peerB, "live");
    failedDeviceId = "device-b";
    await sync(peerAReconnect, "live");
    expect(latestPresence(peerAReconnect).devices).toEqual([
      { deviceId: "device-a", name: "Phone A", since: first.devices[0]?.since, viewing: true },
    ]);
  } finally {
    await host.close();
  }
});

test("v2 host leaves presence disabled by default", async () => {
  const runtimeListeners = new Set<(event: RemoteAgentV2SessionEvent) => void>();
  const presenceEvents: RemoteAgentV2SessionEvent[] = [];
  const host = new OrbisRemoteAgentV2Host({
    backend: presenceBackend(runtimeListeners),
    backendId: "remote:host-a",
    store: new MemoryStore(),
    transport: {
      send: async (_target, frame) => {
        const event = sessionEventFromTransport(frame);
        if (event?.type === "presence.changed") presenceEvents.push(event);
      },
    },
  });
  try {
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test", platform: "node" }, supportedVersions: [2] },
      context(),
    );
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "live", ref: publicRef }),
      context(),
    );
    expect(presenceEvents).toEqual([]);
  } finally {
    await host.close();
  }
});

test("v2 host validates staged uploads, consumes successful prompts, and bounds reads", async () => {
  const runtimeListeners = new Set<(event: RemoteAgentV2SessionEvent) => void>();
  const prompted: AgentPromptContentBlock[][] = [];
  let failPrompt = false;
  let readData = "AQIDBAUG";
  const peerB: RemoteAgentHostPeer = {
    deviceId: "device-b",
    deviceName: "Test Device B",
    id: "peer-b",
    transportId: "transport-b",
  };
  let disconnectPeer: ((peer: RemoteAgentHostPeer) => void) | undefined;
  const backend = presenceBackend(runtimeListeners, {
    onPrompt: (content) => {
      if (failPrompt) {
        failPrompt = false;
        throw new AgentBackendError("unavailable", "test prompt failure");
      }
      prompted.push([...content]);
    },
    readAttachment: async (native, attachmentId) => {
      expect(native.sessionId).toBe("session-a");
      if (attachmentId !== "att-1" && attachmentId !== "att-too-large") {
        throw new AgentBackendError("not_found", "attachment not found");
      }
      const bytes = attachmentId === "att-too-large" ? "AQIDBAUGBwgJCg==" : readData;
      return {
        attachmentId,
        bytes: bytes === readData ? 6 : 10,
        data: bytes,
        mimeType: "image/png",
      };
    },
  });
  const host = new OrbisRemoteAgentV2Host({
    backend,
    backendId: "remote:host-a",
    capabilities: {
      attachments: {
        downloadChunkBytes: 3,
        maxImageBytes: 9,
        maxImagesPerMessage: 4,
        maxMessageImageBytes: 12,
        mimeTypes: ["image/png"],
        uploadChunkBytes: 3,
      },
    },
    store: new MemoryStore(),
    transport: {
      onPeerDisconnected: (listener) => {
        disconnectPeer = listener;
        return () => {
          if (disconnectPeer === listener) disconnectPeer = undefined;
        };
      },
      send: async () => undefined,
    },
  });
  const requestContext = (target: RemoteAgentHostPeer = peer) => ({
    maxResponseBytes: 1024 * 1024,
    peer: target,
    signal: new AbortController().signal,
  });
  const begin = (target: RemoteAgentHostPeer, uploadId: string, totalBytes: number) =>
    host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadBegin,
      params({
        idempotencyKey: `${uploadId}:begin`,
        mimeType: "image/png",
        ref: publicRef,
        totalBytes,
        uploadId,
      }),
      requestContext(target),
    );
  const chunk = (target: RemoteAgentHostPeer, uploadId: string, offset: number, data: string) =>
    host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadChunk,
      params({
        data,
        idempotencyKey: `${uploadId}:chunk:${offset}:${data}`,
        offset,
        uploadId,
      }),
      requestContext(target),
    );
  const abort = (
    target: RemoteAgentHostPeer,
    uploadId: string,
    idempotencyKey = `${uploadId}:abort`,
  ) =>
    host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadAbort,
      params({ idempotencyKey, uploadId }),
      requestContext(target),
    );
  try {
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test", platform: "node" }, supportedVersions: [2] },
      requestContext(),
    );
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test B", platform: "node" }, supportedVersions: [2] },
      requestContext(peerB),
    );
    await expect(
      host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt,
        params({
          content: [
            { data: "AA==", mimeType: "image/png", type: "image_upload", uploadId: "raw-image" },
          ],
          idempotencyKey: "prompt-raw-image",
          ref: publicRef,
        }),
        requestContext(),
      ),
    ).rejects.toMatchObject({ code: "invalid_argument" });

    await expect(begin(peer, "upload-1", 6)).resolves.toEqual({ uploadId: "upload-1" });
    await expect(begin(peer, "upload-2", 6)).resolves.toEqual({ uploadId: "upload-2" });
    await expect(begin(peer, "upload-3", 1)).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(chunk(peer, "upload-1", 0, "A===")).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(chunk(peer, "upload-1", 1, "AQID")).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(chunk(peer, "upload-1", 0, "AQID")).resolves.toMatchObject({ nextOffset: 3 });
    await expect(chunk(peer, "upload-1", 3, "BAUG")).resolves.toMatchObject({ nextOffset: 6 });
    await expect(
      host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadFinish,
        params({ idempotencyKey: "upload-1:finish", uploadId: "upload-1" }),
        requestContext(),
      ),
    ).resolves.toEqual({ uploadId: "upload-1" });
    await expect(begin(peerB, "upload-2", 3)).resolves.toEqual({ uploadId: "upload-2" });
    await expect(abort(peer, "upload-2")).resolves.toEqual({
      aborted: true,
      uploadId: "upload-2",
    });
    await expect(abort(peer, "upload-2")).resolves.toEqual({
      aborted: true,
      uploadId: "upload-2",
    });
    await expect(chunk(peer, "upload-2", 0, "AQID")).rejects.toMatchObject({
      serverCode: "not_found",
    });
    await expect(chunk(peerB, "upload-2", 0, "AQID")).resolves.toMatchObject({ nextOffset: 3 });

    const uploadPrompt = {
      content: [{ mimeType: "image/png", type: "image_upload", uploadId: "upload-1" }],
      idempotencyKey: "prompt-image-failed",
      ref: publicRef,
    };
    failPrompt = true;
    await expect(
      host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt,
        params(uploadPrompt),
        requestContext(),
      ),
    ).rejects.toMatchObject({ serverCode: "unavailable" });
    await expect(
      host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt,
        params({ ...uploadPrompt, idempotencyKey: "prompt-image-success" }),
        requestContext(),
      ),
    ).resolves.toMatchObject({ runId: "run-1" });
    expect(prompted).toEqual([[{ data: "AQIDBAUG", mimeType: "image/png", type: "image" }]]);
    await expect(
      host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsPrompt,
        params({ ...uploadPrompt, idempotencyKey: "prompt-image-success" }),
        requestContext(),
      ),
    ).resolves.toMatchObject({ runId: "run-1" });
    expect(prompted).toHaveLength(1);

    await begin(peerB, "peer-upload", 3);
    disconnectPeer?.(peerB);
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test B", platform: "node" }, supportedVersions: [2] },
      requestContext(peerB),
    );
    await expect(chunk(peerB, "peer-upload", 0, "AQID")).rejects.toMatchObject({
      serverCode: "not_found",
    });

    const firstRead = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsRead,
      params({ attachmentId: "att-1", offset: 0, ref: publicRef }),
      requestContext(),
    );
    expect(firstRead).toMatchObject({
      attachmentId: "att-1",
      bytes: 6,
      data: "AQID",
      eof: false,
      nextOffset: 3,
    });
    const secondRead = await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsRead,
      params({ attachmentId: "att-1", offset: 3, ref: publicRef }),
      requestContext(),
    );
    expect(secondRead).toMatchObject({ data: "BAUG", eof: true, nextOffset: 6 });
    await expect(
      host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsRead,
        params({ attachmentId: "missing", offset: 0, ref: publicRef }),
        requestContext(),
      ),
    ).rejects.toMatchObject({ serverCode: "not_found" });
    await expect(
      host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsRead,
        params({ attachmentId: "att-too-large", offset: 0, ref: publicRef }),
        requestContext(),
      ),
    ).rejects.toMatchObject({ code: "protocol" });
  } finally {
    await host.close();
  }
});

test("v2 host keeps presence convergence finite across cascading send failures", async () => {
  const runtimeListeners = new Set<(event: RemoteAgentV2SessionEvent) => void>();
  const received = new Map<string, RemoteAgentV2SessionEvent[]>();
  let cFailed = false;
  let bFailed = false;
  const transport: RemoteAgentHostDeliveryTransport = {
    send: async (target, frame) => {
      const event = sessionEventFromTransport(frame);
      if (event?.type !== "presence.changed") return;
      if (target.deviceId === "device-c" && !cFailed) {
        cFailed = true;
        throw new Error("peer C send failed");
      }
      if (target.deviceId === "device-b" && cFailed && event.devices.length === 2 && !bFailed) {
        bFailed = true;
        throw new Error("peer B convergence send failed");
      }
      const events = received.get(target.id) ?? [];
      events.push(event);
      received.set(target.id, events);
    },
  };
  const host = new OrbisRemoteAgentV2Host({
    backend: presenceBackend(runtimeListeners),
    backendId: "remote:host-a",
    capabilities: { presence: true },
    clock: () => now,
    store: new MemoryStore(),
    transport,
  });
  const peers: readonly RemoteAgentHostPeer[] = [
    { deviceId: "device-a", deviceName: "Phone A", id: "peer-a", transportId: "transport-a" },
    { deviceId: "device-b", deviceName: "Phone B", id: "peer-b", transportId: "transport-b" },
    { deviceId: "device-c", deviceName: "Phone C", id: "peer-c", transportId: "transport-c" },
  ];
  const requestContext = (target: RemoteAgentHostPeer) => ({
    maxResponseBytes: 1024 * 1024,
    peer: target,
    signal: new AbortController().signal,
  });
  const hello = (target: RemoteAgentHostPeer) =>
    host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      {
        device: {
          ...(target.deviceName === undefined ? {} : { name: target.deviceName }),
          platform: "node",
        },
        supportedVersions: [2],
      },
      requestContext(target),
    );
  const sync = (target: RemoteAgentHostPeer) =>
    host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "live", ref: publicRef }),
      requestContext(target),
    );

  try {
    for (const target of peers) await hello(target);
    for (const target of peers) await sync(target);
    const eventsForA = received.get("peer-a") ?? [];
    const latest = [...eventsForA].reverse().find((event) => event.type === "presence.changed");
    expect(cFailed).toBe(true);
    expect(bFailed).toBe(true);
    expect(latest).toMatchObject({
      devices: [{ deviceId: "device-a", name: "Phone A", since: now, viewing: true }],
      type: "presence.changed",
    });
  } finally {
    await host.close();
  }
});

function frameTooLargeError(): OrbisTransportError {
  // Mirrors OrbisSecureChannel.seal's rejection in e2ee.ts: an oversized
  // plaintext throws before the encrypted sequence advances.
  return new OrbisTransportError("invalid_argument", "The encrypted frame exceeds the size limit", {
    serverCode: "frame_too_large",
  });
}

test("v2 host keeps a live durable subscription after an oversized frame is skipped", async () => {
  const runtimeListeners = new Set<(event: RemoteAgentV2SessionEvent) => void>();
  const delivered: RemoteAgentV2SessionEvent[] = [];
  const errors: AgentBackendError[] = [];
  let current = snapshot([]);
  const backend: RemoteAgentV2Backend = {
    ...presenceBackend(runtimeListeners),
    readSession: async () => current,
  };
  const host = new OrbisRemoteAgentV2Host({
    backend,
    backendId: "remote:host-a",
    onError: (error) => errors.push(error),
    store: new MemoryStore(),
    transport: {
      send: async (_target, frame) => {
        const event = sessionEventFromTransport(frame);
        if (event?.type === "entry.appended" && event.entry.id === "entry-oversized") {
          throw frameTooLargeError();
        }
        if (event !== undefined) delivered.push(event);
      },
    },
  });
  const appendEntry = (target: RemoteAgentV2SessionSnapshot["entries"][number]) =>
    runtimeListeners.forEach((listener) =>
      listener({
        channel: "replayable",
        cursor: agentDeliveryCursor(0),
        entry: target,
        eventId: agentEventId(`native-${target.id}`),
        occurredAt: now,
        sessionId: nativeRef.sessionId,
        source: {
          backendId: nativeRef.backendId,
          driverId: nativeRef.driverId,
          nativeType: "test",
        },
        type: "entry.appended",
      }),
    );

  try {
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test", platform: "node" }, supportedVersions: [2] },
      context(),
    );
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "live", ref: publicRef }),
      context(),
    );

    const oversized = entry("entry-oversized");
    current = snapshot([oversized]);
    appendEntry(oversized);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The oversized entry was skipped, not delivered, and it was reported --
    // but it must not have torn down the peer's live subscription.
    expect(delivered).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "invalid_argument" });

    const normal = entry("entry-normal");
    current = snapshot([oversized, normal]);
    appendEntry(normal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A subsequent, normally-sized event still reaches the same peer, which
    // proves the subscription survived the oversized frame.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ type: "entry.appended", entry: { id: "entry-normal" } });
    expect(errors).toHaveLength(1);
  } finally {
    await host.close();
  }
});

test("v2 host keeps a live transient subscription after an oversized frame is skipped", async () => {
  const runtimeListeners = new Set<(event: RemoteAgentV2SessionEvent) => void>();
  const delivered: RemoteAgentV2SessionEvent[] = [];
  const errors: AgentBackendError[] = [];
  const backend = presenceBackend(runtimeListeners);
  const host = new OrbisRemoteAgentV2Host({
    backend,
    backendId: "remote:host-a",
    onError: (error) => errors.push(error),
    store: new MemoryStore(),
    transport: {
      send: async (_target, frame) => {
        const event = sessionEventFromTransport(frame);
        if (event?.type === "tool.state.changed" && event.tool.callId === "call-oversized") {
          throw frameTooLargeError();
        }
        if (event !== undefined) delivered.push(event);
      },
    },
  });
  const emitToolState = (callId: string) =>
    runtimeListeners.forEach((listener) =>
      listener({
        channel: "transient",
        eventId: agentEventId(`native-tool-${callId}`),
        occurredAt: now,
        sessionId: nativeRef.sessionId,
        source: { backendId: nativeRef.backendId, driverId: nativeRef.driverId },
        tool: {
          callId,
          entryId: agentEntryId(`tool-${callId}`),
          input: { path: "/workspace/demo.ts" },
          name: "read",
          status: "running",
        },
        type: "tool.state.changed",
      }),
    );

  try {
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: "Test", platform: "node" }, supportedVersions: [2] },
      context(),
    );
    await host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "live", ref: publicRef }),
      context(),
    );

    emitToolState("call-oversized");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A transient event carrying a full tool.content that exceeds the frame
    // ceiling is skipped and reported, never delivered.
    expect(delivered).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "invalid_argument" });

    emitToolState("call-normal");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The subscription survives: a normally-sized transient event still
    // reaches the same peer afterward.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      tool: { callId: "call-normal" },
      type: "tool.state.changed",
    });
    expect(errors).toHaveLength(1);
  } finally {
    await host.close();
  }
});

test("v2 host removes a peer and broadcasts presence on a non-size live send failure", async () => {
  const runtimeListeners = new Set<(event: RemoteAgentV2SessionEvent) => void>();
  const deliveredToA: RemoteAgentV2SessionEvent[] = [];
  const deliveredToB: RemoteAgentV2SessionEvent[] = [];
  let current = snapshot([]);
  let failNextA = true;
  const peerA: RemoteAgentHostPeer = {
    deviceId: "device-a",
    deviceName: "Phone A",
    id: "peer-a",
    transportId: "transport-a",
  };
  const peerB: RemoteAgentHostPeer = {
    deviceId: "device-b",
    deviceName: "Phone B",
    id: "peer-b",
    transportId: "transport-b",
  };
  const backend: RemoteAgentV2Backend = {
    ...presenceBackend(runtimeListeners),
    readSession: async () => current,
  };
  const host = new OrbisRemoteAgentV2Host({
    backend,
    backendId: "remote:host-a",
    capabilities: { presence: true },
    clock: () => now,
    store: new MemoryStore(),
    transport: {
      send: async (target, frame) => {
        const event = sessionEventFromTransport(frame);
        if (event === undefined) return;
        if (target.id === peerA.id && event.type === "entry.appended" && failNextA) {
          failNextA = false;
          // A generic connection failure, unrelated to frame size -- today's
          // behaviour (remove the peer) must still apply here.
          throw new Error("connection reset");
        }
        if (target.id === peerA.id) deliveredToA.push(event);
        else if (target.id === peerB.id) deliveredToB.push(event);
      },
    },
  });
  const requestContext = (target: RemoteAgentHostPeer) => ({
    maxResponseBytes: 1024 * 1024,
    peer: target,
    signal: new AbortController().signal,
  });
  const hello = (target: RemoteAgentHostPeer) =>
    host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.hello,
      { device: { name: target.deviceName ?? "", platform: "node" }, supportedVersions: [2] },
      requestContext(target),
    );
  const sync = (target: RemoteAgentHostPeer) =>
    host.handleRequest(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
      params({ mode: "live", ref: publicRef }),
      requestContext(target),
    );
  const appendEntry = (target: RemoteAgentV2SessionSnapshot["entries"][number]) =>
    runtimeListeners.forEach((listener) =>
      listener({
        channel: "replayable",
        cursor: agentDeliveryCursor(0),
        entry: target,
        eventId: agentEventId(`native-${target.id}`),
        occurredAt: now,
        sessionId: nativeRef.sessionId,
        source: {
          backendId: nativeRef.backendId,
          driverId: nativeRef.driverId,
          nativeType: "test",
        },
        type: "entry.appended",
      }),
    );

  try {
    await hello(peerA);
    await hello(peerB);
    await sync(peerA);
    await sync(peerB);
    // Clear the presence broadcasts triggered by hello/sync itself so the
    // assertions below reflect only what happens from the entry events on.
    deliveredToA.length = 0;
    deliveredToB.length = 0;

    const first = entry("entry-first");
    current = snapshot([first]);
    appendEntry(first);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliveredToA).toHaveLength(0);
    const presenceAfterFailure = [...deliveredToB]
      .reverse()
      .find((event) => event.type === "presence.changed");
    // Peer A was removed as a subscriber, so the reconverged presence
    // broadcast (triggered because presence is enabled) lists only B.
    expect(presenceAfterFailure).toMatchObject({
      devices: [{ deviceId: "device-b", name: "Phone B", viewing: true }],
    });

    const second = entry("entry-second");
    current = snapshot([first, second]);
    appendEntry(second);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The mock would now succeed for A (failNextA already consumed), so
    // still receiving nothing proves removal, not a repeated failure.
    expect(deliveredToA).toHaveLength(0);
    expect(deliveredToB.filter((event) => event.type === "entry.appended")).toHaveLength(2);
  } finally {
    await host.close();
  }
});
