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

function params(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

class FakeV2Transport {
  readonly methods: readonly string[];
  readonly requests: Array<{ readonly method: string; readonly params: JsonValue }> = [];
  readonly requestSignals: Array<AbortSignal | undefined> = [];
  private readonly closeListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: TransportEvent) => void>();
  private readonly errors = new Map<string, unknown>();
  private readonly responses = new Map<string, JsonValue>();
  private readonly responders = new Map<string, (params: JsonValue) => JsonValue>();

  constructor(methods: readonly string[] = ORBIS_REMOTE_AGENT_V2_METHOD_LIST) {
    this.methods = methods;
  }

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

  async request(
    method: string,
    params: JsonValue,
    options?: { readonly signal?: AbortSignal },
  ): Promise<JsonValue> {
    this.requests.push({ method, params });
    this.requestSignals.push(options?.signal);
    const error = this.errors.get(method);
    if (error !== undefined) throw error;
    const responder = this.responders.get(method);
    if (responder !== undefined) return responder(params);
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

  respondWith(method: string, responder: (params: JsonValue) => JsonValue): void {
    this.responders.set(method, responder);
  }
}

function subagentHelloResult(): JsonValue {
  const result = helloResult() as unknown as {
    readonly drivers: readonly Record<string, JsonValue>[];
  };
  return {
    ...result,
    drivers: [
      {
        ...result.drivers[0],
        capabilities: ["session.subagents.list"],
      },
    ],
  };
}

function helloResult(): JsonValue {
  return {
    capabilities: {
      attachments: false,
      dispose: false,
      fork: false,
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

function attachmentHelloResult(
  input: {
    readonly maxImageBytes?: number;
    readonly downloadChunkBytes?: number;
    readonly uploadChunkBytes?: number;
  } = {},
): JsonValue {
  return {
    capabilities: {
      attachments: {
        downloadChunkBytes: input.downloadChunkBytes ?? 3,
        maxImageBytes: input.maxImageBytes ?? 6,
        maxImagesPerMessage: 4,
        maxMessageImageBytes: 12,
        mimeTypes: ["image/png"],
        uploadChunkBytes: input.uploadChunkBytes ?? 3,
      },
      dispose: false,
      fork: false,
      presence: false,
    },
    drivers: [{ capabilities: [], displayName: "DeepSeek Harness", id: "dsh" }],
    hostId: "remote:host-a",
    hostRevision: "revision-a",
    limits: { maxPromptBytes: 1024, maxReplayBatch: 16, maxSnapshotWindow: 16 },
    version: 2,
  };
}

function referenceHelloResult(): JsonValue {
  const result = helloResult() as unknown as {
    readonly drivers: readonly Record<string, JsonValue>[];
  };
  return {
    ...result,
    drivers: [
      {
        ...result.drivers[0],
        capabilities: ["prompt.references.files", "prompt.references.sessions"],
      },
    ],
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
    settlesEntryId: "stream:1",
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

function toolStateEvent(): TransportEvent {
  const occurredAt = agentTimestamp("2026-08-11T00:00:03.000Z");
  const event = {
    channel: "transient",
    eventId: "tool-state-a",
    occurredAt,
    sessionId: ref.sessionId,
    source: { backendId: ref.backendId, driverId: ref.driverId },
    tool: {
      callId: "call-a",
      entryId: "tool-call-a",
      input: { path: "/workspace/demo.ts" },
      name: "read",
      status: "running",
    },
    type: "tool.state.changed",
  };
  return {
    durability: "transient",
    eventId: "tool-state-a",
    eventSeq: 2,
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

function toolInputDeltaEvent(): TransportEvent {
  const occurredAt = agentTimestamp("2026-08-11T00:00:04.000Z");
  const event = {
    blockIndex: 0,
    channel: "transient",
    chunkSeq: 1,
    delta: '{"path":"/workspace/demo.ts"}',
    entryId: "tool-call-a",
    eventId: "tool-input-a",
    occurredAt,
    part: "tool_input",
    sessionId: ref.sessionId,
    source: { backendId: ref.backendId, driverId: ref.driverId },
    type: "entry.delta",
  };
  return {
    durability: "transient",
    eventId: "tool-input-a",
    eventSeq: 3,
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
    event: {
      cursor: 1,
      entry: { id: "entry-a" },
      settlesEntryId: "stream:1",
      type: "entry.appended",
    },
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

test("v2 connection decodes tool state and tool input events", async () => {
  const transport = new FakeV2Transport();
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, helloResult());
  const connection = new OrbisRemoteAgentV2Connection(transport);
  const deliveries: unknown[] = [];
  connection.onEvent((delivery) => deliveries.push(delivery));
  await connection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });

  transport.emit(toolStateEvent());
  transport.emit(toolInputDeltaEvent());

  expect(deliveries).toMatchObject([
    {
      event: {
        tool: {
          callId: "call-a",
          entryId: "tool-call-a",
          input: { path: "/workspace/demo.ts" },
          name: "read",
          status: "running",
        },
        type: "tool.state.changed",
      },
    },
    {
      event: {
        entryId: "tool-call-a",
        part: "tool_input",
        type: "entry.delta",
      },
    },
  ]);
});

test("v2 connection round-trips canonical question responses and whole work state", async () => {
  const transport = new FakeV2Transport();
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, helloResult());
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.sessionsRespondQuestion, { accepted: true });
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSync, {
    baseline: true,
    entries: [],
    hasMore: false,
    hasOlder: false,
    hostRevision: "revision-question",
    oldestCursor: 0,
    throughCursor: 0,
    state: {
      configOptions: [],
      createdAt: "2026-08-11T00:00:00.000Z",
      cwd: null,
      leafEntryId: null,
      mode: "plan",
      model: null,
      pendingInputs: [],
      pendingPermissions: [],
      pendingQuestions: [
        {
          questions: [
            {
              multiSelect: false,
              options: [{ label: "Approve", optionId: "approve" }],
              question: "Continue?",
              questionId: "plan-review",
            },
          ],
          requestId: "question-1",
          requestedAt: "2026-08-11T00:00:00.000Z",
        },
      ],
      ref: {
        backendId: ref.backendId,
        driverId: ref.driverId,
        nativeSessionId: ref.nativeSessionId,
        sessionId: ref.sessionId,
      },
      revision: 1,
      runState: "idle",
      title: null,
      updatedAt: "2026-08-11T00:00:00.000Z",
      workState: {
        goal: null,
        todos: [{ content: "Review", status: "pending" }],
      },
      workspaceRef: null,
    },
  });
  const connection = new OrbisRemoteAgentV2Connection(transport);
  await connection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });

  await expect(
    connection.respondQuestion({
      idempotencyKey: "question-response-1",
      ref,
      requestId: "question-1",
      response: { kind: "cancelled" },
    }),
  ).resolves.toEqual({ accepted: true });
  const sync = await connection.sync({ mode: "once", ref });

  expect(sync).toMatchObject({
    state: {
      mode: "plan",
      pendingQuestions: [{ requestId: "question-1" }],
      workState: { goal: null, todos: [{ content: "Review", status: "pending" }] },
    },
  });
  expect(transport.requests.at(-2)).toEqual({
    method: ORBIS_REMOTE_AGENT_V2_METHODS.sessionsRespondQuestion,
    params: {
      idempotencyKey: "question-response-1",
      ref: {
        backendId: ref.backendId,
        driverId: ref.driverId,
        nativeSessionId: ref.nativeSessionId,
        sessionId: ref.sessionId,
      },
      requestId: "question-1",
      response: { kind: "cancelled" },
    },
  });
});

test("v2 connection uploads canonical chunks with raw-byte offsets", async () => {
  const transport = new FakeV2Transport();
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, attachmentHelloResult());
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadBegin, { uploadId: "upload-1" });
  transport.respondWith(ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadChunk, (params) => {
    const input = params as { readonly data: string; readonly offset: number };
    const chunkBytes = input.data === "AQID" || input.data === "BAUG" ? 3 : 0;
    return { nextOffset: input.offset + chunkBytes, uploadId: "upload-1" };
  });
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadFinish, {
    uploadId: "upload-1",
  });
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadAbort, {
    aborted: true,
    uploadId: "upload-1",
  });
  const connection = new OrbisRemoteAgentV2Connection(transport);
  await connection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });

  await expect(
    connection.uploadAttachment({
      data: "AQIDBAUG",
      mimeType: "image/png",
      ref,
      totalBytes: 6,
      uploadId: "upload-1",
    }),
  ).resolves.toEqual({ uploadId: "upload-1" });
  expect(
    transport.requests
      .filter(({ method }) => method === ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsUploadChunk)
      .map(({ params }) => params as { readonly data: string; readonly offset: number }),
  ).toEqual([
    expect.objectContaining({ data: "AQID", offset: 0 }),
    expect.objectContaining({ data: "BAUG", offset: 3 }),
  ]);
  await expect(connection.abortAttachment("upload-1")).resolves.toEqual({
    aborted: true,
    uploadId: "upload-1",
  });
});

test("v2 connection reconstructs bounded attachment reads and rejects unstable metadata", async () => {
  const transport = new FakeV2Transport();
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, attachmentHelloResult());
  transport.respondWith(ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsRead, (params) => {
    const input = params as { readonly offset: number };
    return input.offset === 0
      ? {
          attachmentId: "attachment-1",
          bytes: 6,
          data: "AQID",
          eof: false,
          height: 2,
          mimeType: "image/png",
          name: "image.png",
          nextOffset: 3,
          width: 3,
        }
      : {
          attachmentId: "attachment-1",
          bytes: 6,
          data: "BAUG",
          eof: true,
          height: 2,
          mimeType: "image/png",
          name: "image.png",
          nextOffset: 6,
          width: 3,
        };
  });
  const connection = new OrbisRemoteAgentV2Connection(transport);
  await connection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });
  await expect(connection.readAttachment(ref, "attachment-1")).resolves.toEqual({
    attachmentId: "attachment-1",
    bytes: 6,
    data: "AQIDBAUG",
    height: 2,
    mimeType: "image/png",
    name: "image.png",
    width: 3,
  });

  const oversized = new FakeV2Transport();
  oversized.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, attachmentHelloResult());
  oversized.respond(ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsRead, {
    attachmentId: "attachment-oversized",
    bytes: 7,
    data: "AQID",
    eof: false,
    mimeType: "image/png",
    nextOffset: 3,
  });
  const oversizedConnection = new OrbisRemoteAgentV2Connection(oversized);
  await oversizedConnection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });
  expect(
    await rejected(() => oversizedConnection.readAttachment(ref, "attachment-oversized")),
  ).toMatchObject({
    code: "protocol",
  });

  const unstable = new FakeV2Transport();
  unstable.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, attachmentHelloResult());
  unstable.respondWith(ORBIS_REMOTE_AGENT_V2_METHODS.attachmentsRead, (params) => {
    const input = params as { readonly offset: number };
    return {
      attachmentId: "attachment-unstable",
      bytes: 6,
      data: input.offset === 0 ? "AQID" : "BAUG",
      eof: input.offset !== 0,
      mimeType: "image/png",
      name: input.offset === 0 ? "first.png" : "changed.png",
      nextOffset: input.offset + 3,
    };
  });
  const unstableConnection = new OrbisRemoteAgentV2Connection(unstable);
  await unstableConnection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });
  expect(
    await rejected(() => unstableConnection.readAttachment(ref, "attachment-unstable")),
  ).toMatchObject({
    code: "protocol",
  });
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

test("v2 prompt reference completion selects the source method and forwards cancellation", async () => {
  const transport = new FakeV2Transport();
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, referenceHelloResult());
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.promptReferencesFiles, {
    candidates: [{ insertText: "@src/", kind: "directory", label: "src" }],
    end: 8,
    start: 4,
  });
  const connection = new OrbisRemoteAgentV2Connection(transport);
  await connection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });
  const signal = new AbortController().signal;
  await expect(
    connection.completePromptReferences({
      cursor: 8,
      limit: 4,
      ref,
      signal,
      source: "files",
      text: "See @src",
    }),
  ).resolves.toMatchObject({ start: 4, end: 8 });
  expect(transport.requests.at(-1)).toEqual({
    method: ORBIS_REMOTE_AGENT_V2_METHODS.promptReferencesFiles,
    params: {
      cursor: 8,
      limit: 4,
      ref: {
        backendId: ref.backendId,
        driverId: ref.driverId,
        nativeSessionId: ref.nativeSessionId,
        sessionId: ref.sessionId,
      },
      source: "files",
      text: "See @src",
    },
  });
});

test("v2 subagent listing gates the driver and validates nested stable order", async () => {
  const transport = new FakeV2Transport();
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, subagentHelloResult());
  transport.respond(
    ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSubagentsList,
    params({
      entries: [
        {
          activity: "running",
          depth: 1,
          hasChildren: true,
          kind: "child",
          label: "Worker",
          mode: "continuable",
          parentRef: ref,
          ref: { ...ref, nativeSessionId: "native-child", sessionId: "child" },
        },
        {
          depth: 2,
          kind: "diagnostic",
          parentRef: { ...ref, nativeSessionId: "native-child", sessionId: "child" },
          reason: "unavailable",
          ref: { ...ref, nativeSessionId: "native-diagnostic", sessionId: "diagnostic" },
        },
      ],
    }),
  );
  const connection = new OrbisRemoteAgentV2Connection(transport);
  await connection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });
  const controller = new AbortController();
  const entries = await connection.listSessionSubagents(ref, controller.signal);

  expect(entries.map((entry) => entry.ref.sessionId)).toEqual(["child", "diagnostic"]);
  expect(transport.requests.at(-1)).toMatchObject({
    method: ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSubagentsList,
    params: { ref },
  });
  expect(transport.requestSignals.at(-1)).toBe(controller.signal);
});

test("v2 subagent listing rejects an unadvertised driver capability", async () => {
  const transport = new FakeV2Transport();
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, helloResult());
  const connection = new OrbisRemoteAgentV2Connection(transport);
  await connection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });

  expect(await rejected(() => connection.listSessionSubagents(ref))).toMatchObject({
    code: "unsupported",
  });
  expect(transport.requests).toHaveLength(1);
});

test("v2 subagent listing rejects a host that does not advertise the method", async () => {
  const transport = new FakeV2Transport(
    ORBIS_REMOTE_AGENT_V2_METHOD_LIST.filter(
      (method) => method !== ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSubagentsList,
    ),
  );
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, subagentHelloResult());
  const connection = new OrbisRemoteAgentV2Connection(transport);
  await connection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });

  expect(await rejected(() => connection.listSessionSubagents(ref))).toMatchObject({
    code: "unsupported",
  });
  expect(transport.requests).toHaveLength(1);
});

test("v2 prompt reference completion rejects unsupported drivers and mixed source candidates", async () => {
  const transport = new FakeV2Transport();
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.hello, referenceHelloResult());
  transport.respond(ORBIS_REMOTE_AGENT_V2_METHODS.promptReferencesSessions, {
    candidates: [{ insertText: "@path", kind: "file", label: "path" }],
    end: 8,
    start: 4,
  });
  const connection = new OrbisRemoteAgentV2Connection(transport);
  await connection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });
  expect(
    await rejected(() =>
      connection.completePromptReferences({
        cursor: 8,
        limit: 4,
        ref: { ...ref, driverId: "other" as typeof ref.driverId },
        source: "files",
        text: "See @src",
      }),
    ),
  ).toMatchObject({ code: "unsupported" });
  expect(
    await rejected(() =>
      connection.completePromptReferences({
        cursor: 8,
        limit: 4,
        ref,
        source: "sessions",
        text: "See @src",
      }),
    ),
  ).toMatchObject({ code: "protocol" });
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
    baseline: true,
    entries: [],
    hasMore: false,
    hasOlder: false,
    hostRevision: "revision-b",
    oldestCursor: 0,
    throughCursor: 0,
    overlay: {
      runId: "run-a",
      runningTools: [
        {
          callId: "call-a",
          chunkSeq: 0,
          entryId: "tool-call-a",
          name: "read",
          status: "pending",
        },
      ],
    },
    state: {
      configOptions: [],
      createdAt: "2026-08-11T00:00:00.000Z",
      cwd: null,
      leafEntryId: null,
      mode: null,
      model: null,
      pendingInputs: [],
      pendingPermissions: [],
      pendingQuestions: [],
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
      workState: { goal: null, todos: [] },
    },
  });
  const connection = new OrbisRemoteAgentV2Connection(transport);
  await connection.hello({ device: { name: "Test phone" }, supportedVersions: [2] });

  const result = await connection.sync({ mode: "once", ref });

  expect(result).toMatchObject({
    baseline: true,
    hostRevision: "revision-b",
    overlay: { runningTools: [{ chunkSeq: 0 }] },
  });
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
