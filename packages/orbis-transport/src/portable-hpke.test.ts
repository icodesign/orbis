import { describe, expect, test } from "vitest";

import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";

import { createPortableHpkeSuite } from "./portable-hpke";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

describe("portable HPKE suite", () => {
  test("matches the official WebCrypto-backed RFC 9180 implementation", async () => {
    const portable = createPortableHpkeSuite();
    const native = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Chacha20Poly1305(),
    });
    const recipient = await portable.kem.deriveKeyPair(bytes(1));
    const sender = await portable.kem.deriveKeyPair(bytes(2));
    const ephemeral = await portable.kem.deriveKeyPair(bytes(3));
    const params = {
      recipientPublicKey: recipient.publicKey,
      senderKey: sender.privateKey,
      info: new TextEncoder().encode("orbis-hpke-test"),
      psk: {
        id: new TextEncoder().encode("pairing-test"),
        key: bytes(4),
      },
      ekm: ephemeral,
    };
    const plaintext = new TextEncoder().encode("authenticated payload");
    const aad = new TextEncoder().encode("frame metadata");

    const [portableContext, nativeContext] = await Promise.all([
      portable.createSenderContext(params),
      native.createSenderContext(params),
    ]);
    expect(new Uint8Array(portableContext.enc)).toEqual(new Uint8Array(nativeContext.enc));
    expect(new Uint8Array(await portableContext.seal(plaintext, aad))).toEqual(
      new Uint8Array(await nativeContext.seal(plaintext, aad)),
    );
  });
});
