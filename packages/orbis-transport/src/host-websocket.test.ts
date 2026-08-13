import { describe, expect, test } from "vitest";

import { sha256 } from "@hpke/common";

import {
  createPairingSecret,
  createSecureInitiatorHandshake,
  fingerprintPublicKey,
  generateDeviceIdentity,
  secureMessageEnvelopeSchema,
  secureWelcomeEnvelopeSchema,
  type OrbisSecureChannel,
  type SecureRandom,
  type SerializedDeviceIdentity,
} from "./e2ee";
import type { HostEndpointManifest } from "./endpoints";
import {
  OrbisRemoteHostConnection,
  type RemoteHostPeer,
  type RemoteHostPeerError,
} from "./host-websocket";
import {
  ORBIS_RELAY_UPLINK_SUBPROTOCOL,
  ORBIS_TRANSPORT_PROTOCOL_VERSION,
  ORBIS_TRANSPORT_SUBPROTOCOL,
  type ConnectionTicket,
  type JsonValue,
  type RemoteHost,
  type TransportEvent,
} from "./protocol";
import type {
  WebSocketEvent,
  WebSocketEventListener,
  WebSocketEventType,
  WebSocketFactory,
  WebSocketLike,
} from "./websocket";

const NOW = Date.parse("2026-08-09T00:00:00.000Z");

function deterministicRandom(label: string): SecureRandom {
  let counter = 0;
  return async (length) => {
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const block = sha256(new TextEncoder().encode(`${label}:${counter++}`));
      const chunk = block.subarray(0, Math.min(block.length, length - offset));
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  };
}

let identityFixture: Promise<{ client: SerializedDeviceIdentity; host: SerializedDeviceIdentity }>;
function identities() {
  identityFixture ??= Promise.all([
    generateDeviceIdentity(deterministicRandom("host-test-client")),
    generateDeviceIdentity(deterministicRandom("host-test-host")),
  ]).then(([client, host]) => ({ client, host }));
  return identityFixture;
}

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<WebSocketEventType, Set<WebSocketEventListener>>();

  constructor(readonly protocol: string = ORBIS_TRANSPORT_SUBPROTOCOL) {}

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
      throw new Error("closed");
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

  private emit(type: WebSocketEventType, event: WebSocketEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

function sequentialIds() {
  let value = 0;
  return () => `host-frame-${++value}`;
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

function descriptor(identity: SerializedDeviceIdentity): RemoteHost {
  return {
    id: "host-1",
    name: "Build Mac",
    platform: "darwin-arm64",
    status: "online",
    publicKeyFingerprint: fingerprintPublicKey(identity.publicKey),
    harnesses: [{ id: "pi", capabilities: ["sessions"] }],
  };
}

function endpointManifest(identity: SerializedDeviceIdentity): HostEndpointManifest {
  return {
    hostId: "host-1",
    hostKeyId: fingerprintPublicKey(identity.publicKey),
    revision: 1,
    endpoints: [{ kind: "tunnel", url: "wss://remote.example/orbis" }],
  };
}

function ticket(identity: SerializedDeviceIdentity): ConnectionTicket {
  return {
    ticket: "host-connection-ticket",
    expiresAt: "2026-08-09T00:01:00.000Z",
    websocketUrl: "wss://remote.example/host/connect",
    protocol: ORBIS_TRANSPORT_SUBPROTOCOL,
    host: descriptor(identity),
  };
}

interface HostFixture {
  connection: OrbisRemoteHostConnection;
  socket: FakeWebSocket;
  client: SerializedDeviceIdentity;
  host: SerializedDeviceIdentity;
}

async function connectHost(
  requestHandler: (
    method: string,
    params: JsonValue,
    context: { maxResponseBytes: number; signal: AbortSignal },
  ) => Promise<JsonValue> | JsonValue = async () => ({ ok: true }),
  overrides: {
    resolvePeer?: (frame: { mode: string }) => Promise<{
      publicKey: string;
      pairingSecret?: string;
      scopes: readonly string[];
    }>;
    commitPairing?: (peer: RemoteHostPeer) => Promise<void>;
    maxFrameBytes?: number;
  } = {},
): Promise<HostFixture> {
  const { client, host } = await identities();
  const socket = new FakeWebSocket();
  const connecting = OrbisRemoteHostConnection.connect({
    ticket: ticket(host),
    identity: host,
    random: deterministicRandom("host-responder-ephemeral"),
    capabilities: { methods: ["session.prompt", "session.cancel"] },
    endpointManifest: endpointManifest(host),
    resolvePeer:
      overrides.resolvePeer ??
      (async () => ({ publicKey: client.publicKey, scopes: ["host:connect"] })),
    commitPairing: overrides.commitPairing,
    requestHandler,
    webSocketFactory: () => socket,
    createId: sequentialIds(),
    maxFrameBytes: overrides.maxFrameBytes,
    now: () => NOW,
  });
  socket.open();
  return { connection: await connecting, socket, client, host };
}

async function connectClient(
  fixture: HostFixture,
  security: { mode: "authenticated" } | { mode: "pairing"; pairingId: string; secret: string } = {
    mode: "authenticated",
  },
): Promise<{ channel: OrbisSecureChannel; handshakeId: string }> {
  const initiator = await createSecureInitiatorHandshake({
    security:
      security.mode === "authenticated"
        ? {
            mode: "authenticated",
            identity: fixture.client,
            remotePublicKey: fixture.host.publicKey,
          }
        : {
            mode: "pairing",
            identity: fixture.client,
            remotePublicKey: fixture.host.publicKey,
            pairing: { pairingId: security.pairingId, secret: security.secret },
          },
    random: deterministicRandom(`client-${security.mode}-ephemeral`),
    hello: {
      kind: "hello",
      id: "client-hello-1",
      raceId: "client-race-1",
      protocolVersion: ORBIS_TRANSPORT_PROTOCOL_VERSION,
      peer: { deviceId: "phone-1", role: "client", version: "1.0.0" },
    },
  });
  const sentIndex = fixture.socket.sent.length;
  fixture.socket.receive(initiator.frame);
  await waitFor(() => fixture.socket.sent.length > sentIndex, "host welcome");
  const welcome = secureWelcomeEnvelopeSchema.parse(
    JSON.parse(fixture.socket.sent[sentIndex] as string),
  );
  const finished = await initiator.finish(welcome);
  const activatedIndex = fixture.socket.sent.length;
  await clientSend(fixture.socket, finished.channel, {
    kind: "activate",
    id: "client-activate-1",
    raceId: "client-race-1",
  });
  expect(await clientReceive(fixture.socket, finished.channel, activatedIndex)).toMatchObject({
    kind: "activated",
    raceId: "client-race-1",
  });
  return { channel: finished.channel, handshakeId: initiator.frame.handshakeId };
}

async function clientSend(
  socket: FakeWebSocket,
  channel: OrbisSecureChannel,
  frame: JsonValue,
): Promise<void> {
  socket.receive(await channel.seal(frame));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function clientReceive(
  socket: FakeWebSocket,
  channel: OrbisSecureChannel,
  index: number,
): Promise<JsonValue> {
  await waitFor(() => socket.sent.length > index, `host frame ${index}`);
  return channel.open(secureMessageEnvelopeSchema.parse(JSON.parse(socket.sent[index] as string)));
}

describe("OrbisRemoteHostConnection peers", () => {
  test("opens a relay uplink with the dedicated subprotocol and host bearer token", async () => {
    const { client, host } = await identities();
    const socket = new FakeWebSocket(ORBIS_RELAY_UPLINK_SUBPROTOCOL);
    let request: Parameters<WebSocketFactory>[0] | undefined;
    const connecting = OrbisRemoteHostConnection.connectUplink({
      websocketUrl: "wss://relay.example/v1/hosts/host-1/uplink",
      authorization: "relay-host-token-that-is-long-enough",
      host: descriptor(host),
      identity: host,
      random: deterministicRandom("host-uplink"),
      capabilities: { methods: ["session.prompt"] },
      endpointManifest: endpointManifest(host),
      resolvePeer: async () => ({ publicKey: client.publicKey, scopes: ["host:connect"] }),
      requestHandler: async () => ({ ok: true }),
      webSocketFactory: (input) => {
        request = input;
        return socket;
      },
      createId: sequentialIds(),
    });
    socket.open();
    const connection = await connecting;

    expect(request).toEqual({
      url: "wss://relay.example/v1/hosts/host-1/uplink",
      protocols: [ORBIS_RELAY_UPLINK_SUBPROTOCOL],
      headers: { Authorization: "Bearer relay-host-token-that-is-long-enough" },
    });
    expect(connection.state).toBe("open");
    connection.close();
  });

  test("accepts an already-open direct WebSocket", async () => {
    const { client, host } = await identities();
    const socket = new FakeWebSocket();
    socket.open();
    const connection = await OrbisRemoteHostConnection.accept({
      socket,
      host: descriptor(host),
      identity: host,
      random: deterministicRandom("direct-host-responder"),
      capabilities: { methods: ["session.prompt"] },
      endpointManifest: endpointManifest(host),
      resolvePeer: async () => ({ publicKey: client.publicKey, scopes: ["host:connect"] }),
      requestHandler: async () => ({ ok: true }),
      createId: sequentialIds(),
    });
    const fixture: HostFixture = { connection, socket, client, host };
    const connected = await connectClient(fixture);

    expect(connection.state).toBe("open");
    expect(connection.peers[0]?.handshakeId).toBe(connected.handshakeId);
  });

  test("accepts an authenticated client and keeps its descriptor encrypted", async () => {
    const fixture = await connectHost();
    const observed: RemoteHostPeer[] = [];
    fixture.connection.onPeer((peer) => observed.push(peer));
    const connected = await connectClient(fixture);

    expect(fixture.connection.state).toBe("open");
    expect(fixture.connection.peers).toHaveLength(1);
    expect(fixture.connection.peers[0]).toMatchObject({
      handshakeId: connected.handshakeId,
      keyId: fingerprintPublicKey(fixture.client.publicKey),
      descriptor: { deviceId: "phone-1", role: "client" },
      mode: "authenticated",
    });
    expect(observed).toHaveLength(1);
    expect(JSON.stringify(fixture.socket.sent[0])).not.toContain("phone-1");
  });

  test("commits a valid pairing only after PSK authentication", async () => {
    const { client } = await identities();
    const secret = await createPairingSecret(deterministicRandom("host-pairing-secret"));
    const commits: RemoteHostPeer[] = [];
    const fixture = await connectHost(undefined, {
      resolvePeer: async () => ({
        publicKey: client.publicKey,
        pairingSecret: secret,
        scopes: ["host:connect"],
      }),
      commitPairing: async (peer) => {
        commits.push(peer);
      },
    });
    const connected = await connectClient(fixture, {
      mode: "pairing",
      pairingId: "pairing-1",
      secret,
    });

    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      handshakeId: connected.handshakeId,
      mode: "pairing",
      pairingId: "pairing-1",
    });
  });

  test("drops a bad pairing attempt without taking the host relay socket offline", async () => {
    const { client } = await identities();
    const expected = await createPairingSecret(deterministicRandom("expected-secret"));
    const wrong = await createPairingSecret(deterministicRandom("wrong-secret"));
    const fixture = await connectHost(undefined, {
      resolvePeer: async () => ({
        publicKey: client.publicKey,
        pairingSecret: expected,
        scopes: ["host:connect"],
      }),
      commitPairing: async () => undefined,
    });
    const errors: RemoteHostPeerError[] = [];
    fixture.connection.onPeerError((event) => errors.push(event));

    const initiator = await createSecureInitiatorHandshake({
      security: {
        mode: "pairing",
        identity: fixture.client,
        remotePublicKey: fixture.host.publicKey,
        pairing: { pairingId: "pairing-bad", secret: wrong },
      },
      random: deterministicRandom("bad-pairing-ephemeral"),
      hello: {
        kind: "hello",
        id: "bad-hello",
        raceId: "bad-race",
        protocolVersion: ORBIS_TRANSPORT_PROTOCOL_VERSION,
        peer: { deviceId: "attacker", role: "client", version: "1" },
      },
    });
    fixture.socket.receive(initiator.frame);
    await waitFor(() => errors.length > 0, "pairing error");

    expect(errors[0]?.error.code).toBe("authentication");
    expect(fixture.connection.state).toBe("open");
    expect(fixture.connection.peers).toHaveLength(0);
    expect(fixture.socket.closeCalls).toHaveLength(0);
  });
});

describe("OrbisRemoteHostConnection harness bridge", () => {
  test("dispatches requests and returns encrypted results", async () => {
    const calls: Array<{ method: string; params: JsonValue }> = [];
    const fixture = await connectHost(async (method, params) => {
      calls.push({ method, params });
      return { accepted: true };
    });
    const client = await connectClient(fixture);
    const responseIndex = fixture.socket.sent.length;
    await clientSend(fixture.socket, client.channel, {
      kind: "request",
      id: "client-frame-1",
      requestId: "request-1",
      method: "session.prompt",
      params: { text: "private prompt" },
    });
    const response = await clientReceive(fixture.socket, client.channel, responseIndex);

    expect(calls).toEqual([{ method: "session.prompt", params: { text: "private prompt" } }]);
    expect(response).toMatchObject({
      kind: "response",
      requestId: "request-1",
      result: { accepted: true },
    });
    expect(JSON.stringify(fixture.socket.sent[responseIndex])).not.toContain("accepted");
  });

  test("reports an oversized response without desynchronizing the encrypted channel", async () => {
    let maxResponseBytes = 0;
    const fixture = await connectHost(
      async (method, _params, context): Promise<JsonValue> => {
        maxResponseBytes = context.maxResponseBytes;
        return method === "large" ? { text: "x".repeat(4_096) } : { ok: true };
      },
      { maxFrameBytes: 2_048 },
    );
    const client = await connectClient(fixture);

    const oversizedIndex = fixture.socket.sent.length;
    await clientSend(fixture.socket, client.channel, {
      kind: "request",
      id: "client-frame-large",
      requestId: "request-large",
      method: "large",
      params: {},
    });
    expect(await clientReceive(fixture.socket, client.channel, oversizedIndex)).toMatchObject({
      error: { code: "frame_too_large" },
      kind: "error",
      requestId: "request-large",
    });
    expect(maxResponseBytes).toBeGreaterThan(0);
    expect(maxResponseBytes).toBeLessThan(2_048);

    const nextIndex = fixture.socket.sent.length;
    await clientSend(fixture.socket, client.channel, {
      kind: "request",
      id: "client-frame-small",
      requestId: "request-small",
      method: "small",
      params: {},
    });
    expect(await clientReceive(fixture.socket, client.channel, nextIndex)).toMatchObject({
      kind: "response",
      requestId: "request-small",
      result: { ok: true },
    });
    expect(fixture.socket.closeCalls).toEqual([]);
  });

  test("propagates cancellation through AbortSignal without sending a stale result", async () => {
    let aborted = false;
    const fixture = await connectHost(
      async (_method, _params, context) =>
        await new Promise<JsonValue>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(context.signal.reason);
            },
            { once: true },
          );
        }),
    );
    const client = await connectClient(fixture);
    const responseIndex = fixture.socket.sent.length;
    await clientSend(fixture.socket, client.channel, {
      kind: "request",
      id: "client-frame-1",
      requestId: "request-1",
      method: "session.prompt",
      params: {},
    });
    await clientSend(fixture.socket, client.channel, {
      kind: "cancel",
      id: "client-frame-2",
      requestId: "request-1",
      reason: "aborted",
    });
    await waitFor(() => aborted, "request abort");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.socket.sent).toHaveLength(responseIndex);
  });

  test("sends events and receives durable acknowledgements", async () => {
    const fixture = await connectHost();
    const client = await connectClient(fixture);
    const acknowledgements: unknown[] = [];
    fixture.connection.onAcknowledgement((ack) => acknowledgements.push(ack));
    const event: TransportEvent = {
      eventId: "event-1",
      sessionId: "session-1",
      eventSeq: 9,
      time: "2026-08-09T00:00:01.000Z",
      durability: "durable",
      type: "assistant.delta",
      payload: { text: "secret" },
      source: { harness: "pi" },
    };
    const eventIndex = fixture.socket.sent.length;
    await fixture.connection.sendEvent(client.handshakeId, event);
    expect(await clientReceive(fixture.socket, client.channel, eventIndex)).toMatchObject({
      kind: "event",
      event,
    });
    await clientSend(fixture.socket, client.channel, {
      kind: "ack",
      id: "client-ack",
      sessionId: "session-1",
      eventSeq: 9,
    });
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]).toMatchObject({
      peer: { handshakeId: client.handshakeId },
      sessionId: "session-1",
      eventSeq: 9,
    });
  });

  test("broadcasts encrypted events only to peers holding every required scope", async () => {
    const fixture = await connectHost();
    const client = await connectClient(fixture);
    const event: TransportEvent = {
      eventId: "event-scoped",
      sessionId: "session-1",
      eventSeq: 10,
      time: "2026-08-09T00:00:02.000Z",
      durability: "durable",
      type: "assistant.message",
      payload: { text: "classified" },
      source: { harness: "pi" },
    };
    const eventIndex = fixture.socket.sent.length;
    await fixture.connection.broadcastEvent(event, ["agent:read"]);
    expect(fixture.socket.sent).toHaveLength(eventIndex);

    await fixture.connection.broadcastEvent(event, ["host:connect"]);
    expect(await clientReceive(fixture.socket, client.channel, eventIndex)).toMatchObject({
      kind: "event",
      event,
    });
  });

  test("isolates tampered peer frames but closes on malformed relay frames", async () => {
    const fixture = await connectHost();
    const client = await connectClient(fixture);
    const errors: RemoteHostPeerError[] = [];
    fixture.connection.onPeerError((event) => errors.push(event));
    const tampered = await client.channel.seal({
      kind: "ack",
      id: "client-ack",
      sessionId: "session-1",
      eventSeq: 1,
    });
    tampered.ciphertext = `${tampered.ciphertext.startsWith("A") ? "B" : "A"}${tampered.ciphertext.slice(1)}`;
    fixture.socket.receive(tampered);
    await waitFor(() => errors.length > 0, "tampered peer error");
    expect(fixture.connection.peers).toHaveLength(0);
    expect(fixture.connection.state).toBe("open");

    fixture.socket.receive("{malformed");
    await waitFor(() => fixture.socket.closeCalls.length > 0, "relay close");
    expect(fixture.socket.closeCalls.at(-1)?.code).toBe(1002);
  });
});
