import { z } from "zod";

import { abortError, createAbortScope, throwIfAborted } from "./abort";
import {
  acceptSecureInitiatorHandshake,
  fingerprintPublicKey,
  secureHelloEnvelopeSchema,
  secureMessageEnvelopeSchema,
  type OrbisE2eeHandshakeMode,
  type OrbisSecureChannel,
  type SecureHelloEnvelope,
  type SecureRandom,
  type SecureResponderPeer,
  type SerializedDeviceIdentity,
} from "./e2ee";
import { normalizeHostEndpointManifest, type HostEndpointManifest } from "./endpoints";
import { OrbisTransportError } from "./errors";
import {
  connectionTicketSchema,
  incomingHostTransportFrameSchema,
  jsonValueSchema,
  ORBIS_TRANSPORT_PROTOCOL_VERSION,
  ORBIS_TRANSPORT_SUBPROTOCOL,
  ORBIS_RELAY_UPLINK_SUBPROTOCOL,
  ORBIS_REMOTE_SCOPES,
  peerDescriptorSchema,
  relayPeerCloseFrameSchema,
  remoteHostSchema,
  transportCapabilitiesSchema,
  transportActivatedFrameSchema,
  transportEndpointManifestFrameSchema,
  transportErrorFrameSchema,
  transportEventFrameSchema,
  transportHelloFrameSchema,
  transportResponseFrameSchema,
  transportWelcomeFrameSchema,
  type ConnectionTicket,
  type JsonValue,
  type PeerDescriptor,
  type RemoteHost,
  type TransportCapabilities,
  type TransportEvent,
} from "./protocol";
import type {
  WebSocketEvent,
  WebSocketEventListener,
  WebSocketFactory,
  WebSocketLike,
} from "./websocket";
import {
  byteLength,
  defaultCreateId,
  OPEN_READY_STATE,
  validateDirectSocketUrl,
  validateSocketUrl,
  validateTicketCredential,
  validateTicketLifetime,
} from "./websocket-internal";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_TICKET_LIFETIME_MS = 5 * 60_000;
const identifierSchema = z.string().min(1).max(256);

export type RemoteHostConnectionState = "closed" | "closing" | "connecting" | "open";

export interface RemoteHostPeer {
  handshakeId: string;
  keyId: string;
  publicKey: string;
  descriptor: PeerDescriptor;
  mode: OrbisE2eeHandshakeMode;
  pairingId?: string;
  /** Authorization granted to this exact static client public key. */
  scopes: readonly string[];
}

export interface RemoteHostResolvedPeer extends SecureResponderPeer {
  /** Scopes loaded from the host's trusted paired-client store, never from the relay hello. */
  scopes: readonly string[];
}

export interface RemoteHostRequestContext {
  /** Maximum UTF-8 JSON bytes available to the request's `result` value. */
  maxResponseBytes: number;
  peer: RemoteHostPeer;
  requestId: string;
  signal: AbortSignal;
}

export type RemoteHostRequestHandler = (
  method: string,
  params: JsonValue,
  context: RemoteHostRequestContext,
) => Promise<JsonValue> | JsonValue;

export interface RemoteHostAcknowledgement {
  peer: RemoteHostPeer;
  sessionId: string;
  eventSeq: number;
}

export interface RemoteHostPeerError {
  handshakeId?: string;
  keyId?: string;
  mode?: OrbisE2eeHandshakeMode;
  pairingId?: string;
  error: OrbisTransportError;
}

export interface ConnectRemoteHostOptions {
  ticket: ConnectionTicket;
  identity: SerializedDeviceIdentity;
  random: SecureRandom;
  capabilities: TransportCapabilities;
  endpointManifest: HostEndpointManifest | (() => HostEndpointManifest);
  resolvePeer(frame: SecureHelloEnvelope): Promise<RemoteHostResolvedPeer>;
  /** Must atomically persist the client key and consume the one-time PSK before returning. */
  commitPairing?(peer: RemoteHostPeer): Promise<void>;
  requestHandler: RemoteHostRequestHandler;
  webSocketFactory: WebSocketFactory;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  maxFrameBytes?: number;
  maxTicketLifetimeMs?: number;
  /** Development only. Production callers must use WSS. E2EE remains mandatory. */
  allowInsecureWebSocket?: boolean;
  createId?: () => string;
  now?: () => number;
}

export interface ConnectRemoteHostUplinkOptions {
  websocketUrl: string;
  authorization: string;
  host: RemoteHost;
  identity: SerializedDeviceIdentity;
  random: SecureRandom;
  capabilities: TransportCapabilities;
  endpointManifest: HostEndpointManifest | (() => HostEndpointManifest);
  resolvePeer(frame: SecureHelloEnvelope): Promise<RemoteHostResolvedPeer>;
  commitPairing?(peer: RemoteHostPeer): Promise<void>;
  requestHandler: RemoteHostRequestHandler;
  webSocketFactory: WebSocketFactory;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  maxFrameBytes?: number;
  createId?: () => string;
}

/**
 * Accepts one already-upgraded direct WebSocket. The surrounding runtime owns
 * listening, TLS, and socket admission; this transport owns only the pinned
 * E2EE handshake and encrypted request/event protocol.
 */
export interface AcceptRemoteHostOptions {
  socket: WebSocketLike;
  host: RemoteHost;
  identity: SerializedDeviceIdentity;
  random: SecureRandom;
  capabilities: TransportCapabilities;
  endpointManifest: HostEndpointManifest | (() => HostEndpointManifest);
  resolvePeer(frame: SecureHelloEnvelope): Promise<RemoteHostResolvedPeer>;
  /** Must atomically persist the client key and consume the one-time PSK before returning. */
  commitPairing?(peer: RemoteHostPeer): Promise<void>;
  requestHandler: RemoteHostRequestHandler;
  maxFrameBytes?: number;
  createId?: () => string;
}

interface PeerSession {
  peer: RemoteHostPeer;
  /** Endpoint-selection coordination stays transport-private. */
  raceId: string;
  channel: OrbisSecureChannel;
  maxFrameBytes: number;
  active: boolean;
}

interface PendingHostRequest {
  peerHandshakeId: string;
  controller: AbortController;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new OrbisTransportError("invalid_argument", `${label} is invalid`);
  }
  return result.data;
}

function asTransportError(error: unknown, fallback: string): OrbisTransportError {
  return error instanceof OrbisTransportError
    ? error
    : new OrbisTransportError("protocol", fallback);
}

function requestKey(handshakeId: string, requestId: string): string {
  return `${handshakeId}\u0000${requestId}`;
}

function peerErrorContext(input: {
  readonly handshakeId: string;
  readonly keyId: string;
  readonly mode: OrbisE2eeHandshakeMode;
  readonly pairingId?: string;
}): Pick<RemoteHostPeerError, "handshakeId" | "keyId" | "mode" | "pairingId"> {
  return {
    handshakeId: input.handshakeId,
    keyId: input.keyId,
    mode: input.mode,
    ...(input.pairingId === undefined ? {} : { pairingId: input.pairingId }),
  };
}

function endpointManifestProvider(
  input: HostEndpointManifest | (() => HostEndpointManifest),
  host: RemoteHost,
): () => HostEndpointManifest {
  return () => {
    const manifest = normalizeHostEndpointManifest(typeof input === "function" ? input() : input);
    if (
      manifest.hostId !== host.id ||
      host.publicKeyFingerprint === undefined ||
      manifest.hostKeyId !== host.publicKeyFingerprint
    ) {
      throw new OrbisTransportError(
        "authentication",
        "The endpoint manifest does not match the configured host identity",
      );
    }
    return manifest;
  };
}

export class OrbisRemoteHostConnection {
  private readonly peerSessions = new Map<string, PeerSession>();
  private readonly pendingRequests = new Map<string, PendingHostRequest>();
  private readonly peerListeners = new Set<(peer: RemoteHostPeer) => void>();
  private readonly peerErrorListeners = new Set<(event: RemoteHostPeerError) => void>();
  private readonly acknowledgementListeners = new Set<
    (acknowledgement: RemoteHostAcknowledgement) => void
  >();
  private readonly closeListeners = new Set<(event: WebSocketEvent) => void>();
  private incomingTail: Promise<unknown> = Promise.resolve();
  private stateValue: RemoteHostConnectionState = "connecting";
  private openResolve?: () => void;
  private openReject?: (error: OrbisTransportError) => void;

  private readonly openPromise = new Promise<void>((resolve, reject) => {
    this.openResolve = resolve;
    this.openReject = reject;
  });

  private readonly handleOpen: WebSocketEventListener = () => {
    if (this.stateValue !== "connecting") {
      this.terminate(new OrbisTransportError("protocol", "Host WebSocket opened twice"), 1002);
      return;
    }
    if (this.socket.protocol !== this.options.subprotocol) {
      this.terminate(
        new OrbisTransportError("protocol", "Host WebSocket did not negotiate the subprotocol"),
        1002,
      );
      return;
    }
    this.stateValue = "open";
    this.openResolve?.();
    this.openResolve = undefined;
    this.openReject = undefined;
  };

  private readonly handleMessage: WebSocketEventListener = (event) => {
    const operation = this.incomingTail.then(() => this.processSocketMessage(event));
    this.incomingTail = operation.catch(() => undefined);
    void operation.catch((error: unknown) => {
      const transportError = asTransportError(error, "The host received an invalid relay frame");
      this.terminate(transportError, transportError.code === "authentication" ? 1008 : 1002);
    });
  };

  private readonly handleError: WebSocketEventListener = () => {
    this.terminate(
      new OrbisTransportError("websocket", "The host WebSocket reported an error", {
        retryable: true,
      }),
      1011,
    );
  };

  private readonly handleClose: WebSocketEventListener = (event) => {
    const wasClientClose = this.stateValue === "closing";
    this.stateValue = "closed";
    const error = new OrbisTransportError(
      "closed",
      wasClientClose ? "The host connection was closed" : "The host connection closed unexpectedly",
      { retryable: !wasClientClose },
    );
    this.openReject?.(error);
    this.openResolve = undefined;
    this.openReject = undefined;
    this.abortAllRequests(error);
    this.peerSessions.clear();
    this.detachSocketListeners();
    for (const listener of this.closeListeners) {
      try {
        listener(event);
      } catch {
        // Observers do not own the socket lifecycle.
      }
    }
  };

  private constructor(
    private readonly socket: WebSocketLike,
    private readonly options: {
      identity: SerializedDeviceIdentity;
      random: SecureRandom;
      host: RemoteHost;
      capabilities: TransportCapabilities;
      endpointManifest: () => HostEndpointManifest;
      resolvePeer(frame: SecureHelloEnvelope): Promise<RemoteHostResolvedPeer>;
      commitPairing?: (peer: RemoteHostPeer) => Promise<void>;
      requestHandler: RemoteHostRequestHandler;
      createId: () => string;
      maxFrameBytes: number;
      subprotocol: string;
    },
  ) {
    socket.addEventListener("open", this.handleOpen);
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("error", this.handleError);
    socket.addEventListener("close", this.handleClose);
  }

  static async connect(options: ConnectRemoteHostOptions): Promise<OrbisRemoteHostConnection> {
    const ticket = parseInput(connectionTicketSchema, options.ticket, "Host connection ticket");
    const capabilities = parseInput(
      transportCapabilitiesSchema,
      options.capabilities,
      "Host capabilities",
    );
    validateTicketCredential(ticket.ticket);
    validateTicketLifetime(
      ticket.expiresAt,
      (options.now ?? Date.now)(),
      options.maxTicketLifetimeMs ?? DEFAULT_MAX_TICKET_LIFETIME_MS,
    );
    if (ticket.host.publicKeyFingerprint !== fingerprintPublicKey(options.identity.publicKey)) {
      throw new OrbisTransportError(
        "authentication",
        "The host ticket does not match the configured host identity",
      );
    }

    const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1024) {
      throw new OrbisTransportError(
        "invalid_argument",
        "maxFrameBytes must be an integer of at least 1024 bytes",
      );
    }
    const url = validateSocketUrl(
      ticket.websocketUrl,
      ticket.ticket,
      options.allowInsecureWebSocket ?? false,
    );
    return await this.connectOutbound({
      url,
      authorization: ticket.ticket,
      identity: options.identity,
      random: options.random,
      host: ticket.host,
      capabilities,
      endpointManifest: options.endpointManifest,
      resolvePeer: (frame) => options.resolvePeer(frame),
      commitPairing:
        options.commitPairing === undefined ? undefined : (peer) => options.commitPairing!(peer),
      requestHandler: (method, params, context) => options.requestHandler(method, params, context),
      webSocketFactory: options.webSocketFactory,
      signal: options.signal,
      connectTimeoutMs: options.connectTimeoutMs,
      maxFrameBytes,
      createId: options.createId,
      subprotocol: ORBIS_TRANSPORT_SUBPROTOCOL,
    });
  }

  static async connectUplink(
    options: ConnectRemoteHostUplinkOptions,
  ): Promise<OrbisRemoteHostConnection> {
    const host = parseInput(remoteHostSchema, options.host, "Relay uplink host descriptor");
    const capabilities = parseInput(
      transportCapabilitiesSchema,
      options.capabilities,
      "Host capabilities",
    );
    validateTicketCredential(options.authorization);
    if (host.publicKeyFingerprint !== fingerprintPublicKey(options.identity.publicKey)) {
      throw new OrbisTransportError(
        "authentication",
        "The relay uplink host does not match the configured host identity",
      );
    }
    const url = validateDirectSocketUrl(options.websocketUrl);
    if (url.protocol !== "wss:") {
      throw new OrbisTransportError("insecure_transport", "A relay uplink requires WSS");
    }
    const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1024) {
      throw new OrbisTransportError(
        "invalid_argument",
        "maxFrameBytes must be an integer of at least 1024 bytes",
      );
    }
    return await this.connectOutbound({
      url,
      authorization: options.authorization,
      identity: options.identity,
      random: options.random,
      host,
      capabilities,
      endpointManifest: options.endpointManifest,
      resolvePeer: (frame) => options.resolvePeer(frame),
      commitPairing:
        options.commitPairing === undefined ? undefined : (peer) => options.commitPairing!(peer),
      requestHandler: (method, params, context) => options.requestHandler(method, params, context),
      webSocketFactory: options.webSocketFactory,
      signal: options.signal,
      connectTimeoutMs: options.connectTimeoutMs,
      maxFrameBytes,
      createId: options.createId,
      subprotocol: ORBIS_RELAY_UPLINK_SUBPROTOCOL,
    });
  }

  private static async connectOutbound(options: {
    url: URL;
    authorization: string;
    identity: SerializedDeviceIdentity;
    random: SecureRandom;
    host: RemoteHost;
    capabilities: TransportCapabilities;
    endpointManifest: HostEndpointManifest | (() => HostEndpointManifest);
    resolvePeer(frame: SecureHelloEnvelope): Promise<RemoteHostResolvedPeer>;
    commitPairing?: (peer: RemoteHostPeer) => Promise<void>;
    requestHandler: RemoteHostRequestHandler;
    webSocketFactory: WebSocketFactory;
    signal?: AbortSignal;
    connectTimeoutMs?: number;
    maxFrameBytes: number;
    createId?: () => string;
    subprotocol: string;
  }): Promise<OrbisRemoteHostConnection> {
    const scope = createAbortScope(
      options.signal,
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    );
    try {
      throwIfAborted(scope);
    } catch (error) {
      scope.dispose();
      throw error;
    }

    let socket: WebSocketLike;
    try {
      socket = options.webSocketFactory({
        url: options.url.toString(),
        protocols: [options.subprotocol],
        headers: Object.freeze({ Authorization: `Bearer ${options.authorization}` }),
      });
    } catch {
      scope.dispose();
      throw new OrbisTransportError("websocket", "The host WebSocket could not be created", {
        retryable: true,
      });
    }

    const connection = new OrbisRemoteHostConnection(socket, {
      identity: options.identity,
      random: options.random,
      host: options.host,
      capabilities: options.capabilities,
      endpointManifest: endpointManifestProvider(options.endpointManifest, options.host),
      resolvePeer: (frame) => options.resolvePeer(frame),
      commitPairing:
        options.commitPairing === undefined ? undefined : (peer) => options.commitPairing!(peer),
      requestHandler: (method, params, context) => options.requestHandler(method, params, context),
      createId: options.createId ?? defaultCreateId,
      maxFrameBytes: options.maxFrameBytes,
      subprotocol: options.subprotocol,
    });
    const abortConnect = () => connection.terminate(abortError(scope), 1002);
    scope.signal.addEventListener("abort", abortConnect, { once: true });
    if (scope.signal.aborted) {
      abortConnect();
    }
    try {
      await connection.openPromise;
      return connection;
    } finally {
      scope.signal.removeEventListener("abort", abortConnect);
      scope.dispose();
    }
  }

  static async accept(options: AcceptRemoteHostOptions): Promise<OrbisRemoteHostConnection> {
    const host = parseInput(remoteHostSchema, options.host, "Direct host descriptor");
    const capabilities = parseInput(
      transportCapabilitiesSchema,
      options.capabilities,
      "Host capabilities",
    );
    const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1024) {
      throw new OrbisTransportError(
        "invalid_argument",
        "maxFrameBytes must be an integer of at least 1024 bytes",
      );
    }
    if (options.socket.readyState !== OPEN_READY_STATE) {
      throw new OrbisTransportError("websocket", "The direct WebSocket is not open", {
        retryable: true,
      });
    }
    if (options.socket.protocol !== ORBIS_TRANSPORT_SUBPROTOCOL) {
      throw new OrbisTransportError(
        "protocol",
        "The direct WebSocket did not negotiate the Orbis subprotocol",
      );
    }

    const connection = new OrbisRemoteHostConnection(options.socket, {
      identity: options.identity,
      random: options.random,
      host,
      capabilities,
      endpointManifest: endpointManifestProvider(options.endpointManifest, host),
      resolvePeer: (frame) => options.resolvePeer(frame),
      commitPairing: options.commitPairing ? (peer) => options.commitPairing!(peer) : undefined,
      requestHandler: (method, params, context) => options.requestHandler(method, params, context),
      createId: options.createId ?? defaultCreateId,
      maxFrameBytes,
      subprotocol: ORBIS_TRANSPORT_SUBPROTOCOL,
    });
    connection.acceptOpen();
    return connection;
  }

  get state(): RemoteHostConnectionState {
    return this.stateValue;
  }

  get peers(): readonly RemoteHostPeer[] {
    return [...this.peerSessions.values()]
      .filter((session) => session.active)
      .map((session) => session.peer);
  }

  onPeer(listener: (peer: RemoteHostPeer) => void): () => void {
    this.peerListeners.add(listener);
    return () => this.peerListeners.delete(listener);
  }

  onPeerError(listener: (event: RemoteHostPeerError) => void): () => void {
    this.peerErrorListeners.add(listener);
    return () => this.peerErrorListeners.delete(listener);
  }

  onAcknowledgement(listener: (event: RemoteHostAcknowledgement) => void): () => void {
    this.acknowledgementListeners.add(listener);
    return () => this.acknowledgementListeners.delete(listener);
  }

  onClose(listener: (event: WebSocketEvent) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async sendEvent(handshakeId: string, eventInput: TransportEvent): Promise<void> {
    const session = this.peerSessions.get(
      parseInput(identifierSchema, handshakeId, "Peer handshake id"),
    );
    if (!session?.active) {
      throw new OrbisTransportError("closed", "The remote peer is not connected");
    }
    const event = parseInput(transportEventFrameSchema.shape.event, eventInput, "Transport event");
    await this.sendEncrypted(
      session,
      transportEventFrameSchema.parse({ kind: "event", id: this.nextId(), event }),
    );
  }

  async broadcastEvent(event: TransportEvent, requiredScopes: readonly string[]): Promise<void> {
    if (requiredScopes.length === 0 || new Set(requiredScopes).size !== requiredScopes.length) {
      throw new OrbisTransportError(
        "invalid_argument",
        "Encrypted event broadcast requires unique authorization scopes",
      );
    }
    const peers = [...this.peerSessions.values()]
      .filter(
        (session) =>
          session.active && requiredScopes.every((scope) => session.peer.scopes.includes(scope)),
      )
      .map((session) => session.peer.handshakeId);
    await Promise.all(peers.map((handshakeId) => this.sendEvent(handshakeId, event)));
  }

  async broadcastEndpointManifest(manifestInput: HostEndpointManifest): Promise<void> {
    const manifest = normalizeHostEndpointManifest(manifestInput);
    if (
      manifest.hostId !== this.options.host.id ||
      manifest.hostKeyId !== this.options.host.publicKeyFingerprint
    ) {
      throw new OrbisTransportError(
        "authentication",
        "The endpoint manifest does not match this host connection",
      );
    }
    const sessions = [...this.peerSessions.values()].filter((session) => session.active);
    await Promise.all(
      sessions.map((session) =>
        this.sendEncrypted(
          session,
          transportEndpointManifestFrameSchema.parse({
            kind: "endpoint_manifest",
            id: this.nextId(),
            manifest,
          }),
        ),
      ),
    );
  }

  disconnectPeer(handshakeId: string): void {
    const session = this.peerSessions.get(handshakeId);
    if (!session) {
      return;
    }
    if (this.options.subprotocol === ORBIS_RELAY_UPLINK_SUBPROTOCOL) {
      try {
        this.sendOuter(
          relayPeerCloseFrameSchema.parse({
            kind: "relay_peer_close",
            handshakeId,
            code: 1008,
          }),
        );
      } catch {
        // Local revocation remains authoritative even if the relay is closing.
      }
    }
    this.removePeer(handshakeId);
  }

  private removePeer(handshakeId: string): void {
    this.peerSessions.delete(handshakeId);
    for (const [key, pending] of this.pendingRequests) {
      if (pending.peerHandshakeId === handshakeId) {
        this.pendingRequests.delete(key);
        pending.controller.abort(
          new OrbisTransportError("closed", "The remote peer was disconnected"),
        );
      }
    }
  }

  close(code = 1000, reason = "Host closed"): void {
    if (this.stateValue === "closed" || this.stateValue === "closing") {
      return;
    }
    if (
      !Number.isInteger(code) ||
      (code !== 1000 && (code < 3000 || code > 4999)) ||
      byteLength(reason) > 123
    ) {
      throw new OrbisTransportError("invalid_argument", "The close code or reason is invalid");
    }
    this.stateValue = "closing";
    this.abortAllRequests(new OrbisTransportError("closed", "The host connection was closed"));
    this.peerSessions.clear();
    try {
      this.socket.close(code, reason);
    } catch {
      this.stateValue = "closed";
      this.detachSocketListeners();
      throw new OrbisTransportError("websocket", "The host WebSocket could not be closed");
    }
  }

  private async processSocketMessage(event: WebSocketEvent): Promise<void> {
    if (this.stateValue !== "open") {
      return;
    }
    if (typeof event.data !== "string") {
      throw new OrbisTransportError("protocol", "The relay sent a non-text host frame");
    }
    if (byteLength(event.data) > this.options.maxFrameBytes) {
      this.terminate(
        new OrbisTransportError("protocol", "The relay frame exceeded the host size limit"),
        1009,
      );
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      throw new OrbisTransportError("protocol", "The relay frame was not valid JSON");
    }
    if (typeof raw !== "object" || raw === null || !("kind" in raw)) {
      throw new OrbisTransportError("protocol", "The relay frame did not contain a kind");
    }

    const kind = (raw as { kind?: unknown }).kind;
    if (kind === "relay_peer_close") {
      if (this.options.subprotocol !== ORBIS_RELAY_UPLINK_SUBPROTOCOL) {
        throw new OrbisTransportError("protocol", "A direct peer sent a relay control frame");
      }
      this.removePeer(relayPeerCloseFrameSchema.parse(raw).handshakeId);
      return;
    }
    if (kind === "secure_hello") {
      const frame = secureHelloEnvelopeSchema.parse(raw);
      await this.acceptPeer(frame);
      return;
    }
    if (kind === "secure_message") {
      const frame = secureMessageEnvelopeSchema.parse(raw);
      const session = this.peerSessions.get(frame.handshakeId);
      if (!session) {
        this.notifyPeerError({
          handshakeId: frame.handshakeId,
          error: new OrbisTransportError("authentication", "Encrypted frame peer is unknown"),
        });
        return;
      }
      try {
        const plaintext = await session.channel.open(frame);
        await this.handlePeerFrame(session, incomingHostTransportFrameSchema.parse(plaintext));
      } catch (error) {
        this.disconnectPeer(frame.handshakeId);
        this.notifyPeerError({
          ...peerErrorContext(session.peer),
          error: asTransportError(error, "The peer sent an invalid encrypted frame"),
        });
      }
      return;
    }
    throw new OrbisTransportError("protocol", "The relay sent an unsupported host frame");
  }

  private async acceptPeer(frame: SecureHelloEnvelope): Promise<void> {
    if (this.peerSessions.has(frame.handshakeId)) {
      this.notifyPeerError({
        ...peerErrorContext({
          handshakeId: frame.handshakeId,
          keyId: frame.senderKeyId,
          mode: frame.mode,
          pairingId: frame.pairingId,
        }),
        error: new OrbisTransportError("authentication", "The peer handshake was replayed"),
      });
      return;
    }

    try {
      let resolvedPeer: RemoteHostResolvedPeer | undefined;
      const handshake = await acceptSecureInitiatorHandshake(frame, {
        identity: this.options.identity,
        random: this.options.random,
        resolvePeer: async (input) => {
          resolvedPeer = await this.options.resolvePeer(input);
          return resolvedPeer;
        },
      });
      if (!resolvedPeer) {
        throw new OrbisTransportError("authentication", "The client authorization is unavailable");
      }
      const scopes = Object.freeze(
        z.array(z.string().min(1).max(128)).min(1).max(64).parse(resolvedPeer.scopes),
      );
      if (!scopes.includes(ORBIS_REMOTE_SCOPES.connect)) {
        throw new OrbisTransportError("authentication", "The client is not allowed to connect");
      }
      const hello = transportHelloFrameSchema.parse(handshake.hello);
      const descriptor = peerDescriptorSchema.parse(hello.peer);
      if (descriptor.role !== "client") {
        throw new OrbisTransportError("authentication", "Only clients may connect to a host");
      }
      const peer: RemoteHostPeer = Object.freeze({
        handshakeId: frame.handshakeId,
        keyId: handshake.peerKeyId,
        publicKey: handshake.peerPublicKey,
        descriptor,
        mode: handshake.mode,
        pairingId: handshake.pairingId,
        scopes,
      });
      if (handshake.mode === "pairing") {
        if (!this.options.commitPairing) {
          throw new OrbisTransportError(
            "authentication",
            "The host cannot atomically commit a pairing",
          );
        }
        await this.options.commitPairing(peer);
      }

      const response = await handshake.respond(
        transportWelcomeFrameSchema.parse({
          kind: "welcome",
          id: hello.id,
          protocolVersion: ORBIS_TRANSPORT_PROTOCOL_VERSION,
          connectionId: this.nextId(),
          host: this.options.host,
          capabilities: {
            ...this.options.capabilities,
            maxFrameBytes: this.options.maxFrameBytes,
          },
          endpointManifest: this.options.endpointManifest(),
        }),
      );
      const session: PeerSession = {
        peer,
        raceId: hello.raceId,
        channel: response.channel,
        maxFrameBytes: this.options.maxFrameBytes,
        active: false,
      };
      this.peerSessions.set(peer.handshakeId, session);
      this.sendOuter(response.frame, session.maxFrameBytes);
    } catch (error) {
      this.peerSessions.delete(frame.handshakeId);
      this.notifyPeerError({
        ...peerErrorContext({
          handshakeId: frame.handshakeId,
          keyId: frame.senderKeyId,
          mode: frame.mode,
          pairingId: frame.pairingId,
        }),
        error: asTransportError(error, "The encrypted peer handshake failed"),
      });
    }
  }

  private async handlePeerFrame(
    session: PeerSession,
    frame: z.infer<typeof incomingHostTransportFrameSchema>,
  ): Promise<void> {
    if (frame.kind === "activate") {
      if (frame.raceId !== session.raceId) {
        throw new OrbisTransportError(
          "authentication",
          "The activation did not match the authenticated connection race",
        );
      }
      if (!session.active) {
        session.active = true;
        for (const listener of this.peerListeners) {
          try {
            listener(session.peer);
          } catch {
            // Peer observers cannot corrupt activation.
          }
        }
      }
      await this.sendEncrypted(
        session,
        transportActivatedFrameSchema.parse({
          kind: "activated",
          id: this.nextId(),
          raceId: session.raceId,
        }),
      );
      return;
    }
    if (!session.active) {
      throw new OrbisTransportError(
        "protocol",
        "The peer sent application traffic before activating its endpoint",
      );
    }
    if (frame.kind === "ack") {
      const event = {
        peer: session.peer,
        sessionId: frame.sessionId,
        eventSeq: frame.eventSeq,
      };
      for (const listener of this.acknowledgementListeners) {
        try {
          listener(event);
        } catch {
          // ACK observers are passive.
        }
      }
      return;
    }

    const key = requestKey(session.peer.handshakeId, frame.requestId);
    if (frame.kind === "cancel") {
      this.pendingRequests
        .get(key)
        ?.controller.abort(new OrbisTransportError("aborted", "The remote request was cancelled"));
      return;
    }
    if (this.pendingRequests.has(key)) {
      await this.sendRequestError(session, frame.requestId, "duplicate_request");
      return;
    }

    const controller = new AbortController();
    const responseId = this.nextId();
    this.pendingRequests.set(key, {
      peerHandshakeId: session.peer.handshakeId,
      controller,
    });
    void Promise.resolve(
      this.options.requestHandler(frame.method, frame.params, {
        maxResponseBytes: this.maxResponseBytes(session, responseId, frame.requestId),
        peer: session.peer,
        requestId: frame.requestId,
        signal: controller.signal,
      }),
    )
      .then(async (result) => {
        if (controller.signal.aborted || !this.pendingRequests.has(key)) {
          return;
        }
        await this.sendEncrypted(
          session,
          transportResponseFrameSchema.parse({
            kind: "response",
            id: responseId,
            requestId: frame.requestId,
            result: jsonValueSchema.parse(result),
          }),
        );
      })
      .catch(async (error: unknown) => {
        if (controller.signal.aborted || !this.pendingRequests.has(key)) {
          return;
        }
        const code =
          error instanceof OrbisTransportError
            ? (error.serverCode ?? error.code)
            : "internal_error";
        await this.sendRequestError(session, frame.requestId, code).catch(() => undefined);
      })
      .finally(() => {
        this.pendingRequests.delete(key);
      });
  }

  private async sendRequestError(
    session: PeerSession,
    requestId: string,
    code: string,
  ): Promise<void> {
    await this.sendEncrypted(
      session,
      transportErrorFrameSchema.parse({
        kind: "error",
        id: this.nextId(),
        requestId,
        error: { code },
      }),
    );
  }

  private async sendEncrypted(session: PeerSession, frame: JsonValue): Promise<void> {
    if (this.stateValue !== "open" || !this.peerSessions.has(session.peer.handshakeId)) {
      throw new OrbisTransportError("closed", "The remote peer is not connected");
    }
    const envelope = await session.channel.seal(frame, {
      maxEnvelopeBytes: session.maxFrameBytes,
    });
    try {
      this.sendOuter(envelope, session.maxFrameBytes);
    } catch (error) {
      if (error instanceof OrbisTransportError && error.code === "invalid_argument") {
        this.disconnectPeer(session.peer.handshakeId);
        this.notifyPeerError({ ...peerErrorContext(session.peer), error });
      }
      throw error;
    }
  }

  private maxResponseBytes(session: PeerSession, responseId: string, requestId: string): number {
    const emptyResultFrame = transportResponseFrameSchema.parse({
      kind: "response",
      id: responseId,
      requestId,
      result: null,
    });
    const responseWrapperBytes = byteLength(JSON.stringify(emptyResultFrame)) - 4;
    return Math.max(
      0,
      session.channel.maxPlaintextBytes(session.maxFrameBytes) - responseWrapperBytes,
    );
  }

  private sendOuter(frame: unknown, maxFrameBytes = this.options.maxFrameBytes): void {
    if (this.stateValue !== "open" || this.socket.readyState !== OPEN_READY_STATE) {
      throw new OrbisTransportError("closed", "The host connection is not open");
    }
    const encoded = JSON.stringify(frame);
    if (byteLength(encoded) > maxFrameBytes) {
      throw new OrbisTransportError("invalid_argument", "The encrypted host frame is too large");
    }
    try {
      this.socket.send(encoded);
    } catch {
      const error = new OrbisTransportError("websocket", "The host WebSocket send failed", {
        retryable: true,
      });
      this.terminate(error, 1011);
      throw error;
    }
  }

  private nextId(): string {
    let value: string;
    try {
      value = this.options.createId();
    } catch {
      throw new OrbisTransportError("invalid_argument", "createId failed");
    }
    return parseInput(identifierSchema, value, "Generated host transport id");
  }

  private notifyPeerError(event: RemoteHostPeerError): void {
    for (const listener of this.peerErrorListeners) {
      try {
        listener(event);
      } catch {
        // Error observers cannot corrupt the connection.
      }
    }
  }

  private terminate(error: OrbisTransportError, closeCode: number): void {
    if (this.stateValue === "closed" || this.stateValue === "closing") {
      return;
    }
    this.stateValue = "closing";
    this.openReject?.(error);
    this.openResolve = undefined;
    this.openReject = undefined;
    this.abortAllRequests(error);
    this.peerSessions.clear();
    try {
      this.socket.close(closeCode, "Orbis host transport closed");
    } catch {
      this.stateValue = "closed";
      this.detachSocketListeners();
    }
  }

  private abortAllRequests(error: OrbisTransportError): void {
    for (const [key, pending] of this.pendingRequests) {
      this.pendingRequests.delete(key);
      pending.controller.abort(error);
    }
  }

  private detachSocketListeners(): void {
    this.socket.removeEventListener("open", this.handleOpen);
    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.removeEventListener("error", this.handleError);
    this.socket.removeEventListener("close", this.handleClose);
  }

  private acceptOpen(): void {
    this.handleOpen({});
    if (this.stateValue !== "open") {
      throw new OrbisTransportError("websocket", "The direct WebSocket could not be accepted", {
        retryable: true,
      });
    }
  }
}
