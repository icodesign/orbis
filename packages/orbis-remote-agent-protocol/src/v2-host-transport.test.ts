import type { RemoteHostPeer, TransportEvent, WebSocketEvent } from "@orbisapp/transport";
import { expect, test } from "vitest";

import type { RemoteAgentHostPeer } from "./host";
import { ORBIS_REMOTE_AGENT_V2_METHODS } from "./v2-constants";
import {
  createRemoteAgentV2HostRequestHandler,
  OrbisRemoteAgentV2HostTransport,
} from "./v2-host-transport";

const authenticatedPeer: RemoteHostPeer = {
  descriptor: {
    deviceId: "device-a",
    deviceName: "Phone A",
    role: "client",
    version: "1",
  },
  handshakeId: "transport-a",
  keyId: "sha256:phone-key",
  mode: "authenticated",
  publicKey: "public-key",
  scopes: [],
};

class FakeHostConnection {
  peers: readonly RemoteHostPeer[] = [authenticatedPeer];
  private readonly closeListeners = new Set<(event: WebSocketEvent) => void>();

  onClose(listener: (event: WebSocketEvent) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async sendEvent(_handshakeId: string, _event: TransportEvent): Promise<void> {}

  close(): void {
    this.peers = [];
    for (const listener of this.closeListeners) listener({});
  }
}

test("host transport reports authenticated peers on connection close", () => {
  const transport = new OrbisRemoteAgentV2HostTransport();
  const connection = new FakeHostConnection();
  const disconnected: RemoteAgentHostPeer[] = [];
  transport.onPeerDisconnected((peer) => disconnected.push(peer));
  transport.attach(connection);

  connection.close();

  expect(disconnected).toEqual([
    {
      deviceId: "device-a",
      deviceName: "Phone A",
      id: "16:sha256:phone-key|8:device-a",
      transportId: "transport-a",
    },
  ]);
});

test("host request handler enforces the subagent read scope", async () => {
  const handler = createRemoteAgentV2HostRequestHandler({
    handleRequest: async () => {
      throw new Error("must not reach host");
    },
  } as never);

  await expect(
    handler(
      ORBIS_REMOTE_AGENT_V2_METHODS.sessionsSubagentsList,
      {},
      {
        maxResponseBytes: 1024,
        peer: authenticatedPeer,
        requestId: "request-a",
        signal: new AbortController().signal,
      },
    ),
  ).rejects.toMatchObject({ code: "authentication", serverCode: "forbidden" });
});
