import { describe, expect, test } from "vitest";

import { sha256 } from "@hpke/common";
import { z } from "zod";

import {
  acceptSecureInitiatorHandshake,
  fingerprintPublicKey,
  generateDeviceIdentity,
  secureHelloEnvelopeSchema,
  secureMessageEnvelopeSchema,
  type OrbisSecureChannel,
  type SecureRandom,
  type SerializedDeviceIdentity,
} from "./e2ee";
import type { HostEndpointManifest } from "./endpoints";
import { OrbisTransportError } from "./errors";
import {
  ORBIS_TRANSPORT_PROTOCOL_VERSION,
  ORBIS_TRANSPORT_SUBPROTOCOL,
  type ConnectionTicket,
  type JsonValue,
  type RemoteHost,
  type TransportEvent,
} from "./protocol";
import {
  OrbisRemoteConnection,
  type ConnectRemoteOptions,
  type WebSocketEvent,
  type WebSocketEventListener,
  type WebSocketEventType,
  type WebSocketFactoryRequest,
  type WebSocketLike,
} from "./websocket";

const NOW = Date.parse("2026-08-09T00:00:00.000Z");
const FUTURE = "2026-08-09T00:01:00.000Z";

function deterministicRandom(label: string): SecureRandom {
  let counter = 0;
  return async (length) => {
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const block = sha256(new TextEncoder().encode(`${label}:${counter++}`));
      const chunk = block.subarray(0, Math.min(block.length, length - offset));
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  };
}

let identityFixture: Promise<{ client: SerializedDeviceIdentity; host: SerializedDeviceIdentity }>;
function identities() {
  identityFixture ??= Promise.all([
    generateDeviceIdentity(deterministicRandom("websocket-client")),
    generateDeviceIdentity(deterministicRandom("websocket-host")),
  ]).then(([client, host]) => ({ client, host }));
  return identityFixture;
}

function hostDescriptor(identity: SerializedDeviceIdentity): RemoteHost {
  return {
    id: "host-1",
    name: "Remote Mac",
    platform: "darwin-arm64",
    status: "online",
    publicKeyFingerprint: fingerprintPublicKey(identity.publicKey),
    harnesses: [{ id: "pi", version: "0.83.0", capabilities: ["sessions"] }],
  };
}

function ticketFor(identity: SerializedDeviceIdentity): ConnectionTicket {
  return {
    ticket: "single-use-ticket-secret",
    expiresAt: FUTURE,
    websocketUrl: "wss://remote.example/connect?route=host-1",
    protocol: ORBIS_TRANSPORT_SUBPROTOCOL,
    host: hostDescriptor(identity),
  };
}

function endpointManifest(
  identity: SerializedDeviceIdentity,
  url = "wss://remote.example/connect",
): HostEndpointManifest {
  return {
    hostId: "host-1",
    hostKeyId: fingerprintPublicKey(identity.publicKey),
    revision: 1,
    endpoints: [{ kind: url.startsWith("ws:") ? "lan" : "tunnel", url }],
  };
}

const durableEvent: TransportEvent = {
  eventId: "event-1",
  sessionId: "session-1",
  runId: "run-1",
  eventSeq: 7,
  time: "2026-08-09T00:00:01.000Z",
  durability: "durable",
  type: "assistant.delta",
  payload: { text: "hello" },
  source: { harness: "pi", nativeType: "message_update", version: "0.83.0" },
};

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  protocol: string = ORBIS_TRANSPORT_SUBPROTOCOL;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<WebSocketEventType, Set<WebSocketEventListener>>();

  addEventListener(type: WebSocketEventType, listener: WebSocketEventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<WebSocketEventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WebSocketEventType, listener: WebSocketEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error("Socket is not open");
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 2;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(frame: unknown): void {
    this.emit("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  receiveBinary(data: unknown): void {
    this.emit("message", { data });
  }

  remoteClose(code = 1000, reason = "", wasClean = true): void {
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean });
  }

  fail(error: unknown): void {
    this.emit("error", { error });
  }

  private emit(type: WebSocketEventType, event: WebSocketEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

function sequentialIds() {
  let value = 0;
  return () => `frame-${++value}`;
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

async function sentEnvelope(
  socket: FakeWebSocket,
  index: number,
): Promise<Record<string, unknown>> {
  await waitFor(() => socket.sent.length > index, `Timed out waiting for sent frame ${index}`);
  return JSON.parse(socket.sent[index] as string) as Record<string, unknown>;
}

function expectTransportError(
  error: unknown,
  code: OrbisTransportError["code"],
): asserts error is OrbisTransportError {
  expect(error).toBeInstanceOf(OrbisTransportError);
  expect((error as OrbisTransportError).code).toBe(code);
}

interface Established {
  connection: OrbisRemoteConnection;
  socket: FakeWebSocket;
  serverChannel: OrbisSecureChannel;
  factoryRequest: WebSocketFactoryRequest;
  nextClientFrame(): Promise<JsonValue>;
  sendServerFrame(frame: JsonValue): Promise<void>;
}

async function establish(overrides: Partial<ConnectRemoteOptions> = {}): Promise<Established> {
  const { client, host } = await identities();
  const socket = new FakeWebSocket();
  let factoryRequest: WebSocketFactoryRequest | undefined;
  const connecting = OrbisRemoteConnection.connect({
    ticket: ticketFor(host),
    peer: { deviceId: "device-1", role: "client", version: "1.0.0" },
    security: { mode: "authenticated", identity: client, remotePublicKey: host.publicKey },
    random: deterministicRandom("websocket-client-ephemeral"),
    webSocketFactory: (request) => {
      factoryRequest = request;
      return socket;
    },
    createId: sequentialIds(),
    now: () => NOW,
    ...overrides,
  });

  socket.open();
  const helloEnvelope = secureHelloEnvelopeSchema.parse(await sentEnvelope(socket, 0));
  const responder = await acceptSecureInitiatorHandshake(helloEnvelope, {
    identity: host,
    random: deterministicRandom("websocket-host-ephemeral"),
    resolvePeer: async () => ({ publicKey: client.publicKey }),
  });
  const hello = responder.hello as { id: string; raceId: string };
  const response = await responder.respond({
    kind: "welcome",
    id: hello.id,
    protocolVersion: ORBIS_TRANSPORT_PROTOCOL_VERSION,
    connectionId: "connection-1",
    host: hostDescriptor(host),
    capabilities: { methods: ["session.prompt", "session.cancel"] },
    endpointManifest: endpointManifest(host),
  });
  socket.receive(response.frame);
  const activationEnvelope = secureMessageEnvelopeSchema.parse(await sentEnvelope(socket, 1));
  const activation = (await response.channel.open(activationEnvelope)) as {
    id: string;
    kind: string;
    raceId: string;
  };
  expect(activation).toMatchObject({ kind: "activate", raceId: hello.raceId });
  socket.receive(
    await response.channel.seal({
      kind: "activated",
      id: "server-activated",
      raceId: hello.raceId,
    }),
  );
  const connection = await connecting;
  let nextSentIndex = 2;

  return {
    connection,
    socket,
    serverChannel: response.channel,
    factoryRequest: factoryRequest as WebSocketFactoryRequest,
    nextClientFrame: async () => {
      const envelope = secureMessageEnvelopeSchema.parse(await sentEnvelope(socket, nextSentIndex));
      nextSentIndex += 1;
      return response.channel.open(envelope);
    },
    sendServerFrame: async (frame) => {
      socket.receive(await response.channel.seal(frame));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("OrbisRemoteConnection encrypted handshake", () => {
  test("keeps the ticket in Upgrade Authorization and all peer metadata inside HPKE", async () => {
    const established = await establish();
    const outerHello = JSON.parse(established.socket.sent[0] as string);

    expect(established.factoryRequest.url).toBe("wss://remote.example/connect?route=host-1");
    expect(established.factoryRequest.url).not.toContain("single-use-ticket-secret");
    expect(established.factoryRequest.protocols).toEqual([ORBIS_TRANSPORT_SUBPROTOCOL]);
    expect(established.factoryRequest.headers).toEqual({
      Authorization: "Bearer single-use-ticket-secret",
    });
    expect(JSON.stringify(outerHello)).not.toContain("device-1");
    expect(JSON.stringify(outerHello)).not.toContain("single-use-ticket-secret");
    expect(outerHello.kind).toBe("secure_hello");
    expect(established.connection.state).toBe("open");
    expect(established.connection.welcome.connectionId).toBe("connection-1");
  });

  test("opens a QR-pinned direct LAN socket without a relay ticket", async () => {
    const { client, host } = await identities();
    const socket = new FakeWebSocket();
    let factoryRequest: WebSocketFactoryRequest | undefined;
    const connecting = OrbisRemoteConnection.connectEndpoint({
      websocketUrl: "ws://192.168.50.10:47000/orbis",
      hostId: "host-1",
      peer: { deviceId: "device-1", role: "client", version: "1.0.0" },
      security: { mode: "authenticated", identity: client, remotePublicKey: host.publicKey },
      random: deterministicRandom("direct-client-ephemeral"),
      webSocketFactory: (request) => {
        factoryRequest = request;
        return socket;
      },
      createId: sequentialIds(),
    });

    socket.open();
    const helloEnvelope = secureHelloEnvelopeSchema.parse(await sentEnvelope(socket, 0));
    const responder = await acceptSecureInitiatorHandshake(helloEnvelope, {
      identity: host,
      random: deterministicRandom("direct-host-ephemeral"),
      resolvePeer: async () => ({ publicKey: client.publicKey }),
    });
    const hello = responder.hello as { id: string; raceId: string };
    const response = await responder.respond({
      kind: "welcome",
      id: hello.id,
      protocolVersion: ORBIS_TRANSPORT_PROTOCOL_VERSION,
      connectionId: "direct-connection-1",
      host: hostDescriptor(host),
      capabilities: { methods: ["session.prompt"] },
      endpointManifest: endpointManifest(host, "ws://192.168.50.10:47000/orbis"),
    });
    socket.receive(response.frame);

    const activationEnvelope = secureMessageEnvelopeSchema.parse(await sentEnvelope(socket, 1));
    expect(await response.channel.open(activationEnvelope)).toMatchObject({
      kind: "activate",
      raceId: hello.raceId,
    });
    socket.receive(
      await response.channel.seal({
        kind: "activated",
        id: "direct-server-activated",
        raceId: hello.raceId,
      }),
    );

    const connection = await connecting;
    expect(factoryRequest?.url).toBe("ws://192.168.50.10:47000/orbis");
    expect(factoryRequest?.headers).toEqual({});
    expect(connection.welcome.connectionId).toBe("direct-connection-1");
  });

  test("rejects insecure, expired, URL-embedded, and host-key-mismatched tickets pre-socket", async () => {
    const { client, host } = await identities();
    let factoryCalls = 0;
    const base = {
      peer: { deviceId: "device-1", role: "client" as const, version: "1.0.0" },
      security: {
        mode: "authenticated" as const,
        identity: client,
        remotePublicKey: host.publicKey,
      },
      random: deterministicRandom("preflight"),
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeWebSocket();
      },
      createId: sequentialIds(),
      now: () => NOW,
    };

    const cases: Array<{ ticket: ConnectionTicket; code: OrbisTransportError["code"] }> = [
      {
        ticket: { ...ticketFor(host), websocketUrl: "ws://remote.example/connect" },
        code: "insecure_transport",
      },
      {
        ticket: { ...ticketFor(host), expiresAt: new Date(NOW).toISOString() },
        code: "authentication",
      },
      {
        ticket: {
          ...ticketFor(host),
          websocketUrl: "wss://remote.example/connect?ticket=single-use-ticket-secret",
        },
        code: "protocol",
      },
      {
        ticket: {
          ...ticketFor(host),
          host: { ...hostDescriptor(host), publicKeyFingerprint: "sha256:wrong" },
        },
        code: "authentication",
      },
    ];

    for (const fixture of cases) {
      await OrbisRemoteConnection.connect({ ...base, ticket: fixture.ticket }).then(
        () => {
          throw new Error("Expected preflight rejection");
        },
        (error) => expectTransportError(error, fixture.code),
      );
    }
    expect(factoryCalls).toBe(0);
  });

  test("rejects a socket without the subprotocol and times out an incomplete handshake", async () => {
    const { client, host } = await identities();
    const missingProtocol = new FakeWebSocket();
    missingProtocol.protocol = "";
    const rejected = OrbisRemoteConnection.connect({
      ticket: ticketFor(host),
      peer: { deviceId: "device-1", role: "client", version: "1.0.0" },
      security: { mode: "authenticated", identity: client, remotePublicKey: host.publicKey },
      random: deterministicRandom("missing-protocol"),
      webSocketFactory: () => missingProtocol,
      createId: sequentialIds(),
      now: () => NOW,
    });
    missingProtocol.open();
    await rejected.then(
      () => {
        throw new Error("Expected subprotocol rejection");
      },
      (error) => expectTransportError(error, "protocol"),
    );

    const timeoutSocket = new FakeWebSocket();
    const timedOut = OrbisRemoteConnection.connect({
      ticket: ticketFor(host),
      peer: { deviceId: "device-1", role: "client", version: "1.0.0" },
      security: { mode: "authenticated", identity: client, remotePublicKey: host.publicKey },
      random: deterministicRandom("timeout"),
      webSocketFactory: () => timeoutSocket,
      createId: sequentialIds(),
      now: () => NOW,
      handshakeTimeoutMs: 5,
    });
    timeoutSocket.open();
    await timedOut.then(
      () => {
        throw new Error("Expected timeout");
      },
      (error) => expectTransportError(error, "timeout"),
    );
  });
});

describe("OrbisRemoteConnection encrypted requests", () => {
  test("keeps ordinary diagnostics payload-free and exposes application frames only to an explicit observer", async () => {
    const established = await establish();
    const diagnostics: unknown[] = [];
    const applicationFrames: unknown[] = [];
    established.connection.onDiagnostic((event) => diagnostics.push(event));
    established.connection.onApplicationFrame(() => {
      throw new Error("Debug observation must not affect transport delivery");
    });
    established.connection.onApplicationFrame((frame) => applicationFrames.push(frame));

    const pending = established.connection.request(
      "session.prompt",
      { text: "visible only in debug diagnostics" },
      z.object({ accepted: z.boolean() }),
    );
    const request = (await established.nextClientFrame()) as { requestId: string };
    await established.sendServerFrame({
      kind: "response",
      id: "server-response",
      requestId: request.requestId,
      result: { accepted: true },
    });
    await pending;
    const failed = established.connection.request("session.list", {}, z.object({}));
    const failedOutcome = failed.then(
      () => {
        throw new Error("Expected remote request failure");
      },
      (error) => expectTransportError(error, "remote_request"),
    );
    const failedRequest = (await established.nextClientFrame()) as { requestId: string };
    await established.sendServerFrame({
      error: {
        code: "conflict",
        message: "sensitive remote error detail",
      },
      id: "server-error",
      kind: "error",
      requestId: failedRequest.requestId,
    });
    await failedOutcome;
    await established.sendServerFrame({ kind: "event", id: "server-event", event: durableEvent });
    established.socket.remoteClose(1012, "sensitive close reason", false);

    expect(diagnostics).toMatchObject([
      { method: "session.prompt", requestId: request.requestId, type: "request_started" },
      { method: "session.prompt", requestId: request.requestId, type: "request_succeeded" },
      { method: "session.list", requestId: failedRequest.requestId, type: "request_started" },
      {
        errorCode: "remote_request",
        method: "session.list",
        requestId: failedRequest.requestId,
        serverCode: "conflict",
        type: "request_failed",
      },
      { cursor: 7, type: "event_received" },
      { code: 1012, type: "closed", wasClean: false },
    ]);
    expect(applicationFrames).toMatchObject([
      {
        direction: "outbound",
        kind: "request",
        method: "session.prompt",
        payload: { text: "visible only in debug diagnostics" },
      },
      { direction: "inbound", kind: "response", payload: { accepted: true } },
      { direction: "outbound", kind: "request", method: "session.list", payload: {} },
      { direction: "inbound", kind: "event", payload: durableEvent.payload },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("visible only in debug diagnostics");
    expect(JSON.stringify(applicationFrames)).toContain("visible only in debug diagnostics");
    expect(JSON.stringify(applicationFrames)).not.toContain("single-use-ticket-secret");
    expect(JSON.stringify(diagnostics)).toContain("conflict");
    expect(JSON.stringify(diagnostics)).not.toContain("sensitive remote error detail");
    expect(JSON.stringify(diagnostics)).not.toContain("sensitive close reason");
  });

  test("correlates and validates a response without exposing the request on the socket", async () => {
    const established = await establish();
    const pending = established.connection.request(
      "session.prompt",
      { sessionId: "session-1", text: "private prompt" },
      z.object({ accepted: z.boolean() }).strict(),
    );
    const outer = await sentEnvelope(established.socket, 1);
    expect(JSON.stringify(outer)).not.toContain("private prompt");
    const request = (await established.nextClientFrame()) as {
      requestId: string;
      method: string;
      params: JsonValue;
    };
    expect(request.method).toBe("session.prompt");
    await established.sendServerFrame({
      kind: "response",
      id: "server-1",
      requestId: request.requestId,
      result: { accepted: true },
    });
    expect(await pending).toEqual({ accepted: true });
  });

  test("maps redacted remote errors and keeps result schema failures connection-local", async () => {
    const remoteErrorCase = await establish();
    const pendingError = remoteErrorCase.connection.request(
      "session.prompt",
      {},
      z.object({ ok: z.boolean() }),
    );
    const errorOutcome = pendingError.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    const requestError = (await remoteErrorCase.nextClientFrame()) as { requestId: string };
    await remoteErrorCase.sendServerFrame({
      kind: "error",
      id: "server-error",
      requestId: requestError.requestId,
      error: { code: "permission_denied", message: "remote-secret-message" },
    });
    const remoteError = (await errorOutcome).error;
    expectTransportError(remoteError, "remote_request");
    expect(remoteError.serverCode).toBe("permission_denied");
    expect(JSON.stringify(remoteError)).not.toContain("remote-secret-message");

    const mismatchCase = await establish();
    const pendingMismatch = mismatchCase.connection.request(
      "session.prompt",
      {},
      z.object({ ok: z.boolean() }),
    );
    const mismatchOutcome = pendingMismatch.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    const requestMismatch = (await mismatchCase.nextClientFrame()) as { requestId: string };
    await mismatchCase.sendServerFrame({
      kind: "response",
      id: "server-response",
      requestId: requestMismatch.requestId,
      result: { ok: "yes" },
    });
    expectTransportError((await mismatchOutcome).error, "protocol");
    expect(mismatchCase.connection.state).toBe("open");
  });

  test("sends encrypted cancel on abort and ignores the late response", async () => {
    const established = await establish();
    const controller = new AbortController();
    const pending = established.connection.request(
      "session.prompt",
      {},
      z.object({ ok: z.boolean() }),
      {
        signal: controller.signal,
      },
    );
    const abortOutcome = pending.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    const request = (await established.nextClientFrame()) as { requestId: string };
    controller.abort();
    expectTransportError((await abortOutcome).error, "aborted");
    const cancel = (await established.nextClientFrame()) as {
      kind: string;
      requestId: string;
      reason: string;
    };
    expect(cancel).toMatchObject({
      kind: "cancel",
      requestId: request.requestId,
      reason: "aborted",
    });
    await established.sendServerFrame({
      kind: "response",
      id: "late",
      requestId: request.requestId,
      result: { ok: true },
    });
    expect(established.connection.state).toBe("open");
  });

  test("times out pending requests and rejects them on socket close", async () => {
    const timeoutCase = await establish({ requestTimeoutMs: 5 });
    const timedOut = timeoutCase.connection.request(
      "session.prompt",
      {},
      z.object({ ok: z.boolean() }),
    );
    await timeoutCase.nextClientFrame();
    await timedOut.catch((error) => expectTransportError(error, "timeout"));
    expect((await timeoutCase.nextClientFrame()) as object).toMatchObject({ reason: "timeout" });

    const closeCase = await establish();
    const pending = closeCase.connection.request(
      "session.prompt",
      {},
      z.object({ ok: z.boolean() }),
    );
    closeCase.socket.remoteClose(1012, "Server restart", false);
    await pending.catch((error) => expectTransportError(error, "closed"));
    expect(closeCase.connection.state).toBe("closed");
  });
});

describe("OrbisRemoteConnection encrypted events and enforcement", () => {
  test("dispatches events and encrypts durable ACKs", async () => {
    const established = await establish();
    const observed: TransportEvent[] = [];
    established.connection.onEvent(() => {
      throw new Error("observer failure");
    });
    established.connection.onEvent((event) => {
      observed.push(event);
    });
    await established.sendServerFrame({ kind: "event", id: "server-event", event: durableEvent });
    expect(observed).toEqual([durableEvent]);

    await established.connection.ack(durableEvent);
    expect(await established.nextClientFrame()).toMatchObject({
      kind: "ack",
      sessionId: "session-1",
      eventSeq: 7,
    });
    await expect(
      established.connection.ack({ ...durableEvent, durability: "transient" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  test("closes on malformed, binary, oversized, tampered, and unknown-response frames", async () => {
    const malformed = await establish();
    malformed.socket.receive("{not-json");
    await waitFor(() => malformed.socket.closeCalls.length > 0, "malformed close");
    expect(malformed.socket.closeCalls.at(-1)?.code).toBe(1002);

    const binary = await establish();
    binary.socket.receiveBinary(new Uint8Array([1, 2, 3]));
    await waitFor(() => binary.socket.closeCalls.length > 0, "binary close");
    expect(binary.socket.closeCalls.at(-1)?.code).toBe(1002);

    const oversized = await establish({ maxFrameBytes: 4096 });
    oversized.socket.receive(`"${"x".repeat(8192)}"`);
    await waitFor(() => oversized.socket.closeCalls.length > 0, "oversized close");
    expect(oversized.socket.closeCalls.at(-1)?.code).toBe(1009);

    const tampered = await establish();
    const encrypted = await tampered.serverChannel.seal({
      kind: "event",
      id: "server-event",
      event: durableEvent,
    });
    encrypted.ciphertext = `${encrypted.ciphertext.startsWith("A") ? "B" : "A"}${encrypted.ciphertext.slice(1)}`;
    tampered.socket.receive(encrypted);
    await waitFor(() => tampered.socket.closeCalls.length > 0, "tampered close");
    expect(tampered.socket.closeCalls.at(-1)?.code).toBe(1008);

    const unknown = await establish();
    await unknown.sendServerFrame({
      kind: "response",
      id: "server-unknown",
      requestId: "never-issued",
      result: null,
    });
    expect(unknown.connection.state).toBe("closing");
    expect(unknown.socket.closeCalls.at(-1)?.code).toBe(1002);
  });
});
