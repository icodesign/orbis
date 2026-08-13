import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import {
  Dhkem,
  EMPTY,
  HkdfSha256Native,
  hmac,
  KemId,
  sha256,
  toArrayBuffer,
  type KdfInterface,
} from "@hpke/common";
import { CipherSuite } from "@hpke/core";
import { X25519 } from "@hpke/dhkem-x25519";

const HASH_SIZE = 32;
const MAX_HKDF_BLOCKS = 255;

/**
 * `@hpke/core` normally delegates HKDF to WebCrypto SubtleCrypto. React Native exposes secure
 * random bytes but not SubtleCrypto, so this adapter keeps the package's RFC 9180 state machine and
 * pure-JS X25519/ChaCha implementations while using its bundled SHA-256/HMAC primitives for HKDF.
 */
class PortableHkdfSha256 extends HkdfSha256Native {
  override async extract(
    salt: ArrayBufferLike | ArrayBufferView,
    ikm: ArrayBufferLike | ArrayBufferView,
  ): Promise<ArrayBuffer> {
    const saltBytes =
      salt.byteLength === 0 ? new Uint8Array(HASH_SIZE) : new Uint8Array(toArrayBuffer(salt));
    return toArrayBuffer(hmac(sha256, saltBytes, new Uint8Array(toArrayBuffer(ikm))));
  }

  override async expand(
    prk: ArrayBufferLike | ArrayBufferView,
    info: ArrayBufferLike | ArrayBufferView,
    length: number,
  ): Promise<ArrayBuffer> {
    if (!Number.isInteger(length) || length < 0 || length > MAX_HKDF_BLOCKS * HASH_SIZE) {
      throw new Error("Invalid HKDF output length");
    }

    const key = new Uint8Array(toArrayBuffer(prk));
    const context = new Uint8Array(toArrayBuffer(info));
    const output = new Uint8Array(length);
    let previous = EMPTY;
    let offset = 0;

    for (let block = 1; offset < length; block += 1) {
      const input = new Uint8Array(previous.byteLength + context.byteLength + 1);
      input.set(previous, 0);
      input.set(context, previous.byteLength);
      input[input.length - 1] = block;
      previous = hmac(sha256, key, input);

      const remaining = length - offset;
      const chunk = previous.subarray(0, Math.min(previous.byteLength, remaining));
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return output.buffer;
  }

  override async extractAndExpand(
    salt: ArrayBufferLike | ArrayBufferView,
    ikm: ArrayBufferLike | ArrayBufferView,
    info: ArrayBufferLike | ArrayBufferView,
    length: number,
  ): Promise<ArrayBuffer> {
    return this.expand(await this.extract(salt, ikm), info, length);
  }
}

class PortableDhkemX25519HkdfSha256 extends Dhkem {
  override readonly id = KemId.DhkemX25519HkdfSha256;
  override readonly secretSize = 32;
  override readonly encSize = 32;
  override readonly publicKeySize = 32;
  override readonly privateKeySize = 32;

  constructor() {
    const kdf: KdfInterface = new PortableHkdfSha256();
    super(KemId.DhkemX25519HkdfSha256, new X25519(kdf), kdf);
  }
}

export function createPortableHpkeSuite(): CipherSuite {
  return new CipherSuite({
    kem: new PortableDhkemX25519HkdfSha256(),
    kdf: new PortableHkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
}
