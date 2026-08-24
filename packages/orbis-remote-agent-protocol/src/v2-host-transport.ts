import { AgentBackendError, isAgentBackendError } from "@orbisapp/orbis-agent-backend";
import {
  OrbisTransportError,
  type JsonValue,
  type OrbisRemoteHostConnection,
  type RemoteHostPeer,
  type RemoteHostRequestHandler,
} from "@orbisapp/transport";

import {
  createRemoteAgentHostPeer,
  type RemoteAgentHostDeliveryTransport,
  type RemoteAgentHostPeer,
} from "./host";
import { ORBIS_REMOTE_AGENT_V2_METHOD_SCOPES } from "./v2-constants";
import { OrbisRemoteAgentV2Host } from "./v2-host";

type HostConnectionPort = Pick<OrbisRemoteHostConnection, "onClose" | "peers" | "sendEvent"> &
  Partial<Pick<OrbisRemoteHostConnection, "onPeer">>;

/** Sends v2 envelopes through the existing authenticated encrypted transport. */
export class OrbisRemoteAgentV2HostTransport implements RemoteAgentHostDeliveryTransport {
  private readonly connections = new Set<HostConnectionPort>();
  private readonly peerDisconnectedListeners = new Set<(peer: RemoteAgentHostPeer) => void>();

  onPeerDisconnected(listener: (peer: RemoteAgentHostPeer) => void): () => void {
    this.peerDisconnectedListeners.add(listener);
    return () => this.peerDisconnectedListeners.delete(listener);
  }

  attach(connection: HostConnectionPort): () => void {
    this.connections.add(connection);
    const knownPeers = new Map<string, RemoteAgentHostPeer>();
    const rememberPeers = (peers: readonly RemoteHostPeer[]): void => {
      for (const peer of peers) {
        const mapped = createRemoteAgentHostPeer(peer);
        knownPeers.set(mapped.transportId, mapped);
      }
    };
    rememberPeers(connection.peers);
    const notifyDisconnected = (): void => {
      const peers = [...knownPeers.values()];
      knownPeers.clear();
      this.connections.delete(connection);
      for (const peer of peers) {
        for (const listener of this.peerDisconnectedListeners) listener(peer);
      }
    };
    const detachPeer = connection.onPeer?.((peer) => rememberPeers([peer]));
    const detachClosed = connection.onClose(notifyDisconnected);
    return () => {
      notifyDisconnected();
      detachPeer?.();
      detachClosed();
    };
  }

  async send(
    peer: RemoteAgentHostPeer,
    event: Parameters<HostConnectionPort["sendEvent"]>[1],
  ): Promise<void> {
    const connection = [...this.connections].find((candidate) =>
      candidate.peers.some(
        (connectedPeer) =>
          connectedPeer.handshakeId === peer.transportId &&
          createRemoteAgentHostPeer(connectedPeer).id === peer.id,
      ),
    );
    if (connection === undefined) {
      throw new OrbisTransportError("closed", "The remote peer is not connected", {
        retryable: true,
      });
    }
    await connection.sendEvent(peer.transportId, event);
  }
}

export function createRemoteAgentV2HostRequestHandler(
  host: OrbisRemoteAgentV2Host,
): RemoteHostRequestHandler {
  return async (method: string, params: JsonValue, context) => {
    const requiredScopes =
      ORBIS_REMOTE_AGENT_V2_METHOD_SCOPES[
        method as keyof typeof ORBIS_REMOTE_AGENT_V2_METHOD_SCOPES
      ];
    if (requiredScopes?.some((scope) => !context.peer.scopes.includes(scope))) {
      throw new OrbisTransportError("authentication", "The paired client is not authorized", {
        serverCode: "forbidden",
      });
    }
    return host.handleRequest(method, params, {
      maxResponseBytes: context.maxResponseBytes,
      peer: createRemoteAgentHostPeer(context.peer),
      signal: context.signal,
    });
  };
}

export function v2AgentError(error: unknown): AgentBackendError {
  if (isAgentBackendError(error)) return error;
  return new AgentBackendError("unavailable", "The v2 remote agent service is unavailable", {
    retryable: true,
  });
}

export type { RemoteHostPeer };
