import {
  agentTimestamp,
  createAgentSessionRef,
  type AgentJsonValue,
} from "@orbisapp/orbis-agent-backend";
import { OrbisTransportError, type JsonValue, type TransportEvent } from "@orbisapp/transport";
import { expect, test } from "vitest";

import { OrbisRemoteAgentV2Connection } from "./v2-connection";
import {
  ORBIS_REMOTE_AGENT_V2_EVENT_TYPE,
  ORBIS_REMOTE_AGENT_V2_METHODS,
  ORBIS_REMOTE_AGENT_V2_METHOD_LIST,
} from "./v2-constants";

const ref = createAgentSessionRef({
  backendId: "remote:host-a",
  driverId: "dsh",
  nativeSessionId: "native-a",
  sessionId: "session-a",
});

async function rejected(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject");
}

class FakeV2Transport {
  readonly methods = ORBIS_REMOTE_AGENT_V2_METHOD_LIST;
  readonly requests: Array<{ readonly method: string; readonly params: JsonValue }> = [];
  private readonly closeListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: TransportEvent) => void>();
  private readonly errors = new Map<string, unknown>();
  private readonly responses = new Map<string, JsonValue>();

  close(): void {
    for (const listener of this.closeListeners) listener();
  }

  emit(event: TransportEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onEvent(listener: (event: TransportEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async request(method: string, params: JsonValue): Promise<JsonValue> {
    this.requests.push({ method, params });
    const error = this.errors.get(method);
    if (error !== undefined) throw error;
    const response = this.responses.get(method);
    if (response === undefined) throw new Error(`Missing response for ${method}`);
    return response;
  }

  reject(method: string, error: unknown): void {
    this.errors.set(method, error);
  }

  respond(method: string, value: JsonValue): void {
    this.responses.set(method, value);
  }
}

function helloResult(): JsonValue {
  return {
    capabilities: {
      attachments: false,
      dispose: false,
      fork: false,
      permission: false,
      presence: false,
    },
    drivers: [
      {
        capabilities: [],
        displayName: "DeepSeek Harness",
        id: "dsh",
      },
    ],
    hostId: "remote:host-a",
    hostRevision: "revision-a",
    limits: { maxPromptBytes: 1024, maxReplayBatch: 16, maxSnapshotWindow: 16 },
    version: 2,
  };
}

function entryEvent(): TransportEvent {
  const occurredAt = agentTimestamp("2026-08-11T00:00:01.000Z");
  const event = {
    channel: "replayable",
    createdAt: occurredAt,
    cursor: 1,
    entry: {
      content: [{ text: "hello", type: "text" }],
      createdAt: occurredAt,
      cursor: 1,
      id: "entry-a",
      kind: "message",
      parentId: null,
      role: "assistant",
    },
    eventId: "event-a",
    occurredAt,
    sessionId: ref.sessionId,
    source: { backendId: ref.backendId, driverId: ref.driverId },
    type: "entry.appended",
  };
  return {
    durability: "durable",
    eventId: "event-a",
    eventSeq: 1,
    payload: {
      event: event as unknown as AgentJsonValue,
      protocolVersion: 2,
      scope: {
        kind: "session",
        ref: {
          backendId: ref.backendId,
          driverId: ref.driverId,
          nativeSessionId: ref.nativeSessionId,
          sessionId: ref.sessionId,
        },
      },
    } as unknown as JsonValue,
    sessionId: ref.sessionId,
    source: { harness: "dsh" },
    time: occurredAt,
    type: ORBIS_REMOTE_AGENT_V2_EVENT_TYPE,
  };
}

function hostEvent(): TransportEvent {
  const occurredAt = agentTimestamp("2026-08-11T00:00:02.000Z");
  return {
    durability: "transient",
    eventId: "host-event-1",
    eventSeq: 1,
    payload: {
      event: { revision: "2", type: "host.models.changed" },
      protocolVersion: 2,
      scope: { kind: "host" },
    },
    sessionId: "host:remote:host-a",
    source: { harness: "orbis-remote-agent", nativeType: "host" },
    time: occurredAt,
    type: ORBIS_REMOTE_AGENT_V2_EVENT_TYPE,
  };
}

function unknownSessionEvent(
  channel: "replayable" | "state" | "transient",
  type: string,
): TransportEvent {
  const original = entryEvent();
  const payload = original.payload as Record<string, JsonValue>;
  const event = payload.event as Record<string, JsonValue>;
  return {
    ...original,
    durability: channel === "replayable" ? "durable" : "transient",
    payload: {
      ...payload,
      event: { ...event, channel, type },
    } as JsonValue,
  };
}

test("v2 connection enforces hello-first and delivers replayable events without ACK", async () => {
  const transport = new FakeV2Transport();
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, helloResult());
  const connection = new OrbisRemoteAgentV2Connection(transport);
  const deliveries: unknown[] = [];
  connection.onEvent((delivery) => deliveries.push(delivery));

  expect(await rejected(() => connection.listDrivers())).toMatchObject({ code: "protocol" });
  const hello = await connection.hello({
    device: { name: "Test phone", platform: "ios" },
    supportedVersions: [2],
  });

  expect(hello).toMatchObject({ hostId: "remote:host-a", version: 2 });
  expect(transport.requests[0]).toEqual({
    method: ORBIS_REMOTE_AGENT_V2_METHODS.hello,
    params: { device: { name: "Test phone", platform: "ios" }, supportedVersions: [2] },
  });
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.workspacesList, {
    workspaces: [{ displayName: "Orbis", ref: "workspace-a" }],
  });
  expect(await connection.listWorkspaces({ driverId: ref.driverId })).toEqual([
    { displayName: "Orbis", ref: "workspace-a" },
  ]);
  expect(transport.requests[1]).toEqual({
    method: ORBIS_REMOTE_AGENT_V2_METHODS.workspacesList,
    params: { driverId: "dsh" },
  });
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.workspacesBrowse, {
    breadcrumbs: [],
    current: null,
    entries: [{ displayName: "Projects", hidden: false, ref: "folder-a", selectable: true }],
    truncated: false,
  });
  expect(await connection.browseWorkspaces({ driverId: ref.driverId })).toMatchObject({
    current: null,
    entries: [{ ref: "folder-a" }],
  });
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.workspacesCreateFolder, {
    displayName: "New Folder",
    hidden: false,
    ref: "folder-new",
    selectable: true,
  });
  expect(
    await connection.createWorkspaceFolder({
      driverId: ref.driverId,
      idempotencyKey: "workspace-create-folder-a",
      name: "New Folder",
      parentFolderRef: "folder-a",
    }),
  ).toEqual({
    displayName: "New Folder",
    hidden: false,
    ref: "folder-new",
    selectable: true,
  });
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.workspacesRegister, {
    created: true,
    workspace: { displayName: "Projects", ref: "workspace-b" },
  });
  expect(
    await connection.registerWorkspace({
      driverId: ref.driverId,
      folderRef: "folder-a",
      idempotencyKey: "workspace-register-a",
    }),
  ).toEqual({
    created: true,
    workspace: { displayName: "Projects", ref: "workspace-b" },
  });
  transport.emit(entryEvent());
  transport.emit(hostEvent());

  expect(deliveries).toHaveLength(2);
  expect(deliveries[0]).toMatchObject({
    event: { cursor: 1, entry: { id: "entry-a" }, type: "entry.appended" },
    ref,
    transportEvent: { eventSeq: 1 },
  });
  expect(deliveries[1]).toMatchObject({ event: { revision: "2", type: "host.models.changed" } });
  expect(deliveries[1]).not.toHaveProperty("ref");
  expect("acknowledge" in connection).toBe(false);
  connection.close();
});

test("v2 hello rejects a client with no common protocol version", async () => {
  const transport = new FakeV2Transport();
  const connection = new OrbisRemoteAgentV2Connection(transport);

  expect(
    await rejected(() =>
      connection.hello({ device: { name: "Old client" }, supportedVersions: [1] }),
    ),
  ).toMatchObject({ code: "version_unsupported" });
});

test("v2 connection preserves protocol failures returned by the host", async () => {
  const transport = new FakeV2Transport();
  transport.reject(
    ORBIS_REMOTE_AGENT_V2_METHODS.hello,
    new OrbisTransportError("remote_request", "The remote request failed", {
      serverCode: "protocol",
    }),
  );
  const connection = new OrbisRemoteAgentV2Connection(transport);

  expect(
    await rejected(() =>
      connection.hello({ device: { name: "Test phone" }, supportedVersions: [2] }),
    ),
  ).toMatchObject({
    code: "protocol",
    details: { serverCode: "protocol" },
  });
});

test("ignores unknown state/transient events but rejects unknown replayable events", async () => {
  const transport = new FakeV2Transport();
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, helloResult());
  const connection = new OrbisRemoteAgentV2Connection(transport);
  const errors: unknown[] = [];
  const deliveries: unknown[] = [];
  connection.onProtocolError((error) => errors.push(error));
  connection.onEvent((delivery) => deliveries.push(delivery));
  await connection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });

  transport.emit(unknownSessionEvent("state", "session.future.changed"));
  transport.emit(unknownSessionEvent("transient", "entry.future"));
  expect(errors).toHaveLength(0);
  expect(deliveries).toHaveLength(0);

  transport.emit(unknownSessionEvent("replayable", "entry.future"));
  expect(errors).toMatchObject([{ code: "protocol" }]);
  expect(deliveries).toHaveLength(0);
});

test("v2 sync validates the cursor and entry identity pair", async () => {
  const transport = new FakeV2Transport();
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, helloResult());
  const connection = new OrbisRemoteAgentV2Connection(transport);
  await connection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });

  expect(
    await rejected(() =>
      connection.sync({
        afterCursor: 0,
        afterEntryId: "entry-a",
        mode: "once",
        ref,
      }),
    ),
  ).toMatchObject({ code: "invalid_argument" });
  expect(
    await rejected(() =>
      connection.sync({
        afterCursor: 1,
        afterEntryId: null,
        mode: "once",
        ref,
      }),
    ),
  ).toMatchObject({ code: "invalid_argument" });
  expect(transport.requests).toHaveLength(1);
});

test("v2 sync returns the host revision used for cache reconciliation", async () => {
  const transport = new FakeV2Transport();
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, helloResult());
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync, {
    entries: [],
    hasOlder: false,
    hostRevision: "revision-b",
    kind: "snapshot",
    oldestCursor: 0,
    state: {
      configOptions: {},
      createdAt: "2026-08-11T00:00:00.000Z",
      cwd: null,
      leafEntryId: null,
      mode: null,
      model: null,
      pendingInputs: [],
      pendingPermissions: [],
      ref: {
        backendId: ref.backendId,
        driverId: ref.driverId,
        nativeSessionId: ref.nativeSessionId,
        sessionId: ref.sessionId,
      },
      revision: 0,
      runState: "idle",
      title: null,
      updatedAt: "2026-08-11T00:00:00.000Z",
      workspaceRef: null,
    },
  });
  const connection = new OrbisRemoteAgentV2Connection(transport);
  await connection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });

  const result = await connection.sync({ mode: "once", ref });

  expect(result).toMatchObject({ hostRevision: "revision-b", kind: "snapshot" });
});

test("v2 connection rejects a session event whose scope disagrees with its source", async () => {
  const transport = new FakeV2Transport();
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, helloResult());
  const connection = new OrbisRemoteAgentV2Connection(transport);
  const errors: unknown[] = [];
  const deliveries: unknown[] = [];
  connection.onProtocolError((error) => errors.push(error));
  connection.onEvent((delivery) => deliveries.push(delivery));
  await connection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });

  const original = entryEvent();
  const payload = original.payload as Record<string, JsonValue>;
  const mismatched = {
    ...original,
    payload: {
      ...payload,
      scope: {
        kind: "session",
        ref: {
          backendId: "remote:other-host",
          driverId: ref.driverId,
          nativeSessionId: ref.nativeSessionId,
          sessionId: ref.sessionId,
        },
      },
    },
  } as TransportEvent;
  transport.emit(mismatched);

  expect(deliveries).toHaveLength(0);
  expect(errors).toMatchObject([{ code: "protocol" }]);
});
