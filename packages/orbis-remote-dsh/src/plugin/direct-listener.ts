import {
  OrbisRemoteHostConnection,
  OrbisTransportError,
  type RemoteHost,
  type HostEndpointManifest,
  type RemoteHostPeer,
  type RemoteHostPeerError,
  type RemoteHostRequestHandler,
  type RemoteHostResolvedPeer,
  type SecureHelloEnvelope,
  type SecureRandom,
  type SerializedDeviceIdentity,
  type TransportCapabilities,
} from "@orbisapp/transport";
import type { WebSocket as NodeWsSocket, WebSocketServer as NodeWsServer } from "ws";

import { adaptNodeWebSocket } from "./node-websocket";

type Listener = (...args: unknown[]) => void;

export interface OrbisDirectHostListenerOptions {
  readonly listenHost: string;
  readonly port: number;
  readonly host: RemoteHost;
  readonly identity: SerializedDeviceIdentity;
  readonly random: SecureRandom;
  readonly capabilities: TransportCapabilities;
  readonly endpointManifest: HostEndpointManifest | (() => HostEndpointManifest);
  readonly resolvePeer: (frame: SecureHelloEnvelope) => Promise<RemoteHostResolvedPeer>;
  readonly commitPairing?: (peer: RemoteHostPeer) => Promise<void>;
  readonly requestHandler: RemoteHostRequestHandler;
  /** Called once for every accepted outer socket before peer traffic is used. Peer authentication remains internal. */
  readonly onConnection?: (connection: OrbisRemoteHostConnection) => void;
  readonly createId: () => string;
}

export type OrbisDirectHostListenerState = "closed" | "connecting" | "open";

function asTransportError(error: unknown, fallback: string): OrbisTransportError {
  return error instanceof OrbisTransportError
    ? error
    : new OrbisTransportError("websocket", fallback, { retryable: true });
}

async function loadWebSocketServer(): Promise<typeof NodeWsServer> {
  const loaded = (await import("ws")) as typeof import("ws") & {
    default?: { WebSocketServer?: typeof NodeWsServer };
  };
  const Server = loaded.WebSocketServer ?? loaded.default?.WebSocketServer;
  if (!Server) throw new Error("The ws package did not expose a WebSocketServer constructor");
  return Server;
}

/**
 * Owns one standalone local-network WebSocket listener. It deliberately does
 * not share DSH Web's HTTP server: the listener is only an outer carrier for
 * the authenticated, encrypted Orbis transport.
 */
export class OrbisDirectHostListener {
  private readonly connections = new Set<OrbisRemoteHostConnection>();
  private readonly sockets = new Map<OrbisRemoteHostConnection, NodeWsSocket>();
  private readonly peerListeners = new Set<(peer: RemoteHostPeer) => void>();
  private readonly peerErrorListeners = new Set<(event: RemoteHostPeerError) => void>();
  private readonly closeListeners = new Set<() => void>();
  private stateValue: OrbisDirectHostListenerState = "connecting";
  private didClose = false;
  private openResolve?: () => void;
  private openReject?: (error: Error) => void;
  private readonly openPromise = new Promise<void>((resolve, reject) => {
    this.openResolve = resolve;
    this.openReject = reject;
  });

  private constructor(
    private readonly server: NodeWsServer,
    private readonly options: OrbisDirectHostListenerOptions,
  ) {
    this.server.on("listening", this.handleListening);
    this.server.on("connection", this.handleConnection);
    this.server.on("error", this.handleServerError);
  }

  static async listen(options: OrbisDirectHostListenerOptions): Promise<OrbisDirectHostListener> {
    const Server = await loadWebSocketServer();
    const server = new Server({
      host: options.listenHost,
      port: options.port,
      path: "/orbis",
      clientTracking: true,
    });
    const listener = new OrbisDirectHostListener(server, options);
    await listener.openPromise;
    return listener;
  }

  get state(): OrbisDirectHostListenerState {
    return this.stateValue;
  }

  get peers(): readonly RemoteHostPeer[] {
    return [...this.connections].flatMap((connection) => connection.peers);
  }

  async broadcastEndpointManifest(manifest: HostEndpointManifest): Promise<void> {
    await Promise.all(
      [...this.connections].map(async (connection) => {
        await connection.broadcastEndpointManifest(manifest);
      }),
    );
  }

  get port(): number {
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("The direct Orbis listener does not have a TCP port");
    }
    return address.port;
  }

  onPeer(listener: (peer: RemoteHostPeer) => void): () => void {
    this.peerListeners.add(listener);
    return () => this.peerListeners.delete(listener);
  }

  onPeerError(listener: (event: RemoteHostPeerError) => void): () => void {
    this.peerErrorListeners.add(listener);
    return () => this.peerErrorListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  disconnectPeer(handshakeId: string): void {
    for (const connection of this.connections) {
      if (connection.peers.some((peer) => peer.handshakeId === handshakeId)) {
        connection.close(1008, "Orbis device revoked");
      }
    }
  }

  async close(): Promise<void> {
    if (this.didClose) return;
    this.didClose = true;
    this.stateValue = "closed";
    this.openReject?.(new Error("The direct Orbis listener was closed"));
    this.openResolve = undefined;
    this.openReject = undefined;
    const sockets = [...this.server.clients];
    const closeServer = new Promise<void>((resolve) => {
      try {
        this.server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    for (const connection of [...this.connections]) {
      connection.close(1000, "Direct Orbis host closed");
      this.sockets.get(connection)?.terminate?.();
    }
    for (const socket of sockets) socket.terminate?.();
    await closeServer;
    this.notifyClosed();
  }

  private readonly handleListening: Listener = () => {
    if (this.didClose || this.stateValue !== "connecting") return;
    this.stateValue = "open";
    this.openResolve?.();
    this.openResolve = undefined;
    this.openReject = undefined;
  };

  private readonly handleConnection: Listener = (socket: unknown) => {
    if (!(socket && typeof socket === "object")) return;
    void this.accept(socket as NodeWsSocket);
  };

  private readonly handleServerError: Listener = (error: unknown) => {
    const message = error instanceof Error ? error.message : "The direct Orbis listener failed";
    const failure = new Error(message);
    if (this.stateValue === "connecting") {
      this.openReject?.(failure);
      this.openResolve = undefined;
      this.openReject = undefined;
    }
    void this.close();
  };

  private async accept(socket: NodeWsSocket): Promise<void> {
    if (this.stateValue !== "open") {
      socket.close(1013, "Orbis direct listener unavailable");
      return;
    }
    let connection: OrbisRemoteHostConnection;
    try {
      connection = await OrbisRemoteHostConnection.accept({
        socket: adaptNodeWebSocket(socket),
        host: this.options.host,
        identity: this.options.identity,
        random: this.options.random,
        capabilities: this.options.capabilities,
        endpointManifest: this.options.endpointManifest,
        resolvePeer: this.options.resolvePeer,
        ...(this.options.commitPairing === undefined
          ? {}
          : { commitPairing: this.options.commitPairing }),
        requestHandler: this.options.requestHandler,
        createId: this.options.createId,
      });
    } catch (error) {
      socket.close(1008, "Orbis direct handshake rejected");
      this.notifyPeerError({ error: asTransportError(error, "The direct peer was rejected") });
      return;
    }
    this.connections.add(connection);
    this.sockets.set(connection, socket);
    try {
      this.options.onConnection?.(connection);
    } catch (error) {
      this.connections.delete(connection);
      this.sockets.delete(connection);
      connection.close(1011, "Orbis direct host connection setup failed");
      socket.close(1011, "Orbis direct host connection setup failed");
      this.notifyPeerError({
        error: asTransportError(error, "The direct peer could not attach to the Orbis host"),
      });
      return;
    }
    connection.onClose(() => {
      this.connections.delete(connection);
      this.sockets.delete(connection);
    });
    connection.onPeer((peer) => {
      for (const listener of this.peerListeners) {
        try {
          listener(peer);
        } catch {
          // Observers do not own the direct connection.
        }
      }
    });
    connection.onPeerError((event) => this.notifyPeerError(event));
  }

  private notifyPeerError(event: RemoteHostPeerError): void {
    for (const listener of this.peerErrorListeners) {
      try {
        listener(event);
      } catch {
        // Error observers cannot corrupt the listener.
      }
    }
  }

  private notifyClosed(): void {
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch {
        // Close observers do not own the listener lifecycle.
      }
    }
  }
}
