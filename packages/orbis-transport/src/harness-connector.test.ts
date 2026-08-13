import { describe, expect, test } from "vitest";

import { OrbisRemoteHarnessRouter } from "./harness-connector";
import type { RemoteHostPeer } from "./host-websocket";
import { ORBIS_REMOTE_SCOPES, type TransportEvent } from "./protocol";

const peer: RemoteHostPeer = {
  handshakeId: "handshake-1",
  keyId: "sha256:client",
  publicKey: "client-public-key",
  descriptor: { deviceId: "phone-1", role: "client", version: "1" },
  mode: "authenticated",
  scopes: [ORBIS_REMOTE_SCOPES.connect, ORBIS_REMOTE_SCOPES.agentWrite],
};

describe("OrbisRemoteHarnessRouter", () => {
  test("routes namespaced methods and broadcasts harness-owned events", async () => {
    const router = new OrbisRemoteHarnessRouter();
    const events: TransportEvent[] = [];
    router.attachBroadcaster({
      broadcastEvent: async (event) => {
        events.push(event);
      },
    });
    const session = await router.open({
      harnessId: "pi",
      methods: ["pi.session.prompt"],
      methodScopes: { "pi.session.prompt": [ORBIS_REMOTE_SCOPES.agentWrite] },
      eventScopes: [ORBIS_REMOTE_SCOPES.agentRead],
      handleRequest: async (_method, params) => ({ received: params }),
    });

    expect(
      await router.handleRequest(
        "pi.session.prompt",
        { text: "hello" },
        {
          maxResponseBytes: 1024 * 1024,
          peer,
          requestId: "request-1",
          signal: new AbortController().signal,
        },
      ),
    ).toEqual({ received: { text: "hello" } });

    const event: TransportEvent = {
      eventId: "event-1",
      sessionId: "session-1",
      eventSeq: 1,
      time: "2026-08-09T00:00:00.000Z",
      durability: "transient",
      type: "assistant.delta",
      payload: { text: "hi" },
      source: { harness: "pi" },
    };
    await session.emit(event);
    expect(events).toEqual([event]);
  });

  test("rejects duplicate method ownership and removes routes on close", async () => {
    const router = new OrbisRemoteHarnessRouter();
    const first = await router.open({
      harnessId: "pi",
      methods: ["pi.session.prompt"],
      methodScopes: { "pi.session.prompt": [ORBIS_REMOTE_SCOPES.agentWrite] },
      eventScopes: [ORBIS_REMOTE_SCOPES.agentRead],
      handleRequest: async () => null,
    });
    await expect(
      router.open({
        harnessId: "dsh",
        methods: ["pi.session.prompt"],
        methodScopes: { "pi.session.prompt": [ORBIS_REMOTE_SCOPES.agentWrite] },
        eventScopes: [ORBIS_REMOTE_SCOPES.agentRead],
        handleRequest: async () => null,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });

    await first.close();
    await expect(
      router.handleRequest(
        "pi.session.prompt",
        {},
        {
          maxResponseBytes: 1024 * 1024,
          peer,
          requestId: "request-1",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ serverCode: "method_not_found" });
  });

  test("rejects a method before dispatch when the paired key lacks its scope", async () => {
    const router = new OrbisRemoteHarnessRouter();
    let dispatched = false;
    await router.open({
      harnessId: "pi",
      methods: ["pi.session.prompt"],
      methodScopes: { "pi.session.prompt": [ORBIS_REMOTE_SCOPES.agentWrite] },
      eventScopes: [ORBIS_REMOTE_SCOPES.agentRead],
      handleRequest: async () => {
        dispatched = true;
        return null;
      },
    });

    await expect(
      router.handleRequest(
        "pi.session.prompt",
        {},
        {
          maxResponseBytes: 1024 * 1024,
          peer: { ...peer, scopes: [ORBIS_REMOTE_SCOPES.connect] },
          requestId: "request-1",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: "authentication", serverCode: "forbidden" });
    expect(dispatched).toBe(false);
  });
});
