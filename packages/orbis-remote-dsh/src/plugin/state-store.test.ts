import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { OrbisDshStateStore } from "./state-store";

describe("OrbisDshStateStore", () => {
  test("persists the v2 host state atomically with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-dsh-state-"));
    const path = join(directory, "orbis", "host.json");
    const store = new OrbisDshStateStore(path, () => "host-1");

    expect(await store.load()).toEqual({
      version: 2,
      hostId: "host-1",
      endpointRevision: 0,
      peers: [],
    });
    const updated = await store.update((state) => ({
      ...state,
      hostName: "MacBook",
      directPort: 47_000,
      endpointRevision: 1,
      peers: [
        {
          keyId: "sha256:client",
          publicKey: "client-public-key",
          deviceId: "phone-1",
          deviceName: "Lance's iPhone",
          version: "1.0.0",
          scopeMode: "all",
          scopes: ["host:connect"],
          pairedAt: "2026-08-10T00:00:00.000Z",
        },
      ],
    }));

    expect(updated.peers).toHaveLength(1);
    const reloaded = new OrbisDshStateStore(path);
    expect(await reloaded.load()).toMatchObject({
      version: 2,
      hostName: "MacBook",
      directPort: 47_000,
      endpointRevision: 1,
    });
    expect((await reloaded.load()).peers[0]?.deviceName).toBe("Lance's iPhone");
  });

  test("treats peers saved before permission modes existed as all-permission defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-dsh-state-"));
    const stateDirectory = join(directory, "orbis");
    const path = join(stateDirectory, "host.json");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        hostId: "host-1",
        endpointRevision: 0,
        peers: [
          {
            keyId: "sha256:client",
            publicKey: "client-public-key",
            deviceId: "phone-1",
            version: "1.0.0",
            scopes: ["host:connect", "agent:read", "agent:write"],
            pairedAt: "2026-08-10T00:00:00.000Z",
          },
        ],
      }),
      { mode: 0o600 },
    );

    expect((await new OrbisDshStateStore(path).load()).peers[0]?.scopeMode).toBe("all");
  });

  test("rejects obsolete state versions instead of hiding an incomplete migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-dsh-state-"));
    const stateDirectory = join(directory, "orbis");
    const path = join(stateDirectory, "host.json");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, hostId: "host-1", peers: [] }), {
      mode: 0o600,
    });

    await expect(new OrbisDshStateStore(path).load()).rejects.toThrow(/unsupported or corrupt/u);
  });

  test("refuses an existing state file that is readable by other users", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-dsh-state-"));
    const stateDirectory = join(directory, "orbis");
    const path = join(stateDirectory, "host.json");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        hostId: "host-1",
        endpointRevision: 0,
        peers: [],
      }),
    );
    await chmod(path, 0o644);

    await expect(new OrbisDshStateStore(path).load()).rejects.toThrow(/must not be readable/u);
  });
});
