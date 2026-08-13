import { describe, expect, test } from "vitest";

import {
  activeHostEndpoints,
  hostEndpointManifestSchema,
  normalizeHostEndpointManifest,
} from "./endpoints";

const baseManifest = {
  hostId: "host-1",
  hostKeyId: "sha256:host-key",
  revision: 3,
};

describe("host endpoint manifests", () => {
  test("normalizes concurrent LAN, tailnet, tunnel, and relay endpoints", () => {
    expect(
      normalizeHostEndpointManifest({
        ...baseManifest,
        endpoints: [
          { kind: "lan", url: "ws://192.168.1.20:47000/orbis" },
          { kind: "tailnet", url: "ws://100.64.1.20:47000/orbis" },
          { kind: "tunnel", url: "wss://host.example.com/orbis" },
          { kind: "relay", url: "wss://relay.example.com/v1/hosts/host-1/connect" },
        ],
      }),
    ).toEqual({
      ...baseManifest,
      endpoints: [
        { kind: "lan", url: "ws://192.168.1.20:47000/orbis" },
        { kind: "tailnet", url: "ws://100.64.1.20:47000/orbis" },
        { kind: "tunnel", url: "wss://host.example.com/orbis" },
        { kind: "relay", url: "wss://relay.example.com/v1/hosts/host-1/connect" },
      ],
    });
  });

  test("rejects credentials, public cleartext, duplicate URLs, and insecure providers", () => {
    const invalidEndpointSets = [
      [{ kind: "lan", url: "ws://user:secret@192.168.1.20/orbis" }],
      [{ kind: "tailnet", url: "ws://public.example.com/orbis" }],
      [{ kind: "tunnel", url: "ws://192.168.1.20/orbis" }],
      [{ kind: "relay", url: "ws://100.64.1.20/orbis" }],
      [
        { kind: "lan", url: "ws://192.168.1.20/orbis" },
        { kind: "tailnet", url: "ws://192.168.1.20/orbis" },
      ],
    ];

    for (const endpoints of invalidEndpointSets) {
      expect(hostEndpointManifestSchema.safeParse({ ...baseManifest, endpoints }).success).toBe(
        false,
      );
    }
  });

  test("filters expired endpoints without mutating the authenticated manifest", () => {
    const manifest = normalizeHostEndpointManifest({
      ...baseManifest,
      endpoints: [
        {
          kind: "tunnel",
          url: "wss://old.example.com/orbis",
          expiresAt: "2026-08-12T00:00:00.000Z",
        },
        {
          kind: "relay",
          url: "wss://relay.example.com/v1/hosts/host-1/connect",
          expiresAt: "2026-08-13T00:00:00.000Z",
        },
      ],
    });

    expect(activeHostEndpoints(manifest, Date.parse("2026-08-12T12:00:00.000Z"))).toEqual([
      manifest.endpoints[1]!,
    ]);
    expect(manifest.endpoints).toHaveLength(2);
  });
});
