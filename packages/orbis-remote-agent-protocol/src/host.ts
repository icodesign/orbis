import type {
  OrbisRemoteHostConnection,
  RemoteHostPeer,
  TransportEvent,
} from "@orbisapp/transport";

export interface RemoteAgentHostPeer {
  /** Stable paired-device identity used for v2 subscriptions and idempotency. */
  readonly id: string;
  /** Connection-scoped address used only to send an encrypted transport frame. */
  readonly transportId: string;
}

export interface RemoteAgentHostRequestContext {
  /** Maximum UTF-8 JSON bytes available to the application result value. */
  readonly maxResponseBytes: number;
  readonly peer: RemoteAgentHostPeer;
  readonly signal: AbortSignal;
}

/** A host-specific transport composition sends one encrypted frame to one paired peer. */
export interface RemoteAgentHostDeliveryTransport {
  send(peer: RemoteAgentHostPeer, event: TransportEvent): Promise<void>;
}

type HostConnectionPort = Pick<OrbisRemoteHostConnection, "onClose" | "peers" | "sendEvent">;

function peerIdentity(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join("|");
}

/** Converts an authenticated transport peer to v2's stable delivery identity. */
export function createRemoteAgentHostPeer(peer: RemoteHostPeer): RemoteAgentHostPeer {
  return {
    id: peerIdentity([peer.keyId, peer.descriptor.deviceId]),
    transportId: peer.handshakeId,
  };
}

/** Type-only connection port shared by the v2 host transport and host owner. */
export type RemoteAgentHostConnectionPort = HostConnectionPort;
