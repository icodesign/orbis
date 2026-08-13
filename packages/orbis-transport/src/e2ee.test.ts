import { describe, expect, test } from "vitest";

import { sha256 } from "@hpke/common";

import {
  acceptSecureInitiatorHandshake,
  constantTimeEqualBase64Url,
  createPairingSecret,
  createSecureInitiatorHandshake,
  fingerprintPublicKey,
  generateDeviceIdentity,
  pairingSafetyNumber,
  pairingSecretVerifier,
  type SecureRandom,
} from "./e2ee";
import { OrbisTransportError } from "./errors";

function deterministicRandom(label: string): SecureRandom {
  let counter = 0;
  return async (length) => {
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const block = sha256(new TextEncoder().encode(`${label}:${counter++}`));
      const chunk = block.subarray(0, Math.min(block.length, length - offset));
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  };
}

async function identities() {
  return {
    client: await generateDeviceIdentity(deterministicRandom("client-identity")),
    host: await generateDeviceIdentity(deterministicRandom("host-identity")),
  };
}

describe("Orbis E2EE pairing handshake", () => {
  test("authenticates both identities and encrypts both message directions", async () => {
    const { client, host } = await identities();
    const secret = await createPairingSecret(deterministicRandom("pairing-secret"));
    const initiator = await createSecureInitiatorHandshake({
      security: {
        mode: "pairing",
        identity: client,
        remotePublicKey: host.publicKey,
        pairing: { pairingId: "pairing-1", secret },
      },
      random: deterministicRandom("client-ephemeral"),
      handshakeId: "handshake-pairing-1",
      hello: { peer: { deviceId: "phone-1" }, protocolVersion: 1 },
    });

    const serializedHello = JSON.stringify(initiator.frame);
    expect(serializedHello).not.toContain(secret);
    expect(serializedHello).not.toContain(client.privateKeySeed);
    expect(serializedHello).not.toContain("phone-1");
    expect(initiator.frame.senderPublicKey).toBe(client.publicKey);

    const responder = await acceptSecureInitiatorHandshake(initiator.frame, {
      identity: host,
      random: deterministicRandom("host-ephemeral"),
      resolvePeer: async (frame) => {
        expect(frame.pairingId).toBe("pairing-1");
        return { publicKey: client.publicKey, pairingSecret: secret };
      },
    });
    expect(responder.hello).toEqual({
      peer: { deviceId: "phone-1" },
      protocolVersion: 1,
    });

    const response = await responder.respond({ connectionId: "connection-1", methods: ["prompt"] });
    expect(JSON.stringify(response.frame)).not.toContain("connection-1");
    const finished = await initiator.finish(response.frame);
    expect(finished.welcome).toEqual({ connectionId: "connection-1", methods: ["prompt"] });
    expect(finished.channel.remoteKeyId).toBe(fingerprintPublicKey(host.publicKey));

    const request = await finished.channel.seal({ method: "prompt", text: "private prompt" });
    expect(JSON.stringify(request)).not.toContain("private prompt");
    expect(await response.channel.open(request)).toEqual({
      method: "prompt",
      text: "private prompt",
    });

    const event = await response.channel.seal({ type: "assistant.delta", text: "secret reply" });
    expect(await finished.channel.open(event)).toEqual({
      type: "assistant.delta",
      text: "secret reply",
    });
  });

  test("rejects a wrong pairing secret without retaining it in the error", async () => {
    const { client, host } = await identities();
    const secret = await createPairingSecret(deterministicRandom("correct-secret"));
    const wrongSecret = await createPairingSecret(deterministicRandom("wrong-secret"));
    const initiator = await createSecureInitiatorHandshake({
      security: {
        mode: "pairing",
        identity: client,
        remotePublicKey: host.publicKey,
        pairing: { pairingId: "pairing-1", secret },
      },
      random: deterministicRandom("client-ephemeral"),
      handshakeId: "handshake-pairing-2",
      hello: { private: "payload" },
    });

    await expect(
      acceptSecureInitiatorHandshake(initiator.frame, {
        identity: host,
        random: deterministicRandom("host-ephemeral"),
        resolvePeer: async () => ({ publicKey: client.publicKey, pairingSecret: wrongSecret }),
      }),
    ).rejects.toMatchObject({ code: "authentication" });

    try {
      await acceptSecureInitiatorHandshake(initiator.frame, {
        identity: host,
        random: deterministicRandom("host-ephemeral"),
        resolvePeer: async () => ({ publicKey: client.publicKey, pairingSecret: wrongSecret }),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(OrbisTransportError);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(wrongSecret);
    }
  });

  test("rejects replay, out-of-order, and tampered secure frames", async () => {
    const { client, host } = await identities();
    const initiator = await createSecureInitiatorHandshake({
      security: { mode: "authenticated", identity: client, remotePublicKey: host.publicKey },
      random: deterministicRandom("client-auth-ephemeral"),
      handshakeId: "handshake-authenticated-1",
      hello: { deviceId: "phone-1" },
    });
    expect(initiator.frame.senderPublicKey).toBeUndefined();
    expect(initiator.frame.pairingId).toBeUndefined();

    const responder = await acceptSecureInitiatorHandshake(initiator.frame, {
      identity: host,
      random: deterministicRandom("host-auth-ephemeral"),
      resolvePeer: async () => ({ publicKey: client.publicKey }),
    });
    const response = await responder.respond({ ok: true });
    const finished = await initiator.finish(response.frame);
    const first = await finished.channel.seal({ index: 1 });
    expect(await response.channel.open(first)).toEqual({ index: 1 });

    await expect(response.channel.open(first)).rejects.toMatchObject({ code: "authentication" });

    const second = await finished.channel.seal({ index: 2 });
    await expect(
      response.channel.open({ ...second, sequence: second.sequence + 1 }),
    ).rejects.toMatchObject({ code: "authentication" });

    const tampered = `${second.ciphertext.slice(0, -1)}${second.ciphertext.endsWith("A") ? "B" : "A"}`;
    await expect(response.channel.open({ ...second, ciphertext: tampered })).rejects.toMatchObject({
      code: "authentication",
    });
  });

  test("rejects an oversized frame before advancing the encrypted sequence", async () => {
    const { client, host } = await identities();
    const initiator = await createSecureInitiatorHandshake({
      security: { mode: "authenticated", identity: client, remotePublicKey: host.publicKey },
      random: deterministicRandom("client-size-ephemeral"),
      handshakeId: "handshake-size-budget-1",
      hello: { deviceId: "phone-1" },
    });
    const responder = await acceptSecureInitiatorHandshake(initiator.frame, {
      identity: host,
      random: deterministicRandom("host-size-ephemeral"),
      resolvePeer: async () => ({ publicKey: client.publicKey }),
    });
    const response = await responder.respond({ ok: true });
    const finished = await initiator.finish(response.frame);

    let oversizedError: unknown;
    try {
      await response.channel.seal({ text: "x".repeat(1_024) }, { maxEnvelopeBytes: 512 });
    } catch (error) {
      oversizedError = error;
    }
    expect(oversizedError).toMatchObject({
      code: "invalid_argument",
      serverCode: "frame_too_large",
    });

    const firstSentFrame = await response.channel.seal({ ok: true }, { maxEnvelopeBytes: 512 });
    expect(firstSentFrame.sequence).toBe(1);
    expect(await finished.channel.open(firstSentFrame)).toEqual({ ok: true });
  });
});

describe("Orbis pairing fingerprints", () => {
  test("creates stable safety numbers and keyed pairing verifiers", async () => {
    const { client, host } = await identities();
    const secret = await createPairingSecret(deterministicRandom("secret"));
    expect(pairingSafetyNumber(client.publicKey, host.publicKey)).toMatch(/^\d{4} \d{4} \d{4}$/u);
    expect(pairingSafetyNumber(client.publicKey, host.publicKey)).not.toBe(
      pairingSafetyNumber(host.publicKey, client.publicKey),
    );

    const verifier = pairingSecretVerifier("pairing-1", secret);
    expect(constantTimeEqualBase64Url(verifier, verifier)).toBe(true);
    expect(constantTimeEqualBase64Url(verifier, pairingSecretVerifier("pairing-2", secret))).toBe(
      false,
    );
    expect(constantTimeEqualBase64Url("not base64", verifier)).toBe(false);
  });
});
