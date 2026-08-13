import { hmac, sha256 } from "@hpke/common";
import type { RecipientContext, SenderContext } from "@hpke/core";
import { z } from "zod";

import { base64UrlToBytes, bytesToBase64Url, toOwnedArrayBuffer } from "./encoding";
import { OrbisTransportError } from "./errors";
import { createPortableHpkeSuite } from "./portable-hpke";
import { jsonValueSchema, type JsonValue } from "./protocol";

export const ORBIS_E2EE_PROTOCOL_VERSION = 1 as const;
export const ORBIS_E2EE_SUITE =
  "HPKE-v1-DHKEM(X25519,HKDF-SHA256)-HKDF-SHA256-ChaCha20Poly1305" as const;

const KEY_BYTES = 32;
const PSK_BYTES = 32;
const AEAD_TAG_BYTES = 16;
const MAX_HANDSHAKE_ID_LENGTH = 128;
const MAX_MESSAGE_SEQUENCE = Number.MAX_SAFE_INTEGER;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const identifierSchema = z.string().min(1).max(256);
const keyIdSchema = z.string().startsWith("sha256:").max(128);
const encodedKeySchema = z.string().min(43).max(43);
const encodedCiphertextSchema = z
  .string()
  .min(1)
  .max(64 * 1024 * 1024);

export type SecureRandom = (length: number) => Promise<Uint8Array>;

export interface SerializedDeviceIdentity {
  suite: typeof ORBIS_E2EE_SUITE;
  keyId: string;
  publicKey: string;
  privateKeySeed: string;
}

export const serializedDeviceIdentitySchema: z.ZodType<SerializedDeviceIdentity> = z
  .object({
    suite: z.literal(ORBIS_E2EE_SUITE),
    keyId: keyIdSchema,
    publicKey: encodedKeySchema,
    privateKeySeed: encodedKeySchema,
  })
  .strict();

export const secureHelloEnvelopeSchema = z
  .object({
    kind: z.literal("secure_hello"),
    e2eeVersion: z.literal(ORBIS_E2EE_PROTOCOL_VERSION),
    suite: z.literal(ORBIS_E2EE_SUITE),
    handshakeId: z.string().min(16).max(MAX_HANDSHAKE_ID_LENGTH),
    mode: z.enum(["authenticated", "pairing"]),
    senderKeyId: keyIdSchema,
    senderPublicKey: encodedKeySchema.optional(),
    recipientKeyId: keyIdSchema,
    pairingId: identifierSchema.optional(),
    encapsulatedKey: encodedKeySchema,
    sequence: z.literal(0),
    ciphertext: encodedCiphertextSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const pairingFieldsPresent =
      value.pairingId !== undefined && value.senderPublicKey !== undefined;
    if (value.mode === "pairing" && !pairingFieldsPresent) {
      context.addIssue({ code: "custom", message: "Pairing metadata is required" });
    }
    if (value.mode === "authenticated" && (value.pairingId || value.senderPublicKey)) {
      context.addIssue({ code: "custom", message: "Pairing metadata is not allowed" });
    }
  });

export const secureWelcomeEnvelopeSchema = z
  .object({
    kind: z.literal("secure_welcome"),
    e2eeVersion: z.literal(ORBIS_E2EE_PROTOCOL_VERSION),
    suite: z.literal(ORBIS_E2EE_SUITE),
    handshakeId: z.string().min(16).max(MAX_HANDSHAKE_ID_LENGTH),
    mode: z.enum(["authenticated", "pairing"]),
    senderKeyId: keyIdSchema,
    recipientKeyId: keyIdSchema,
    encapsulatedKey: encodedKeySchema,
    sequence: z.literal(0),
    ciphertext: encodedCiphertextSchema,
  })
  .strict();

export const secureMessageEnvelopeSchema = z
  .object({
    kind: z.literal("secure_message"),
    e2eeVersion: z.literal(ORBIS_E2EE_PROTOCOL_VERSION),
    handshakeId: z.string().min(16).max(MAX_HANDSHAKE_ID_LENGTH),
    sequence: z.number().int().nonnegative().safe(),
    ciphertext: encodedCiphertextSchema,
  })
  .strict();

export type SecureHelloEnvelope = z.infer<typeof secureHelloEnvelopeSchema>;
export type SecureWelcomeEnvelope = z.infer<typeof secureWelcomeEnvelopeSchema>;
export type SecureMessageEnvelope = z.infer<typeof secureMessageEnvelopeSchema>;
export type OrbisE2eeHandshakeMode = SecureHelloEnvelope["mode"];

export interface PairingHandshakeCredentials {
  pairingId: string;
  secret: string;
}

export type InitiatorSecurity =
  | {
      mode: "authenticated";
      identity: SerializedDeviceIdentity;
      remotePublicKey: string;
    }
  | {
      mode: "pairing";
      identity: SerializedDeviceIdentity;
      remotePublicKey: string;
      pairing: PairingHandshakeCredentials;
    };

export interface SecureInitiatorOptions {
  security: InitiatorSecurity;
  random: SecureRandom;
  handshakeId?: string;
  hello: JsonValue;
}

export interface SecureResponderPeer {
  publicKey: string;
  pairingSecret?: string;
}

export interface SecureResponderOptions {
  identity: SerializedDeviceIdentity;
  random: SecureRandom;
  resolvePeer(frame: SecureHelloEnvelope): Promise<SecureResponderPeer>;
}

interface ImportedIdentity {
  keyId: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

function cryptoFailure(message: string): OrbisTransportError {
  return new OrbisTransportError("authentication", message);
}

function validateRandomBytes(bytes: Uint8Array, length: number): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
    throw new OrbisTransportError(
      "invalid_argument",
      `Secure random source must return exactly ${length} bytes`,
    );
  }
  return bytes.slice();
}

async function randomBytes(random: SecureRandom, length: number): Promise<Uint8Array> {
  return validateRandomBytes(await random(length), length);
}

function keyIdFromBytes(publicKey: Uint8Array): string {
  return `sha256:${bytesToBase64Url(sha256(publicKey))}`;
}

export function fingerprintPublicKey(publicKey: string): string {
  return keyIdFromBytes(base64UrlToBytes(publicKey, "Public key", KEY_BYTES));
}

export function pairingSafetyNumber(clientPublicKey: string, hostPublicKey: string): string {
  const transcript = new Uint8Array(
    textEncoder.encode("orbis-pairing-safety-number-v1").byteLength + KEY_BYTES * 2,
  );
  let offset = 0;
  const label = textEncoder.encode("orbis-pairing-safety-number-v1");
  transcript.set(label, offset);
  offset += label.byteLength;
  transcript.set(base64UrlToBytes(clientPublicKey, "Client public key", KEY_BYTES), offset);
  offset += KEY_BYTES;
  transcript.set(base64UrlToBytes(hostPublicKey, "Host public key", KEY_BYTES), offset);

  const digest = sha256(transcript);
  let number = 0n;
  for (const byte of digest.subarray(0, 5)) {
    number = (number << 8n) | BigInt(byte);
  }
  const digits = (number % 1_000_000_000_000n).toString().padStart(12, "0");
  return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}`;
}

async function deriveKeyPair(seed: Uint8Array): Promise<CryptoKeyPair> {
  const suite = createPortableHpkeSuite();
  return suite.kem.deriveKeyPair(seed);
}

export async function generateDeviceIdentity(
  random: SecureRandom,
): Promise<SerializedDeviceIdentity> {
  const suite = createPortableHpkeSuite();
  const privateKeySeed = await randomBytes(random, KEY_BYTES);
  const keyPair = await suite.kem.deriveKeyPair(privateKeySeed);
  const publicKey = new Uint8Array(await suite.kem.serializePublicKey(keyPair.publicKey));

  return {
    suite: ORBIS_E2EE_SUITE,
    keyId: keyIdFromBytes(publicKey),
    publicKey: bytesToBase64Url(publicKey),
    privateKeySeed: bytesToBase64Url(privateKeySeed),
  };
}

async function importIdentity(input: SerializedDeviceIdentity): Promise<ImportedIdentity> {
  const identity = serializedDeviceIdentitySchema.parse(input);
  const suite = createPortableHpkeSuite();
  const publicKeyBytes = base64UrlToBytes(identity.publicKey, "Identity public key", KEY_BYTES);
  if (keyIdFromBytes(publicKeyBytes) !== identity.keyId) {
    throw cryptoFailure("The device identity fingerprint does not match its public key");
  }

  try {
    const derived = await deriveKeyPair(
      base64UrlToBytes(identity.privateKeySeed, "Identity private key seed", KEY_BYTES),
    );
    const derivedPublic = new Uint8Array(await suite.kem.serializePublicKey(derived.publicKey));
    if (keyIdFromBytes(derivedPublic) !== identity.keyId) {
      throw cryptoFailure("The device identity private key does not match its public key");
    }
    return { keyId: identity.keyId, publicKey: derived.publicKey, privateKey: derived.privateKey };
  } catch (error) {
    if (error instanceof OrbisTransportError) {
      throw error;
    }
    throw cryptoFailure("The device identity could not be imported");
  }
}

async function importPublicKey(value: string, label: string): Promise<CryptoKey> {
  try {
    return await createPortableHpkeSuite().kem.deserializePublicKey(
      base64UrlToBytes(value, label, KEY_BYTES),
    );
  } catch (error) {
    if (error instanceof OrbisTransportError) {
      throw error;
    }
    throw cryptoFailure(`${label} could not be imported`);
  }
}

function pairingPsk(pairing: PairingHandshakeCredentials): {
  id: Uint8Array;
  key: Uint8Array;
} {
  const pairingId = identifierSchema.parse(pairing.pairingId);
  const secret = base64UrlToBytes(pairing.secret, "Pairing secret", PSK_BYTES);
  return {
    id: sha256(textEncoder.encode(`orbis-pairing-v1:${pairingId}`)),
    key: secret,
  };
}

function info(direction: "client-to-host" | "host-to-client"): Uint8Array {
  return textEncoder.encode(`orbis-e2ee-v1:${direction}`);
}

function helloAad(frame: Omit<SecureHelloEnvelope, "ciphertext">): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({
      kind: frame.kind,
      e2eeVersion: frame.e2eeVersion,
      suite: frame.suite,
      handshakeId: frame.handshakeId,
      mode: frame.mode,
      senderKeyId: frame.senderKeyId,
      senderPublicKey: frame.senderPublicKey,
      recipientKeyId: frame.recipientKeyId,
      pairingId: frame.pairingId,
      encapsulatedKey: frame.encapsulatedKey,
      sequence: frame.sequence,
    }),
  );
}

function welcomeAad(frame: Omit<SecureWelcomeEnvelope, "ciphertext">): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({
      kind: frame.kind,
      e2eeVersion: frame.e2eeVersion,
      suite: frame.suite,
      handshakeId: frame.handshakeId,
      mode: frame.mode,
      senderKeyId: frame.senderKeyId,
      recipientKeyId: frame.recipientKeyId,
      encapsulatedKey: frame.encapsulatedKey,
      sequence: frame.sequence,
    }),
  );
}

function messageAad(frame: Omit<SecureMessageEnvelope, "ciphertext">): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({
      kind: frame.kind,
      e2eeVersion: frame.e2eeVersion,
      handshakeId: frame.handshakeId,
      sequence: frame.sequence,
    }),
  );
}

function encodeJson(value: JsonValue): Uint8Array {
  return textEncoder.encode(JSON.stringify(jsonValueSchema.parse(value)));
}

function decodeJson(value: ArrayBuffer): JsonValue {
  try {
    return jsonValueSchema.parse(JSON.parse(textDecoder.decode(value)));
  } catch {
    throw new OrbisTransportError("protocol", "The encrypted payload was not valid JSON");
  }
}

function base64UrlLength(byteLength: number): number {
  return Math.ceil((byteLength * 4) / 3);
}

function secureMessageEnvelopeByteLength(
  handshakeId: string,
  sequence: number,
  plaintextByteLength: number,
): number {
  const emptyCiphertextEnvelope = JSON.stringify({
    kind: "secure_message",
    e2eeVersion: ORBIS_E2EE_PROTOCOL_VERSION,
    handshakeId,
    sequence,
    ciphertext: "",
  });
  return (
    textEncoder.encode(emptyCiphertextEnvelope).byteLength +
    base64UrlLength(plaintextByteLength + AEAD_TAG_BYTES)
  );
}

function maximumSecureMessagePlaintextBytes(handshakeId: string, maxEnvelopeBytes: number): number {
  if (!Number.isSafeInteger(maxEnvelopeBytes) || maxEnvelopeBytes < 0) {
    throw new OrbisTransportError(
      "invalid_argument",
      "Encrypted frame byte limit must be a non-negative safe integer",
    );
  }

  let lower = 0;
  let upper = maxEnvelopeBytes;
  let result = -1;
  while (lower <= upper) {
    const candidate = Math.floor((lower + upper) / 2);
    if (
      secureMessageEnvelopeByteLength(handshakeId, MAX_MESSAGE_SEQUENCE, candidate) <=
      maxEnvelopeBytes
    ) {
      result = candidate;
      lower = candidate + 1;
    } else {
      upper = candidate - 1;
    }
  }
  return Math.max(0, result);
}

async function ephemeralKeyPair(random: SecureRandom): Promise<CryptoKeyPair> {
  return deriveKeyPair(await randomBytes(random, KEY_BYTES));
}

export class OrbisSecureChannel {
  private sendSequence = 1;
  private receiveSequence = 1;
  private sendTail: Promise<unknown> = Promise.resolve();
  private receiveTail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly handshakeId: string,
    readonly localKeyId: string,
    readonly remoteKeyId: string,
    private readonly sender: SenderContext,
    private readonly recipient: RecipientContext,
  ) {}

  /**
   * Returns a conservative plaintext JSON budget for a complete encrypted
   * envelope. The largest valid sequence is reserved so the budget remains
   * safe for the lifetime of this channel.
   */
  maxPlaintextBytes(maxEnvelopeBytes: number): number {
    return maximumSecureMessagePlaintextBytes(this.handshakeId, maxEnvelopeBytes);
  }

  seal(
    value: JsonValue,
    options: { readonly maxEnvelopeBytes?: number } = {},
  ): Promise<SecureMessageEnvelope> {
    const operation = this.sendTail.then(async () => {
      const metadata = {
        kind: "secure_message" as const,
        e2eeVersion: ORBIS_E2EE_PROTOCOL_VERSION,
        handshakeId: this.handshakeId,
        sequence: this.sendSequence,
      };
      const plaintext = encodeJson(value);
      if (
        options.maxEnvelopeBytes !== undefined &&
        (!Number.isSafeInteger(options.maxEnvelopeBytes) || options.maxEnvelopeBytes < 0)
      ) {
        throw new OrbisTransportError(
          "invalid_argument",
          "Encrypted frame byte limit must be a non-negative safe integer",
        );
      }
      if (
        options.maxEnvelopeBytes !== undefined &&
        secureMessageEnvelopeByteLength(
          metadata.handshakeId,
          metadata.sequence,
          plaintext.byteLength,
        ) > options.maxEnvelopeBytes
      ) {
        throw new OrbisTransportError(
          "invalid_argument",
          "The encrypted frame exceeds the size limit",
          { serverCode: "frame_too_large" },
        );
      }
      try {
        const ciphertext = await this.sender.seal(plaintext, messageAad(metadata));
        this.sendSequence += 1;
        return { ...metadata, ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)) };
      } catch {
        throw cryptoFailure("The encrypted frame could not be sealed");
      }
    });
    this.sendTail = operation.catch(() => undefined);
    return operation;
  }

  open(input: SecureMessageEnvelope): Promise<JsonValue> {
    const operation = this.receiveTail.then(async () => {
      const frame = secureMessageEnvelopeSchema.parse(input);
      if (frame.handshakeId !== this.handshakeId || frame.sequence !== this.receiveSequence) {
        throw cryptoFailure("The encrypted frame sequence is invalid");
      }
      const { ciphertext, ...metadata } = frame;
      try {
        const plaintext = await this.recipient.open(
          base64UrlToBytes(ciphertext, "Encrypted frame"),
          messageAad(metadata),
        );
        this.receiveSequence += 1;
        return decodeJson(plaintext);
      } catch (error) {
        if (error instanceof OrbisTransportError) {
          throw error;
        }
        throw cryptoFailure("The encrypted frame could not be authenticated");
      }
    });
    this.receiveTail = operation.catch(() => undefined);
    return operation;
  }
}

export interface SecureInitiatorHandshake {
  frame: SecureHelloEnvelope;
  finish(
    input: SecureWelcomeEnvelope,
  ): Promise<{ channel: OrbisSecureChannel; welcome: JsonValue }>;
}

export async function createSecureInitiatorHandshake(
  options: SecureInitiatorOptions,
): Promise<SecureInitiatorHandshake> {
  const local = await importIdentity(options.security.identity);
  const remotePublicKey = await importPublicKey(
    options.security.remotePublicKey,
    "Host public key",
  );
  const remoteKeyId = fingerprintPublicKey(options.security.remotePublicKey);
  const handshakeId =
    options.handshakeId ?? bytesToBase64Url(await randomBytes(options.random, 18));
  if (handshakeId.length < 16 || handshakeId.length > MAX_HANDSHAKE_ID_LENGTH) {
    throw new OrbisTransportError("invalid_argument", "Handshake id is invalid");
  }

  const pairing = options.security.mode === "pairing" ? options.security.pairing : undefined;
  const psk = pairing ? pairingPsk(pairing) : undefined;
  const suite = createPortableHpkeSuite();
  let sender: SenderContext;
  try {
    sender = await suite.createSenderContext({
      recipientPublicKey: remotePublicKey,
      senderKey: local.privateKey,
      info: info("client-to-host"),
      psk,
      ekm: await ephemeralKeyPair(options.random),
    });
  } catch {
    throw cryptoFailure("The encrypted handshake could not be created");
  }

  const metadata: Omit<SecureHelloEnvelope, "ciphertext"> = {
    kind: "secure_hello",
    e2eeVersion: ORBIS_E2EE_PROTOCOL_VERSION,
    suite: ORBIS_E2EE_SUITE,
    handshakeId,
    mode: options.security.mode,
    senderKeyId: local.keyId,
    ...(pairing
      ? { senderPublicKey: options.security.identity.publicKey, pairingId: pairing.pairingId }
      : {}),
    recipientKeyId: remoteKeyId,
    encapsulatedKey: bytesToBase64Url(new Uint8Array(sender.enc)),
    sequence: 0,
  };
  const ciphertext = await sender.seal(encodeJson(options.hello), helloAad(metadata));
  const frame = secureHelloEnvelopeSchema.parse({
    ...metadata,
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  });

  return {
    frame,
    finish: async (input) => {
      const welcomeFrame = secureWelcomeEnvelopeSchema.parse(input);
      if (
        welcomeFrame.handshakeId !== handshakeId ||
        welcomeFrame.mode !== options.security.mode ||
        welcomeFrame.senderKeyId !== remoteKeyId ||
        welcomeFrame.recipientKeyId !== local.keyId
      ) {
        throw cryptoFailure("The encrypted welcome did not match the handshake");
      }

      const { ciphertext: welcomeCiphertext, ...welcomeMetadata } = welcomeFrame;
      try {
        const recipient = await createPortableHpkeSuite().createRecipientContext({
          recipientKey: local.privateKey,
          senderPublicKey: remotePublicKey,
          enc: base64UrlToBytes(welcomeFrame.encapsulatedKey, "Encapsulated host key", KEY_BYTES),
          info: info("host-to-client"),
          psk,
        });
        const plaintext = await recipient.open(
          base64UrlToBytes(welcomeCiphertext, "Encrypted welcome"),
          welcomeAad(welcomeMetadata),
        );
        return {
          channel: new OrbisSecureChannel(handshakeId, local.keyId, remoteKeyId, sender, recipient),
          welcome: decodeJson(plaintext),
        };
      } catch (error) {
        if (error instanceof OrbisTransportError) {
          throw error;
        }
        throw cryptoFailure("The encrypted welcome could not be authenticated");
      }
    },
  };
}

export interface SecureResponderHandshake {
  hello: JsonValue;
  mode: OrbisE2eeHandshakeMode;
  peerKeyId: string;
  peerPublicKey: string;
  pairingId?: string;
  respond(
    welcome: JsonValue,
  ): Promise<{ channel: OrbisSecureChannel; frame: SecureWelcomeEnvelope }>;
}

export async function acceptSecureInitiatorHandshake(
  input: SecureHelloEnvelope,
  options: SecureResponderOptions,
): Promise<SecureResponderHandshake> {
  const frame = secureHelloEnvelopeSchema.parse(input);
  const local = await importIdentity(options.identity);
  if (frame.recipientKeyId !== local.keyId) {
    throw cryptoFailure("The encrypted hello targeted a different host key");
  }

  const peer = await options.resolvePeer(frame);
  const peerPublicKeyValue =
    frame.mode === "pairing" ? (frame.senderPublicKey as string) : peer.publicKey;
  if (
    fingerprintPublicKey(peerPublicKeyValue) !== frame.senderKeyId ||
    (peer.publicKey && peer.publicKey !== peerPublicKeyValue)
  ) {
    throw cryptoFailure("The peer identity did not match the encrypted hello");
  }

  const pairing =
    frame.mode === "pairing"
      ? {
          pairingId: frame.pairingId as string,
          secret: peer.pairingSecret ?? "",
        }
      : undefined;
  if (frame.mode === "pairing" && !peer.pairingSecret) {
    throw cryptoFailure("The pairing secret is unavailable");
  }
  if (frame.mode === "authenticated" && peer.pairingSecret) {
    throw cryptoFailure("Pairing credentials are not allowed for an authenticated handshake");
  }

  const peerPublicKey = await importPublicKey(peerPublicKeyValue, "Peer public key");
  const psk = pairing ? pairingPsk(pairing) : undefined;
  const { ciphertext, ...metadata } = frame;
  let recipient: RecipientContext;
  let hello: JsonValue;
  try {
    recipient = await createPortableHpkeSuite().createRecipientContext({
      recipientKey: local.privateKey,
      senderPublicKey: peerPublicKey,
      enc: base64UrlToBytes(frame.encapsulatedKey, "Encapsulated client key", KEY_BYTES),
      info: info("client-to-host"),
      psk,
    });
    hello = decodeJson(
      await recipient.open(base64UrlToBytes(ciphertext, "Encrypted hello"), helloAad(metadata)),
    );
  } catch (error) {
    if (error instanceof OrbisTransportError) {
      throw error;
    }
    throw cryptoFailure("The encrypted hello could not be authenticated");
  }

  return {
    hello,
    mode: frame.mode,
    peerKeyId: frame.senderKeyId,
    peerPublicKey: peerPublicKeyValue,
    pairingId: frame.pairingId,
    respond: async (welcome) => {
      let sender: SenderContext;
      try {
        sender = await createPortableHpkeSuite().createSenderContext({
          recipientPublicKey: peerPublicKey,
          senderKey: local.privateKey,
          info: info("host-to-client"),
          psk,
          ekm: await ephemeralKeyPair(options.random),
        });
      } catch {
        throw cryptoFailure("The encrypted welcome could not be created");
      }

      const welcomeMetadata: Omit<SecureWelcomeEnvelope, "ciphertext"> = {
        kind: "secure_welcome",
        e2eeVersion: ORBIS_E2EE_PROTOCOL_VERSION,
        suite: ORBIS_E2EE_SUITE,
        handshakeId: frame.handshakeId,
        mode: frame.mode,
        senderKeyId: local.keyId,
        recipientKeyId: frame.senderKeyId,
        encapsulatedKey: bytesToBase64Url(new Uint8Array(sender.enc)),
        sequence: 0,
      };
      const welcomeCiphertext = await sender.seal(encodeJson(welcome), welcomeAad(welcomeMetadata));
      return {
        channel: new OrbisSecureChannel(
          frame.handshakeId,
          local.keyId,
          frame.senderKeyId,
          sender,
          recipient,
        ),
        frame: secureWelcomeEnvelopeSchema.parse({
          ...welcomeMetadata,
          ciphertext: bytesToBase64Url(new Uint8Array(welcomeCiphertext)),
        }),
      };
    },
  };
}

export function createPairingSecret(random: SecureRandom): Promise<string> {
  return randomBytes(random, PSK_BYTES).then(bytesToBase64Url);
}

export function pairingSecretVerifier(pairingId: string, secret: string): string {
  const psk = pairingPsk({ pairingId, secret });
  return bytesToBase64Url(
    hmac(sha256, psk.key, textEncoder.encode(`orbis-pairing-verifier-v1:${pairingId}`)),
  );
}

export function constantTimeEqualBase64Url(left: string, right: string): boolean {
  let leftBytes: Uint8Array;
  let rightBytes: Uint8Array;
  try {
    leftBytes = base64UrlToBytes(left, "Verifier");
    rightBytes = base64UrlToBytes(right, "Verifier");
  } catch {
    return false;
  }
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    difference |= (leftBytes[index] as number) ^ (rightBytes[index] as number);
  }
  return difference === 0;
}

export function copySecretBytes(value: ArrayBufferLike | ArrayBufferView): ArrayBuffer {
  return toOwnedArrayBuffer(value);
}
