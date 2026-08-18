import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPairingSecret,
  generateDeviceIdentity,
  ORBIS_REMOTE_SCOPES,
  OrbisRemoteConnection,
  parsePairingInvitation,
  type RemoteHostRequestHandler,
  type WebSocketFactory,
  type WebSocketLike,
} from "@orbisapp/transport";
import { describe, expect, test } from "vitest";

import {
  ORBIS_DSH_IDENTITY_CREDENTIAL,
  OrbisDshHostService,
  discoverOrbisDirectAddresses,
  type OrbisDshAgentHost,
  type OrbisDshConfigurationInput,
  type OrbisDshCredentials,
  type OrbisDshDiscoveredAddress,
} from "./host-service";
import { createNodeWebSocketFactory } from "./node-websocket";
import { OrbisDshStateStore } from "./state-store";

function secureRandom(length: number): Promise<Uint8Array> {
  return Promise.resolve(new Uint8Array(randomBytes(length)));
}

class MemoryCredentials implements OrbisDshCredentials {
  private readonly values = new Map<string, string>();

  async resolve(reference: string): Promise<{ readonly value: string } | undefined> {
    const value = this.values.get(reference);
    return value === undefined ? undefined : { value };
  }

  async set(reference: string, value: string): Promise<void> {
    this.values.set(reference, value);
  }
}

function fakeAgentHost(): OrbisDshAgentHost & { readonly closed: boolean } {
  const host = {
    requestHandler: (() => Promise.resolve(undefined)) as unknown as RemoteHostRequestHandler,
    attach: () => () => undefined,
    close: async () => {
      (host as { closed: boolean }).closed = true;
    },
    closed: false,
  };
  return host;
}

function fakeAgentHostFactory(host?: OrbisDshAgentHost) {
  return { create: async () => host ?? fakeAgentHost() };
}

const testDirectAddresses = (): readonly OrbisDshDiscoveredAddress[] => [
  { kind: "lan", address: "127.0.0.1" },
  { kind: "tailnet", address: "100.64.0.12" },
];

type HostServiceArguments = ConstructorParameters<typeof OrbisDshHostService>;

function createService(
  stateStore: HostServiceArguments[0],
  credentials: HostServiceArguments[1],
  agentHostFactory: HostServiceArguments[2],
  random?: HostServiceArguments[3],
  createId?: HostServiceArguments[4],
  logger?: HostServiceArguments[5],
  discoverDirectAddresses: HostServiceArguments[6] = testDirectAddresses,
): OrbisDshHostService {
  return new OrbisDshHostService(
    stateStore,
    credentials,
    agentHostFactory,
    random,
    createId,
    logger,
    discoverDirectAddresses,
  );
}

async function makeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "orbis-dsh-service-"));
  const store = new OrbisDshStateStore(join(directory, "host.json"), () => "host-1");
  return {
    directory,
    store,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not probe a free TCP port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPairingFailure(service: OrbisDshHostService): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await service.status()).pairing?.phase === "failed") return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("The pairing did not enter the failed state");
}

async function waitForDeviceError(service: OrbisDshHostService, keyId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await service.status()).devices.some((device) => device.keyId === keyId && device.error)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("The device did not enter the failed state");
}

function tamperFirstFrame(factory: WebSocketFactory): WebSocketFactory {
  return (request): WebSocketLike => {
    const socket = factory(request);
    let firstFrame = true;
    return {
      get readyState() {
        return socket.readyState;
      },
      get protocol() {
        return socket.protocol;
      },
      addEventListener: (type, listener) => socket.addEventListener(type, listener),
      removeEventListener: (type, listener) => socket.removeEventListener(type, listener),
      send: (data) => {
        if (!firstFrame) {
          socket.send(data);
          return;
        }
        firstFrame = false;
        const frame = JSON.parse(data) as { ciphertext?: string };
        if (typeof frame.ciphertext === "string") {
          frame.ciphertext = `${frame.ciphertext.startsWith("A") ? "B" : "A"}${frame.ciphertext.slice(1)}`;
        }
        socket.send(JSON.stringify(frame));
      },
      close: (code, reason) => socket.close(code, reason),
    };
  };
}

function directConfiguration(directPort: number): OrbisDshConfigurationInput {
  return { directPort, hostName: "MacBook" };
}

describe("OrbisDshHostService", () => {
  test("discovers private LAN and Tailnet IPv4 addresses without advertising public interfaces", () => {
    const discovered = discoverOrbisDirectAddresses({
      en0: [
        {
          address: "192.168.50.10",
          cidr: "192.168.50.10/24",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          netmask: "255.255.255.0",
        },
        {
          address: "203.0.113.10",
          cidr: "203.0.113.10/24",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:02",
          netmask: "255.255.255.0",
        },
      ],
      utun0: [
        {
          address: "100.64.0.12",
          cidr: "100.64.0.12/32",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:03",
          netmask: "255.255.255.255",
        },
      ],
    });
    expect(discovered).toEqual([
      { kind: "lan", address: "192.168.50.10" },
      { kind: "tailnet", address: "100.64.0.12" },
    ]);
  });

  test("reports a fresh host as unconfigured", async () => {
    const { store, cleanup } = await makeFixture();
    try {
      const service = createService(store, new MemoryCredentials(), fakeAgentHostFactory());
      const status = await service.status();
      expect(status.configuration.hostId).toBe("host-1");
      expect(status.configuration.ready).toBe(false);
      expect(status.configuration.endpoints).toEqual([]);
      expect(status.configuration.endpointRevision).toBe(0);
      expect(status.devices).toEqual([]);
      expect(status.connection.state).toBe("disconnected");
    } finally {
      await cleanup();
    }
  });

  test("increments the endpoint revision when an automatic address changes", async () => {
    const { store, cleanup } = await makeFixture();
    let addresses = testDirectAddresses();
    const service = createService(
      store,
      new MemoryCredentials(),
      fakeAgentHostFactory(),
      undefined,
      undefined,
      undefined,
      () => addresses,
    );
    try {
      await service.configure(directConfiguration(47_000));
      const initial = await service.status();
      addresses = [{ kind: "lan", address: "192.168.50.10" }];
      const updated = await service.status();
      expect(updated.configuration.autoDirectEndpoints).toEqual([
        { kind: "lan", url: "ws://192.168.50.10:47000/orbis" },
      ]);
      expect(updated.configuration.endpointRevision).toBeGreaterThan(
        initial.configuration.endpointRevision,
      );
    } finally {
      await service.dispose();
      await cleanup();
    }
  });

  test("persists and advertises local-network and Tailscale endpoints", async () => {
    const { store, cleanup } = await makeFixture();
    try {
      const service = createService(store, new MemoryCredentials(), fakeAgentHostFactory());
      const input = directConfiguration(47_123);

      await service.configure(input);
      expect(await store.load()).toMatchObject({
        version: 2,
        hostName: "MacBook",
        directPort: 47_123,
        endpointRevision: 1,
      });

      const status = await service.status();
      expect(status.configuration.ready).toBe(true);
      expect(status.configuration.endpoints).toEqual([
        { kind: "lan", url: "ws://127.0.0.1:47123/orbis" },
        { kind: "tailnet", url: "ws://100.64.0.12:47123/orbis" },
      ]);

      await service.configure(input);
      expect((await store.load()).endpointRevision).toBe(1);
      await service.configure({ ...input, hostName: "Studio Mac" });
      expect((await store.load()).endpointRevision).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("rejects invalid or unavailable local-network configuration", async () => {
    const { store, cleanup } = await makeFixture();
    try {
      const service = createService(store, new MemoryCredentials(), fakeAgentHostFactory());
      await expect(
        service.configure({ ...directConfiguration(47_000), hostName: "" }),
      ).rejects.toThrow(/name/u);
      await expect(service.configure(directConfiguration(80))).rejects.toThrow(/port/u);

      const noNetworkService = createService(
        store,
        new MemoryCredentials(),
        fakeAgentHostFactory(),
        undefined,
        undefined,
        undefined,
        () => [],
      );
      await expect(noNetworkService.configure(directConfiguration(47_000))).rejects.toThrow(
        /local network or Tailscale/u,
      );
    } finally {
      await cleanup();
    }
  });

  test("creates a pairing invitation whose welcome advertises only available networks", async () => {
    const { store, cleanup } = await makeFixture();
    const credentials = new MemoryCredentials();
    const port = await freePort();
    let hostIdSequence = 0;
    const service = createService(store, credentials, fakeAgentHostFactory(), undefined, () =>
      hostIdSequence++ === 0 ? "pairing-1" : `host-frame-${hostIdSequence}`,
    );
    try {
      await service.configure(directConfiguration(port));
      const pairing = await service.startPairing();
      const invitation = parsePairingInvitation(pairing.invitation);
      expect(pairing.pairingId).toBe("pairing-1");
      expect(pairing.phase).toBe("awaiting-device");
      expect(pairing.transport).toBe("lan");
      expect(invitation.endpoint).toEqual({
        kind: "lan",
        url: `ws://127.0.0.1:${port}/orbis`,
      });
      expect(invitation.scopeMode).toBe("all");
      expect(
        (await service.status()).configuration.endpoints.map((endpoint) => endpoint.kind),
      ).toEqual(["lan", "tailnet"]);

      const clientIdentity = await generateDeviceIdentity(secureRandom);
      let clientIdSequence = 0;
      const connection = await OrbisRemoteConnection.connectEndpoint({
        websocketUrl: invitation.endpoint.url,
        hostId: invitation.hostId,
        peer: {
          deviceId: clientIdentity.keyId,
          deviceName: "Test iPhone",
          role: "client",
          version: "1.0.0",
        },
        security: {
          mode: "pairing",
          identity: clientIdentity,
          remotePublicKey: invitation.hostPublicKey,
          pairing: {
            pairingId: invitation.pairingId,
            secret: invitation.pairingSecret,
          },
        },
        random: secureRandom,
        webSocketFactory: await createNodeWebSocketFactory(),
        createId: () => `client-frame-${++clientIdSequence}`,
      });
      expect(connection.endpointManifest.endpoints.map((endpoint) => endpoint.kind)).toEqual([
        "lan",
        "tailnet",
      ]);
      expect((await store.load()).peers[0]).toMatchObject({
        deviceName: "Test iPhone",
        keyId: clientIdentity.keyId,
        scopeMode: "all",
      });
      connection.close();

      const storedIdentity = await credentials.resolve(ORBIS_DSH_IDENTITY_CREDENTIAL);
      expect(storedIdentity?.value).toBeDefined();
      expect(JSON.parse(storedIdentity?.value ?? "{}")).toHaveProperty("publicKey");
      expect((await service.status()).pairing).toBeUndefined();
    } finally {
      await service.dispose();
      await cleanup();
    }
  });

  test("routes a failed pairing handshake to the pairing state", async () => {
    const { store, cleanup } = await makeFixture();
    const service = createService(store, new MemoryCredentials(), fakeAgentHostFactory());
    try {
      await service.configure(directConfiguration(await freePort()));
      const pairing = await service.startPairing();
      const invitation = parsePairingInvitation(pairing.invitation);
      const clientIdentity = await generateDeviceIdentity(secureRandom);

      await expect(
        OrbisRemoteConnection.connectEndpoint({
          websocketUrl: invitation.endpoint.url,
          hostId: invitation.hostId,
          peer: {
            deviceId: clientIdentity.keyId,
            deviceName: "Failed iPhone",
            role: "client",
            version: "1.0.0",
          },
          security: {
            mode: "pairing",
            identity: clientIdentity,
            remotePublicKey: invitation.hostPublicKey,
            pairing: {
              pairingId: invitation.pairingId,
              secret: await createPairingSecret(secureRandom),
            },
          },
          random: secureRandom,
          webSocketFactory: await createNodeWebSocketFactory(),
          handshakeTimeoutMs: 500,
        }),
      ).rejects.toThrow();

      await waitForPairingFailure(service);
      const status = await service.status();
      expect(status.connection.error).toBeUndefined();
      expect(status.pairing).toMatchObject({
        phase: "failed",
        error: expect.any(String),
      });
    } finally {
      await service.dispose();
      await cleanup();
    }
  });

  test("routes a failed authenticated handshake to its paired device", async () => {
    const { store, cleanup } = await makeFixture();
    const service = createService(store, new MemoryCredentials(), fakeAgentHostFactory());
    try {
      await service.configure(directConfiguration(await freePort()));
      const pairing = await service.startPairing();
      const invitation = parsePairingInvitation(pairing.invitation);
      await service.cancelPairing();

      const clientIdentity = await generateDeviceIdentity(secureRandom);
      await store.update((state) => ({
        ...state,
        peers: [
          {
            keyId: clientIdentity.keyId,
            publicKey: clientIdentity.publicKey,
            deviceId: "device-1",
            deviceName: "Existing iPhone",
            version: "1.0.0",
            scopeMode: "all",
            scopes: [ORBIS_REMOTE_SCOPES.connect],
            pairedAt: "2026-08-18T00:00:00.000Z",
          },
        ],
      }));

      await expect(
        OrbisRemoteConnection.connectEndpoint({
          websocketUrl: invitation.endpoint.url,
          hostId: invitation.hostId,
          peer: {
            deviceId: "device-1",
            deviceName: "Existing iPhone",
            role: "client",
            version: "1.0.0",
          },
          security: {
            mode: "authenticated",
            identity: clientIdentity,
            remotePublicKey: invitation.hostPublicKey,
          },
          random: secureRandom,
          webSocketFactory: tamperFirstFrame(await createNodeWebSocketFactory()),
          handshakeTimeoutMs: 500,
        }),
      ).rejects.toThrow();

      await waitForDeviceError(service, clientIdentity.keyId);
      const status = await service.status();
      expect(status.connection.error).toBeUndefined();
      expect(status.devices).toContainEqual(
        expect.objectContaining({
          keyId: clientIdentity.keyId,
          connected: false,
          error: expect.any(String),
        }),
      );
    } finally {
      await service.dispose();
      await cleanup();
    }
  });

  test("uses a fixed scope list only for explicitly custom pairing", async () => {
    const { store, cleanup } = await makeFixture();
    const service = createService(store, new MemoryCredentials(), fakeAgentHostFactory());
    try {
      await service.configure(directConfiguration(await freePort()));
      const pairing = await service.startPairing({
        mode: "custom",
        scopes: [ORBIS_REMOTE_SCOPES.connect, ORBIS_REMOTE_SCOPES.agentRead],
      });
      const invitation = parsePairingInvitation(pairing.invitation);
      expect(invitation.scopeMode).toBe("custom");
      expect(invitation.requestedScopes).toEqual([
        ORBIS_REMOTE_SCOPES.connect,
        ORBIS_REMOTE_SCOPES.agentRead,
      ]);
    } finally {
      await service.dispose();
      await cleanup();
    }
  });

  test("refuses configuration changes while pairing is active", async () => {
    const { store, cleanup } = await makeFixture();
    const port = await freePort();
    const service = createService(
      store,
      new MemoryCredentials(),
      fakeAgentHostFactory(),
      undefined,
      () => "pairing-1",
    );
    try {
      await service.configure(directConfiguration(port));
      await service.startPairing();
      await expect(
        service.configure({ ...directConfiguration(port), hostName: "Another host" }),
      ).rejects.toThrow(/pairing/u);
    } finally {
      await service.dispose();
      await cleanup();
    }
  });

  test("rejects a corrupt stored host identity without starting a connection", async () => {
    const { store, cleanup } = await makeFixture();
    const credentials = new MemoryCredentials();
    await credentials.set(ORBIS_DSH_IDENTITY_CREDENTIAL, "{not json");
    const service = createService(store, credentials, fakeAgentHostFactory());
    try {
      await service.configure(directConfiguration(47_000));
      await expect(service.startPairing()).rejects.toThrow(/corrupt/u);
    } finally {
      await cleanup();
    }
  });

  test("revokes a paired device and refuses unknown keys", async () => {
    const { store, cleanup } = await makeFixture();
    try {
      await store.update((state) => ({
        ...state,
        peers: [
          {
            keyId: "sha256:phone",
            publicKey: "phone-public-key",
            deviceId: "phone-1",
            version: "1.0.0",
            scopeMode: "custom",
            scopes: ["agent:read"],
            pairedAt: "2026-08-10T00:00:00.000Z",
          },
        ],
      }));
      const service = createService(store, new MemoryCredentials(), fakeAgentHostFactory());
      await service.revokeDevice("sha256:phone");
      expect((await store.load()).peers).toHaveLength(0);
      await expect(service.revokeDevice("sha256:missing")).rejects.toThrow(/no longer exists/u);
    } finally {
      await cleanup();
    }
  });

  test("rejects an invalid agent host returned by the factory", async () => {
    const { store, cleanup } = await makeFixture();
    const service = createService(store, new MemoryCredentials(), {
      create: async () => ({}) as never,
    });
    try {
      await service.configure(directConfiguration(47_000));
      await expect(service.connect()).rejects.toThrow(/invalid v2 host/u);
    } finally {
      await cleanup();
    }
  });
});
