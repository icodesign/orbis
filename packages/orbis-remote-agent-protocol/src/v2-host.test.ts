import {
  agentBackendId,
  agentDeliveryCursor,
  agentDriverId,
  agentEntryId,
  agentEventId,
  agentRunId,
  agentTimestamp,
  createAgentDriverDescriptor,
  createAgentSessionRef,
  type AgentJsonValue,
  type AgentSessionRef,
} from "@orbisapp/orbis-agent-backend";
import { OrbisTransportError, type JsonValue, type TransportEvent } from "@orbisapp/transport";
import { expect, test } from "vitest";

import {
  OrbisRemoteAgentV2Host,
  type RemoteAgentV2Backend,
  type RemoteAgentV2HostEvent,
  type RemoteAgentV2HostStore,
  type RemoteAgentV2IdempotencyClaim,
  type RemoteAgentV2Runtime,
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
const peer = { id: "peer-a", transportId: "transport-a" };
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
      ref: nativeRef,
      revision,
      runState: "idle",
      title: null,
      updatedAt: now,
      workspaceRef: "workspace-a",
    },
  };
}

function context(transportId = peer.transportId, maxResponseBytes = 1024 * 1024) {
  return {
    maxResponseBytes,
    peer: { id: peer.id, transportId },
    signal: new AbortController().signal,
  };
}

function params(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

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
        capabilities: ["model.select", "permission.respond", "session.list", "workspace.open"],
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
    readSession: async () => current,
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
  let rejectTransportFrame = false;
  const host = new OrbisRemoteAgentV2Host({
    backend,
    backendId: "remote:host-a",
    limits: { maxPromptBytes: 64 },
    store,
    transport: {
      send: async (_target, event) => {
        if (rejectTransportFrame) {
          throw new OrbisTransportError("invalid_argument", "test frame is too large", {
            serverCode: "frame_too_large",
          });
        }
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
    expect(baseline).toMatchObject({ entries: [], hostRevision: "1", kind: "snapshot" });

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
    expect(replay).toMatchObject({ hasMore: false, kind: "replay", throughCursor: 2 });
    expect(sent).toHaveLength(6);

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
    expect(rebuilt).toMatchObject({ hostRevision: "2", kind: "snapshot" });
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

    rejectTransportFrame = true;
    let replayEntryTooLarge: unknown;
    try {
      await host.handleRequest(
        ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync,
        params({ afterCursor: 0, afterEntryId: null, mode: "once", ref: publicRef }),
        context("transport-b", snapshotBudget),
      );
    } catch (error) {
      replayEntryTooLarge = error;
    } finally {
      rejectTransportFrame = false;
    }
    expect(replayEntryTooLarge).toMatchObject({ serverCode: "entry_too_large" });

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
    observeCatalog: (listener) => {
      notifyCatalog = listener;
      return () => {
        detachedCatalog = true;
      };
    },
    readSession: async () => snapshot([]),
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
