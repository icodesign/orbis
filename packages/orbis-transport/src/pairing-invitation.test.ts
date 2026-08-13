import { describe, expect, test } from "vitest";

import { sha256 } from "@hpke/common";

import {
  createPairingSecret,
  fingerprintPublicKey,
  generateDeviceIdentity,
  ORBIS_E2EE_PROTOCOL_VERSION,
  ORBIS_E2EE_SUITE,
} from "./e2ee";
import { parsePairingInvitation, serializePairingInvitation } from "./pairing-invitation";

const NOW = Date.parse("2026-08-09T00:00:00.000Z");

async function fixture() {
  let counter = 0;
  const random = async (length: number) => {
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const block = sha256(new TextEncoder().encode(`invitation:${counter++}`));
      const chunk = block.subarray(0, Math.min(block.length, length - offset));
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  };
  const host = await generateDeviceIdentity(random);
  return {
    invitation: {
      version: ORBIS_E2EE_PROTOCOL_VERSION,
      endpoint: { kind: "tunnel" as const, url: "wss://remote.example/orbis" },
      pairingId: "pairing-1",
      pairingSecret: await createPairingSecret(random),
      hostId: "host-1",
      hostName: "Lance's MacBook",
      hostPublicKey: host.publicKey,
      hostKeyId: fingerprintPublicKey(host.publicKey),
      scopeMode: "all" as const,
      requestedScopes: ["host:connect", "agent:read", "agent:write"],
      expiresAt: "2026-08-09T00:05:00.000Z",
      suite: ORBIS_E2EE_SUITE,
    },
  };
}

describe("pairing invitation", () => {
  test("round-trips a single bootstrap endpoint", async () => {
    const { invitation } = await fixture();
    const encoded = serializePairingInvitation(invitation, { now: NOW });
    expect(encoded.startsWith("orbis://pair?")).toBe(true);
    expect(parsePairingInvitation(encoded, { now: NOW })).toEqual(invitation);
  });

  test("supports LAN, tailnet, tunnel, and relay bootstrap endpoints", async () => {
    const { invitation } = await fixture();
    const endpoints = [
      { kind: "lan" as const, url: "ws://192.168.50.10:47000/orbis" },
      { kind: "tailnet" as const, url: "ws://100.64.0.10:47000/orbis" },
      { kind: "tunnel" as const, url: "wss://host.example.com/orbis" },
      { kind: "relay" as const, url: "wss://relay.example.com/v1/hosts/host-1/connect" },
    ];

    for (const endpoint of endpoints) {
      const value = { ...invitation, endpoint };
      expect(
        parsePairingInvitation(serializePairingInvitation(value, { now: NOW }), { now: NOW }),
      ).toEqual(value);
    }
  });

  test("rejects expired, insecure, duplicated, and fingerprint-tampered invitations", async () => {
    const { invitation } = await fixture();

    expect(() =>
      serializePairingInvitation(
        { ...invitation, expiresAt: new Date(NOW).toISOString() },
        { now: NOW },
      ),
    ).toThrow(/expired/u);
    expect(() =>
      serializePairingInvitation(
        {
          ...invitation,
          endpoint: { kind: "tunnel", url: "ws://192.168.50.10/orbis" },
        },
        { now: NOW },
      ),
    ).toThrow();
    expect(() =>
      serializePairingInvitation(
        {
          ...invitation,
          endpoint: { kind: "lan", url: "ws://remote.example/orbis" },
        },
        { now: NOW },
      ),
    ).toThrow();
    expect(() =>
      serializePairingInvitation({ ...invitation, hostKeyId: "sha256:wrong" }, { now: NOW }),
    ).toThrow(/fingerprint/u);

    const encoded = serializePairingInvitation(invitation, { now: NOW });
    expect(() => parsePairingInvitation(`${encoded}&secret=duplicate`, { now: NOW })).toThrow(
      /duplicated/u,
    );
    expect(() => parsePairingInvitation(`${encoded}&unknown=value`, { now: NOW })).toThrow(
      /unsupported/u,
    );
  });
});
