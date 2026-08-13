import { z } from "zod";

import { abortError, createAbortScope, throwIfAborted } from "./abort";
import {
  createSecureInitiatorHandshake,
  fingerprintPublicKey,
  OrbisSecureChannel,
  secureMessageEnvelopeSchema,
  secureWelcomeEnvelopeSchema,
  type InitiatorSecurity,
  type SecureInitiatorHandshake,
  type SecureRandom,
} from "./e2ee";
import {
  hostEndpointManifestSchema,
  normalizeHostEndpointManifest,
  type HostEndpointManifest,
} from "./endpoints";
import { OrbisTransportError, type OrbisTransportErrorCode } from "./errors";
import {
  connectionTicketSchema,
  incomingTransportFrameSchema,
  jsonValueSchema,
  ORBIS_TRANSPORT_PROTOCOL_VERSION,
  ORBIS_TRANSPORT_SUBPROTOCOL,
  peerDescriptorSchema,
  transportActivateFrameSchema,
  transportAckFrameSchema,
  transportCancelFrameSchema,
  transportEventSchema,
  transportHelloFrameSchema,
  transportRequestFrameSchema,
  transportWelcomeFrameSchema,
  type ConnectionTicket,
  type JsonValue,
  type PeerDescriptor,
  type TransportEvent,
  type TransportWelcomeFrame,
} from "./protocol";
import {
  byteLength,
  defaultCreateId,
  OPEN_READY_STATE,
  validateDirectSocketUrl,
  validateSocketUrl,
  validateTicketCredential,
  validateTicketLifetime,
} from "./websocket-internal";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_TICKET_LIFETIME_MS = 5 * 60_000;
const MAX_ABANDONED_REQUESTS = 256;

const methodSchema = z.string().min(1).max(256);
const identifierSchema = z.string().min(1).max(256);

export type WebSocketEventType = "close" | "error" | "message" | "open";

export interface WebSocketEvent {
  code?: number;
  data?: unknown;
  error?: unknown;
  reason?: string;
  wasClean?: boolean;
}

export type WebSocketEventListener = (event: WebSocketEvent) => void;

/**
 * Browser WebSocket cannot attach an Upgrade Authorization header. React Native, Node, and host
 * runtimes adapt their native socket here; the ticket is never permitted in the URL.
 */
export interface WebSocketLike {
  readonly readyState: number;
  readonly protocol: string;
  addEventListener(type: WebSocketEventType, listener: WebSocketEventListener): void;
  removeEventListener(type: WebSocketEventType, listener: WebSocketEventListener): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface WebSocketFactoryRequest {
  url: string;
  protocols: readonly string[];
  headers: Readonly<Record<string, string>>;
}

export type WebSocketFactory = (request: WebSocketFactoryRequest) => WebSocketLike;

export interface ConnectRemoteOptions {
  ticket: ConnectionTicket;
  peer: PeerDescriptor;
  security: InitiatorSecurity;
  random: SecureRandom;
  webSocketFactory: WebSocketFactory;
  signal?: AbortSignal;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  maxTicketLifetimeMs?: number;
  /** Development only. Production callers must use WSS. E2EE remains mandatory either way. */
  allowInsecureWebSocket?: boolean;
  createId?: () => string;
  now?: () => number;
}

/**
 * A QR-pinned direct endpoint. Unlike a relay ticket it is not an
 * authorization credential: the AuthPSK/Auth handshake authenticates both
 * peers and all application frames.
 */
export interface ConnectEndpointOptions {
  websocketUrl: string;
  hostId: string;
  peer: PeerDescriptor;
  security: InitiatorSecurity;
  random: SecureRandom;
  webSocketFactory: WebSocketFactory;
  signal?: AbortSignal;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  createId?: () => string;
  /** Every parallel endpoint attempt in one reconnect shares this identifier. */
  raceId?: string;
  /** Used by endpoint racing; application traffic remains blocked until activate() succeeds. */
  deferActivation?: boolean;
}

/** @deprecated Use ConnectEndpointOptions. */
export interface RemoteRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RemoteConnectionClose {
  code: number;
  reason: string;
  wasClean: boolean;
}

export type RemoteConnectionState = "closed" | "closing" | "connecting" | "provisional" | "open";
export type TransportEventListener = (event: TransportEvent) => Promise<void> | void;
export type RemoteConnectionCloseListener = (event: RemoteConnectionClose) => void;
export type HostEndpointManifestListener = (manifest: HostEndpointManifest) => void;

/**
 * Payload-free observability for an established encrypted socket. These events
 * deliberately omit request params, response/event payloads, peer metadata,
 * credentials, and close reasons so ordinary product diagnostics cannot become
 * a second transcript or secret store.
 */
export type RemoteConnectionDiagnostic =
  | {
      readonly at: number;
      readonly method: string;
      /** Opaque correlation id; it is not a credential. */
      readonly requestId: string;
      readonly type: "request_started";
    }
  | {
      readonly at: number;
      readonly durationMs: number;
      readonly method: string;
      /** Opaque correlation id; it is not a credential. */
      readonly requestId: string;
      readonly type: "request_succeeded";
    }
  | {
      readonly at: number;
      readonly durationMs: number;
      readonly errorCode: OrbisTransportErrorCode;
      readonly method: string;
      /** Opaque correlation id; it is not a credential. */
      readonly requestId: string;
      readonly retryable: boolean;
      /** Redacted remote classification, never the host's error message or body. */
      readonly serverCode?: string;
      readonly type: "request_failed";
    }
  | {
      readonly at: number;
      readonly cursor: number;
      readonly durability: TransportEvent["durability"];
      readonly type: "event_received";
    }
  | {
      readonly at: number;
      readonly code: number;
      readonly type: "closed";
      readonly wasClean: boolean;
    };

export type RemoteConnectionDiagnosticListener = (event: RemoteConnectionDiagnostic) => void;

/**
 * Explicit debug-only visibility into decrypted application frames. It never
 * includes the outer encrypted envelope, handshake data, Upgrade headers,
 * credentials, pairing secrets, ACKs, cancels, or close reasons.
 */
export type RemoteConnectionApplicationFrame =
  | {
      readonly at: number;
      readonly direction: "outbound";
      readonly kind: "request";
      readonly method: string;
      readonly payload: JsonValue;
      readonly requestId: string;
    }
  | {
      readonly at: number;
      readonly direction: "inbound";
      readonly kind: "response";
      readonly payload: JsonValue;
      readonly requestId: string;
    }
  | {
      readonly at: number;
      readonly cursor: number;
      readonly direction: "inbound";
      readonly durability: TransportEvent["durability"];
      readonly eventId: string;
      readonly eventType: string;
      readonly kind: "event";
      readonly payload: JsonValue;
      readonly sessionId: string;
    };

export type RemoteConnectionApplicationFrameListener = (
  frame: RemoteConnectionApplicationFrame,
) => void;

interface PendingRequest<T = unknown> {
  method: string;
  schema: z.ZodType<T>;
  startedAt: number;
  resolve(value: T): void;
  reject(error: OrbisTransportError): void;
  dispose(): void;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new OrbisTransportError("invalid_argument", `${label} is invalid`);
  }
  return result.data;
}

function asTransportError(error: unknown, fallbackMessage: string): OrbisTransportError {
  return error instanceof OrbisTransportError
    ? error
    : new OrbisTransportError("websocket", fallbackMessage);
}

function closeCodeFor(error: OrbisTransportError): number {
  return error.code === "authentication" ? 1008 : 1002;
}

export class OrbisRemoteConnection {
  private readonly socket: WebSocketLike;
  private readonly peer: PeerDescriptor;
  private readonly security: InitiatorSecurity;
  private readonly random: SecureRandom;
  private readonly expectedHostId: string;
  private readonly expectedHostKeyId: string;
  private readonly raceId: string;
  private readonly createId: () => string;
  private readonly requestTimeoutMs: number;
  private readonly activationTimeoutMs: number;
  private readonly localMaxFrameBytes: number;
  private readonly eventListeners = new Set<TransportEventListener>();
  private readonly closeListeners = new Set<RemoteConnectionCloseListener>();
  private readonly endpointManifestListeners = new Set<HostEndpointManifestListener>();
  private readonly diagnosticListeners = new Set<RemoteConnectionDiagnosticListener>();
  private readonly applicationFrameListeners = new Set<RemoteConnectionApplicationFrameListener>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly abandonedRequestIds = new Set<string>();
  private readonly abandonedRequestOrder: string[] = [];

  private stateValue: RemoteConnectionState = "connecting";
  private negotiatedMaxFrameBytes: number;
  private helloId?: string;
  private secureHandshake?: SecureInitiatorHandshake;
  private secureChannel?: OrbisSecureChannel;
  private welcomeFrame?: TransportWelcomeFrame;
  private endpointManifestValue?: HostEndpointManifest;
  private activationStarted = false;
  private incomingTail: Promise<unknown> = Promise.resolve();
  private handshakeResolve?: (welcome: TransportWelcomeFrame) => void;
  private handshakeReject?: (error: OrbisTransportError) => void;
  private activationResolve?: () => void;
  private activationReject?: (error: OrbisTransportError) => void;

  private readonly handshakePromise = new Promise<TransportWelcomeFrame>((resolve, reject) => {
    this.handshakeResolve = resolve;
    this.handshakeReject = reject;
  });

  private activationPromise?: Promise<void>;

  private readonly handleOpen: WebSocketEventListener = () => {
    void this.beginSecureHandshake().catch((error: unknown) => {
      const transportError = asTransportError(error, "The encrypted hello could not be sent");
      this.terminate(transportError, closeCodeFor(transportError));
    });
  };

  private readonly handleMessage: WebSocketEventListener = (event) => {
    const operation = this.incomingTail.then(() => this.processSocketMessage(event));
    this.incomingTail = operation.catch(() => undefined);
    void operation.catch((error: unknown) => {
      const transportError = asTransportError(error, "The encrypted frame could not be processed");
      this.terminate(transportError, closeCodeFor(transportError));
    });
  };

  private readonly handleError: WebSocketEventListener = () => {
    this.terminate(
      new OrbisTransportError("websocket", "The WebSocket reported an error", {
        retryable: true,
      }),
      1011,
    );
  };

  private readonly handleClose: WebSocketEventListener = (event) => {
    const wasClientClose = this.stateValue === "closing";
    this.stateValue = "closed";
    const closeEvent: RemoteConnectionClose = {
      code: event.code ?? 1006,
      reason: event.reason ?? "",
      wasClean: event.wasClean ?? false,
    };
    const error = new OrbisTransportError(
      "closed",
      wasClientClose
        ? "The remote connection was closed"
        : "The remote connection closed unexpectedly",
      { retryable: !wasClientClose },
    );

    this.handshakeReject?.(error);
    this.handshakeResolve = undefined;
    this.handshakeReject = undefined;
    this.activationReject?.(error);
    this.activationResolve = undefined;
    this.activationReject = undefined;
    this.rejectAllPending(error);
    this.detachSocketListeners();
    this.emitDiagnostic({
      at: Date.now(),
      code: closeEvent.code,
      type: "closed",
      wasClean: closeEvent.wasClean,
    });

    for (const listener of this.closeListeners) {
      try {
        listener(closeEvent);
      } catch {
        // Close observers do not own the socket lifecycle.
      }
    }
    this.diagnosticListeners.clear();
    this.applicationFrameListeners.clear();
    this.endpointManifestListeners.clear();
  };

  private constructor(
    socket: WebSocketLike,
    options: {
      peer: PeerDescriptor;
      security: InitiatorSecurity;
      random: SecureRandom;
      expectedHostId: string;
      expectedHostKeyId: string;
      raceId: string;
      createId: () => string;
      requestTimeoutMs: number;
      activationTimeoutMs: number;
      maxFrameBytes: number;
    },
  ) {
    this.socket = socket;
    this.peer = options.peer;
    this.security = options.security;
    this.random = options.random;
    this.expectedHostId = options.expectedHostId;
    this.expectedHostKeyId = options.expectedHostKeyId;
    this.raceId = options.raceId;
    this.createId = options.createId;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.activationTimeoutMs = options.activationTimeoutMs;
    this.localMaxFrameBytes = options.maxFrameBytes;
    this.negotiatedMaxFrameBytes = options.maxFrameBytes;

    this.socket.addEventListener("open", this.handleOpen);
    this.socket.addEventListener("message", this.handleMessage);
    this.socket.addEventListener("error", this.handleError);
    this.socket.addEventListener("close", this.handleClose);
  }

  static async connect(options: ConnectRemoteOptions): Promise<OrbisRemoteConnection> {
    const ticket = parseInput(connectionTicketSchema, options.ticket, "Connection ticket");
    const peer = parseInput(peerDescriptorSchema, options.peer, "Peer descriptor");
    if (peer.role !== "client") {
      throw new OrbisTransportError("invalid_argument", "Remote client peer role must be 'client'");
    }
    validateTicketCredential(ticket.ticket);

    const remoteKeyId = fingerprintPublicKey(options.security.remotePublicKey);
    if (
      ticket.host.publicKeyFingerprint === undefined ||
      ticket.host.publicKeyFingerprint !== remoteKeyId
    ) {
      throw new OrbisTransportError(
        "authentication",
        "The connection ticket host key does not match the pinned host identity",
      );
    }

    const maxTicketLifetimeMs = options.maxTicketLifetimeMs ?? DEFAULT_MAX_TICKET_LIFETIME_MS;
    validateTicketLifetime(ticket.expiresAt, (options.now ?? Date.now)(), maxTicketLifetimeMs);

    const url = validateSocketUrl(
      ticket.websocketUrl,
      ticket.ticket,
      options.allowInsecureWebSocket ?? false,
    );
    return await OrbisRemoteConnection.connectSocket({
      url,
      headers: Object.freeze({ Authorization: `Bearer ${ticket.ticket}` }),
      peer,
      security: options.security,
      random: options.random,
      webSocketFactory: options.webSocketFactory,
      expectedHostId: ticket.host.id,
      expectedHostKeyId: remoteKeyId,
      signal: options.signal,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      maxFrameBytes: options.maxFrameBytes,
      createId: options.createId,
    });
  }

  /**
   * Opens an independent direct data-plane connection. `ws:` is accepted only
   * for a private/LAN endpoint; relay connections continue to require WSS.
   */
  static async connectEndpoint(options: ConnectEndpointOptions): Promise<OrbisRemoteConnection> {
    const peer = parseInput(peerDescriptorSchema, options.peer, "Peer descriptor");
    if (peer.role !== "client") {
      throw new OrbisTransportError("invalid_argument", "Remote client peer role must be 'client'");
    }
    const hostId = parseInput(identifierSchema, options.hostId, "Direct host id");
    const url = validateDirectSocketUrl(options.websocketUrl);
    return await OrbisRemoteConnection.connectSocket({
      url,
      headers: Object.freeze({}),
      peer,
      security: options.security,
      random: options.random,
      webSocketFactory: options.webSocketFactory,
      expectedHostId: hostId,
      expectedHostKeyId: fingerprintPublicKey(options.security.remotePublicKey),
      signal: options.signal,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      maxFrameBytes: options.maxFrameBytes,
      createId: options.createId,
      raceId: options.raceId,
      deferActivation: options.deferActivation,
    });
  }

  get state(): RemoteConnectionState {
    return this.stateValue;
  }

  get welcome(): TransportWelcomeFrame {
    if (!this.welcomeFrame) {
      throw new OrbisTransportError("closed", "The remote connection is not established");
    }
    return this.welcomeFrame;
  }

  get endpointManifest(): HostEndpointManifest {
    if (this.endpointManifestValue === undefined) {
      throw new OrbisTransportError("closed", "The endpoint manifest is not available");
    }
    return this.endpointManifestValue;
  }

  onEndpointManifest(listener: HostEndpointManifestListener): () => void {
    this.endpointManifestListeners.add(listener);
    return () => this.endpointManifestListeners.delete(listener);
  }

  async activate(): Promise<void> {
    if (this.stateValue === "open") return;
    if (this.stateValue !== "provisional") {
      throw new OrbisTransportError("closed", "The endpoint connection is not provisional");
    }
    if (this.activationStarted) {
      if (this.activationPromise === undefined) {
        throw new OrbisTransportError("protocol", "Endpoint activation state is inconsistent");
      }
      return await this.activationPromise;
    }
    this.activationStarted = true;
    const activationPromise = new Promise<void>((resolve, reject) => {
      this.activationResolve = resolve;
      this.activationReject = reject;
    });
    this.activationPromise = activationPromise;
    const scope = createAbortScope(undefined, this.activationTimeoutMs);
    const abortActivation = () => this.terminate(abortError(scope), 1002);
    scope.signal.addEventListener("abort", abortActivation, { once: true });
    try {
      await this.sendEncryptedFrame(
        transportActivateFrameSchema.parse({
          kind: "activate",
          id: this.nextId(),
          raceId: this.raceId,
        }),
        true,
      );
      await activationPromise;
    } finally {
      scope.signal.removeEventListener("abort", abortActivation);
      scope.dispose();
    }
  }

  onEvent(listener: TransportEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClose(listener: RemoteConnectionCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onDiagnostic(listener: RemoteConnectionDiagnosticListener): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  onApplicationFrame(listener: RemoteConnectionApplicationFrameListener): () => void {
    this.applicationFrameListeners.add(listener);
    return () => this.applicationFrameListeners.delete(listener);
  }

  async request<T>(
    methodInput: string,
    paramsInput: JsonValue,
    resultSchema: z.ZodType<T>,
    options: RemoteRequestOptions = {},
  ): Promise<T> {
    if (this.stateValue !== "open") {
      throw new OrbisTransportError("closed", "The remote connection is not open");
    }

    const method = parseInput(methodSchema, methodInput, "Remote method");
    const params = parseInput(jsonValueSchema, paramsInput, "Remote request parameters");
    const requestId = this.nextId();
    if (this.pendingRequests.has(requestId) || this.abandonedRequestIds.has(requestId)) {
      throw new OrbisTransportError("invalid_argument", "createId produced a duplicate request id");
    }
    const scope = createAbortScope(options.signal, options.timeoutMs ?? this.requestTimeoutMs);
    if (scope.signal.aborted) {
      const error = abortError(scope);
      scope.dispose();
      throw error;
    }

    return new Promise<T>((resolve, reject) => {
      const startedAt = Date.now();
      const onAbort = () => {
        if (!this.pendingRequests.has(requestId)) {
          return;
        }
        const error = abortError(scope);
        this.finishPending(requestId, error);
        this.rememberAbandonedRequest(requestId);
        this.sendCancel(requestId, error.code === "timeout" ? "timeout" : "aborted");
      };

      scope.signal.addEventListener("abort", onAbort, { once: true });
      this.pendingRequests.set(requestId, {
        method,
        schema: resultSchema,
        startedAt,
        resolve,
        reject,
        dispose: () => {
          scope.signal.removeEventListener("abort", onAbort);
          scope.dispose();
        },
      });
      const frame = transportRequestFrameSchema.parse({
        kind: "request",
        id: this.nextId(),
        requestId,
        method,
        params,
      });
      this.emitDiagnostic({ at: startedAt, method, requestId, type: "request_started" });
      this.emitApplicationFrame({
        at: startedAt,
        direction: "outbound",
        kind: "request",
        method,
        payload: frame.params,
        requestId,
      });

      void this.sendEncryptedFrame(frame).catch((error: unknown) => {
        this.finishPending(
          requestId,
          asTransportError(error, "The remote request could not be sent"),
        );
      });
    });
  }

  async ack(eventInput: TransportEvent): Promise<void> {
    const event = parseInput(transportEventSchema, eventInput, "Transport event");
    if (event.durability !== "durable") {
      throw new OrbisTransportError(
        "invalid_argument",
        "Only durable transport events can be acknowledged",
      );
    }
    await this.sendEncryptedFrame(
      transportAckFrameSchema.parse({
        kind: "ack",
        id: this.nextId(),
        sessionId: event.sessionId,
        eventSeq: event.eventSeq,
      }),
    );
  }

  close(code = 1000, reason = "Client closed"): void {
    if (this.stateValue === "closed" || this.stateValue === "closing") {
      return;
    }
    if (
      !Number.isInteger(code) ||
      (code !== 1000 && (code < 3000 || code > 4999)) ||
      byteLength(reason) > 123
    ) {
      throw new OrbisTransportError(
        "invalid_argument",
        "The WebSocket close code or reason is invalid",
      );
    }

    this.stateValue = "closing";
    this.rejectAllPending(new OrbisTransportError("closed", "The remote connection was closed"));
    try {
      this.socket.close(code, reason);
    } catch {
      this.stateValue = "closed";
      this.detachSocketListeners();
      throw new OrbisTransportError("websocket", "The WebSocket could not be closed");
    }
  }

  private async beginSecureHandshake(): Promise<void> {
    if (this.stateValue !== "connecting" || this.secureHandshake !== undefined) {
      throw new OrbisTransportError("protocol", "The WebSocket opened in an invalid state");
    }
    if (this.socket.protocol !== ORBIS_TRANSPORT_SUBPROTOCOL) {
      throw new OrbisTransportError(
        "protocol",
        "The WebSocket did not negotiate the Orbis subprotocol",
      );
    }

    this.helloId = this.nextId();
    this.secureHandshake = await createSecureInitiatorHandshake({
      security: this.security,
      random: this.random,
      hello: transportHelloFrameSchema.parse({
        kind: "hello",
        id: this.helloId,
        raceId: this.raceId,
        protocolVersion: ORBIS_TRANSPORT_PROTOCOL_VERSION,
        peer: this.peer,
      }),
    });
    this.sendOuterFrame(this.secureHandshake.frame, true);
  }

  private async processSocketMessage(event: WebSocketEvent): Promise<void> {
    if (
      this.stateValue !== "connecting" &&
      this.stateValue !== "provisional" &&
      this.stateValue !== "open"
    ) {
      return;
    }
    if (typeof event.data !== "string") {
      throw new OrbisTransportError("protocol", "The remote server sent a non-text frame");
    }
    if (byteLength(event.data) > this.localMaxFrameBytes) {
      const error = new OrbisTransportError("protocol", "The remote frame exceeded the size limit");
      this.terminate(error, 1009);
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      throw new OrbisTransportError("protocol", "The remote frame was not valid JSON");
    }

    if (this.stateValue === "connecting") {
      if (!this.secureHandshake) {
        throw new OrbisTransportError("protocol", "The remote server replied before secure hello");
      }
      const envelope = secureWelcomeEnvelopeSchema.parse(raw);
      const result = await this.secureHandshake.finish(envelope);
      const welcome = transportWelcomeFrameSchema.parse(result.welcome);
      if (
        welcome.id !== this.helloId ||
        welcome.host.id !== this.expectedHostId ||
        welcome.host.publicKeyFingerprint !== this.expectedHostKeyId ||
        welcome.endpointManifest.hostId !== this.expectedHostId ||
        welcome.endpointManifest.hostKeyId !== this.expectedHostKeyId
      ) {
        throw new OrbisTransportError(
          "authentication",
          "The encrypted welcome did not match the requested host",
        );
      }

      this.secureChannel = result.channel;
      this.welcomeFrame = welcome;
      this.endpointManifestValue = normalizeHostEndpointManifest(welcome.endpointManifest);
      this.negotiatedMaxFrameBytes = Math.min(
        this.localMaxFrameBytes,
        welcome.capabilities.maxFrameBytes ?? this.localMaxFrameBytes,
      );
      this.stateValue = "provisional";
      this.handshakeResolve?.(welcome);
      this.handshakeResolve = undefined;
      this.handshakeReject = undefined;
      return;
    }

    const channel = this.secureChannel;
    if (!channel) {
      throw new OrbisTransportError("authentication", "The encrypted channel is unavailable");
    }
    const plaintext = await channel.open(secureMessageEnvelopeSchema.parse(raw));
    const frame = incomingTransportFrameSchema.parse(plaintext);
    switch (frame.kind) {
      case "welcome":
        throw new OrbisTransportError("protocol", "The remote host sent more than one welcome");
      case "activated":
        if (this.stateValue !== "provisional" || frame.raceId !== this.raceId) {
          throw new OrbisTransportError(
            "authentication",
            "The endpoint activation did not match this connection race",
          );
        }
        this.stateValue = "open";
        this.activationResolve?.();
        this.activationResolve = undefined;
        this.activationReject = undefined;
        break;
      case "endpoint_manifest": {
        if (this.stateValue !== "open") {
          throw new OrbisTransportError(
            "protocol",
            "The host updated endpoints before the connection was active",
          );
        }
        const manifest = normalizeHostEndpointManifest(
          hostEndpointManifestSchema.parse(frame.manifest),
        );
        if (
          manifest.hostId !== this.expectedHostId ||
          manifest.hostKeyId !== this.expectedHostKeyId
        ) {
          throw new OrbisTransportError(
            "authentication",
            "The endpoint update did not match the pinned host identity",
          );
        }
        const current = this.endpointManifestValue;
        if (current !== undefined && manifest.revision < current.revision) break;
        if (
          current !== undefined &&
          manifest.revision === current.revision &&
          JSON.stringify(manifest) !== JSON.stringify(current)
        ) {
          throw new OrbisTransportError(
            "protocol",
            "The host reused an endpoint revision for different content",
          );
        }
        if (current !== undefined && manifest.revision === current.revision) break;
        this.endpointManifestValue = manifest;
        for (const listener of this.endpointManifestListeners) {
          try {
            listener(manifest);
          } catch {
            // Endpoint observers never own the encrypted connection.
          }
        }
        break;
      }
      case "response":
        if (this.stateValue !== "open") {
          throw new OrbisTransportError("protocol", "The host replied before endpoint activation");
        }
        this.emitApplicationFrame({
          at: Date.now(),
          direction: "inbound",
          kind: "response",
          payload: frame.result,
          requestId: frame.requestId,
        });
        this.handleResponse(frame.requestId, frame.result);
        break;
      case "error":
        if (this.stateValue !== "open") {
          throw new OrbisTransportError("protocol", "The host failed before endpoint activation");
        }
        this.handleRemoteError(frame.requestId, frame.error);
        break;
      case "event":
        if (this.stateValue !== "open") {
          throw new OrbisTransportError("protocol", "The host emitted before endpoint activation");
        }
        this.emitApplicationFrame({
          at: Date.now(),
          cursor: frame.event.eventSeq,
          direction: "inbound",
          durability: frame.event.durability,
          eventId: frame.event.eventId,
          eventType: frame.event.type,
          kind: "event",
          payload: frame.event.payload,
          sessionId: frame.event.sessionId,
        });
        this.emitDiagnostic({
          at: Date.now(),
          cursor: frame.event.eventSeq,
          durability: frame.event.durability,
          type: "event_received",
        });
        this.dispatchEvent(frame.event);
        break;
    }
  }

  private dispatchEvent(event: TransportEvent): void {
    for (const listener of this.eventListeners) {
      try {
        const result = listener(event);
        if (result && typeof result.then === "function") {
          void result.catch(() => undefined);
        }
      } catch {
        // Passive consumer failures cannot corrupt the transport loop.
      }
    }
  }

  private nextId(): string {
    let value: string;
    try {
      value = this.createId();
    } catch (error) {
      if (error instanceof OrbisTransportError) {
        throw error;
      }
      throw new OrbisTransportError("invalid_argument", "createId failed");
    }
    return parseInput(identifierSchema, value, "Generated transport id");
  }

  private async sendEncryptedFrame(frame: JsonValue, allowProvisional = false): Promise<void> {
    if (
      (this.stateValue !== "open" && !(allowProvisional && this.stateValue === "provisional")) ||
      !this.secureChannel
    ) {
      throw new OrbisTransportError("closed", "The remote connection is not open");
    }
    const envelope = await this.secureChannel.seal(frame, {
      maxEnvelopeBytes: this.negotiatedMaxFrameBytes,
    });
    try {
      this.sendOuterFrame(envelope, false, allowProvisional);
    } catch (error) {
      if (
        error instanceof OrbisTransportError &&
        error.code === "invalid_argument" &&
        (this.stateValue === "open" || this.stateValue === "provisional")
      ) {
        this.terminate(error, 1009);
      }
      throw error;
    }
  }

  private sendOuterFrame(frame: unknown, duringHandshake: boolean, allowProvisional = false): void {
    if (
      this.socket.readyState !== OPEN_READY_STATE ||
      (duringHandshake
        ? this.stateValue !== "connecting"
        : this.stateValue !== "open" && !(allowProvisional && this.stateValue === "provisional"))
    ) {
      throw new OrbisTransportError("closed", "The remote connection is not open");
    }

    let encoded: string;
    try {
      encoded = JSON.stringify(frame);
    } catch {
      throw new OrbisTransportError("invalid_argument", "The transport frame is not serializable");
    }
    if (byteLength(encoded) > this.negotiatedMaxFrameBytes) {
      throw new OrbisTransportError(
        "invalid_argument",
        "The transport frame exceeds the size limit",
      );
    }
    try {
      this.socket.send(encoded);
    } catch {
      const error = new OrbisTransportError("websocket", "The WebSocket send failed", {
        retryable: true,
      });
      this.terminate(error, 1011);
      throw error;
    }
  }

  private sendCancel(requestId: string, reason: "aborted" | "timeout"): void {
    if (this.stateValue !== "open") {
      return;
    }
    void this.sendEncryptedFrame(
      transportCancelFrameSchema.parse({
        kind: "cancel",
        id: this.nextId(),
        requestId,
        reason,
      }),
    ).catch(() => undefined);
  }

  private handleResponse(requestId: string, result: JsonValue): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      if (this.abandonedRequestIds.has(requestId)) {
        return;
      }
      this.failProtocol("The remote response referenced an unknown request");
      return;
    }

    let parsed: z.ZodSafeParseResult<unknown>;
    try {
      parsed = pending.schema.safeParse(result);
    } catch {
      this.finishPending(
        requestId,
        new OrbisTransportError("protocol", "The remote result validator failed"),
      );
      return;
    }
    if (!parsed.success) {
      this.finishPending(
        requestId,
        new OrbisTransportError("protocol", "The remote result did not match the requested schema"),
      );
      return;
    }

    this.pendingRequests.delete(requestId);
    pending.dispose();
    this.emitDiagnostic({
      at: Date.now(),
      durationMs: Math.max(0, Date.now() - pending.startedAt),
      method: pending.method,
      requestId,
      type: "request_succeeded",
    });
    pending.resolve(parsed.data);
  }

  private handleRemoteError(
    requestId: string | undefined,
    remoteError: {
      code: string;
      retryable?: boolean;
      retryAfterMs?: number;
    },
  ): void {
    const error = new OrbisTransportError("remote_request", "The remote request failed", {
      serverCode: remoteError.code,
      retryable: remoteError.retryable,
      retryAfterMs: remoteError.retryAfterMs,
    });
    if (requestId === undefined) {
      this.terminate(error, 1011);
      return;
    }
    if (!this.pendingRequests.has(requestId)) {
      if (this.abandonedRequestIds.has(requestId)) {
        return;
      }
      this.failProtocol("The remote error referenced an unknown request");
      return;
    }
    this.finishPending(requestId, error);
  }

  private finishPending(requestId: string, error: OrbisTransportError): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(requestId);
    pending.dispose();
    this.emitDiagnostic({
      at: Date.now(),
      durationMs: Math.max(0, Date.now() - pending.startedAt),
      errorCode: error.code,
      method: pending.method,
      requestId,
      retryable: error.retryable,
      ...(error.serverCode === undefined ? {} : { serverCode: error.serverCode }),
      type: "request_failed",
    });
    pending.reject(error);
  }

  private rememberAbandonedRequest(requestId: string): void {
    this.abandonedRequestIds.add(requestId);
    this.abandonedRequestOrder.push(requestId);
    if (this.abandonedRequestOrder.length > MAX_ABANDONED_REQUESTS) {
      const expired = this.abandonedRequestOrder.shift();
      if (expired !== undefined) {
        this.abandonedRequestIds.delete(expired);
      }
    }
  }

  private failProtocol(message: string): void {
    this.terminate(new OrbisTransportError("protocol", message), 1002);
  }

  private terminate(error: OrbisTransportError, closeCode: number): void {
    if (this.stateValue === "closed" || this.stateValue === "closing") {
      return;
    }
    this.stateValue = "closing";
    this.handshakeReject?.(error);
    this.handshakeResolve = undefined;
    this.handshakeReject = undefined;
    this.activationReject?.(error);
    this.activationResolve = undefined;
    this.activationReject = undefined;
    this.rejectAllPending(error);
    try {
      this.socket.close(closeCode, "Orbis transport closed");
    } catch {
      this.stateValue = "closed";
      this.detachSocketListeners();
    }
  }

  private rejectAllPending(error: OrbisTransportError): void {
    for (const requestId of [...this.pendingRequests.keys()]) this.finishPending(requestId, error);
  }

  private emitDiagnostic(event: RemoteConnectionDiagnostic): void {
    for (const listener of this.diagnosticListeners) {
      try {
        listener(event);
      } catch {
        // Debug observers never affect encrypted delivery or request lifetime.
      }
    }
  }

  private emitApplicationFrame(frame: RemoteConnectionApplicationFrame): void {
    for (const listener of this.applicationFrameListeners) {
      try {
        listener(frame);
      } catch {
        // Debug observers never affect encrypted delivery or request lifetime.
      }
    }
  }

  private detachSocketListeners(): void {
    this.socket.removeEventListener("open", this.handleOpen);
    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.removeEventListener("error", this.handleError);
    this.socket.removeEventListener("close", this.handleClose);
  }

  private static async connectSocket(options: {
    url: URL;
    headers: Readonly<Record<string, string>>;
    peer: PeerDescriptor;
    security: InitiatorSecurity;
    random: SecureRandom;
    webSocketFactory: WebSocketFactory;
    expectedHostId: string;
    expectedHostKeyId: string;
    signal?: AbortSignal;
    handshakeTimeoutMs?: number;
    requestTimeoutMs?: number;
    maxFrameBytes?: number;
    createId?: () => string;
    raceId?: string;
    deferActivation?: boolean;
  }): Promise<OrbisRemoteConnection> {
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new OrbisTransportError(
        "invalid_argument",
        "requestTimeoutMs must be a positive number",
      );
    }
    const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1024) {
      throw new OrbisTransportError(
        "invalid_argument",
        "maxFrameBytes must be an integer of at least 1024 bytes",
      );
    }
    const activationTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const createId = options.createId ?? defaultCreateId;
    const raceId = parseInput(identifierSchema, options.raceId ?? createId(), "Connection race id");
    const scope = createAbortScope(options.signal, activationTimeoutMs);
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
        protocols: [ORBIS_TRANSPORT_SUBPROTOCOL],
        headers: options.headers,
      });
    } catch {
      scope.dispose();
      throw new OrbisTransportError("websocket", "The WebSocket could not be created", {
        retryable: true,
      });
    }

    const connection = new OrbisRemoteConnection(socket, {
      peer: options.peer,
      security: options.security,
      random: options.random,
      expectedHostId: options.expectedHostId,
      expectedHostKeyId: options.expectedHostKeyId,
      raceId,
      createId,
      requestTimeoutMs,
      activationTimeoutMs,
      maxFrameBytes,
    });
    const abortHandshake = () => connection.terminate(abortError(scope), 1002);
    scope.signal.addEventListener("abort", abortHandshake, { once: true });
    if (scope.signal.aborted) {
      abortHandshake();
    }

    try {
      await connection.handshakePromise;
      if (options.deferActivation !== true) await connection.activate();
      return connection;
    } finally {
      scope.signal.removeEventListener("abort", abortHandshake);
      scope.dispose();
    }
  }
}
