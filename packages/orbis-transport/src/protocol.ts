import { z } from "zod";

import { hostEndpointManifestSchema } from "./endpoints";

export const ORBIS_TRANSPORT_PROTOCOL_VERSION = 2 as const;
export const ORBIS_TRANSPORT_SUBPROTOCOL = "orbis.transport.v2" as const;
/** Outer carrier used only between a host and a blind WebSocket relay. */
export const ORBIS_RELAY_UPLINK_SUBPROTOCOL = "orbis.relay.uplink.v1" as const;

const identifierSchema = z.string().min(1).max(256);
const timestampSchema = z.string().datetime({ offset: true });
const scopeSchema = z.string().min(1).max(128);

export const ORBIS_REMOTE_SCOPES = {
  connect: "host:connect",
  agentRead: "agent:read",
  agentWrite: "agent:write",
  workspaceBrowse: "workspace:browse",
} as const;

export const ORBIS_REMOTE_SCOPE_VALUES = Object.freeze(Object.values(ORBIS_REMOTE_SCOPES));

export const remoteScopeModeSchema = z.enum(["all", "custom"]);
export type RemoteScopeMode = z.infer<typeof remoteScopeModeSchema>;

export function resolveRemoteScopes(
  mode: RemoteScopeMode,
  customScopes: readonly string[],
): readonly string[] {
  return mode === "all" ? ORBIS_REMOTE_SCOPE_VALUES : customScopes;
}

export function remoteScopePolicyAllows(
  mode: RemoteScopeMode,
  customScopes: readonly string[],
  requiredScope: string,
): boolean {
  return mode === "all" || customScopes.includes(requiredScope);
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const remoteHarnessSchema = z
  .object({
    id: identifierSchema,
    version: z.string().min(1).max(128).optional(),
    capabilities: z.array(z.string().min(1).max(128)).max(256).default([]),
  })
  .strict();

export const remoteHostSchema = z
  .object({
    id: identifierSchema,
    name: z.string().min(1).max(256),
    platform: z.string().min(1).max(128),
    status: z.enum(["online", "offline", "unknown"]),
    publicKeyFingerprint: z.string().min(1).max(512).optional(),
    lastSeenAt: timestampSchema.optional(),
    harnesses: z.array(remoteHarnessSchema).max(64).default([]),
  })
  .strict();

export type RemoteHost = z.infer<typeof remoteHostSchema>;

export const pairingInitiationInputSchema = z
  .object({
    /**
     * Host-chosen pairing identifier. The host needs this value before the
     * request so it can bind the one-time PSK verifier to the exact pairing
     * transcript it will later accept.
     */
    pairingId: identifierSchema,
    /** Stable host identity at the control plane, chosen and persisted by the host. */
    hostId: identifierSchema,
    hostName: z.string().min(1).max(256),
    platform: z.string().min(1).max(128),
    publicKey: z.string().min(1).max(16_384),
    pairingSecretVerifier: z.string().min(32).max(512),
    requestedScopes: z.array(scopeSchema).min(1).max(64),
  })
  .strict();

export type PairingInitiationInput = z.infer<typeof pairingInitiationInputSchema>;

export const pairingChallengeSchema = z
  .object({
    pairingId: identifierSchema,
    pollingToken: z.string().min(16).max(4096),
    userCode: z.string().min(4).max(32).optional(),
    verificationUri: z.string().url(),
    expiresAt: timestampSchema,
    intervalSeconds: z.number().int().min(1).max(300),
  })
  .strict();

export type PairingChallenge = z.infer<typeof pairingChallengeSchema>;

export const pairingLookupSchema = z
  .object({
    pairingId: identifierSchema,
    hostPublicKey: z.string().min(1).max(16_384),
    host: remoteHostSchema.pick({
      id: true,
      name: true,
      platform: true,
      status: true,
      publicKeyFingerprint: true,
      harnesses: true,
    }),
    requestedScopes: z.array(scopeSchema).max(64),
    expiresAt: timestampSchema,
  })
  .strict();

export type PairingLookup = z.infer<typeof pairingLookupSchema>;

export const pairingApprovalInputSchema = z
  .object({
    scopes: z.array(scopeSchema).min(1).max(64),
    clientPublicKey: z.string().min(1).max(16_384),
    clientKeyId: z.string().min(1).max(512),
  })
  .strict();

export type PairingApprovalInput = z.infer<typeof pairingApprovalInputSchema>;

export const remoteCredentialSchema = z
  .object({
    accessToken: z.string().min(1).max(16_384),
    refreshToken: z.string().min(1).max(16_384).optional(),
    expiresAt: timestampSchema,
  })
  .strict();

export type RemoteCredential = z.infer<typeof remoteCredentialSchema>;

const pendingPairingStatusSchema = z
  .object({
    status: z.literal("pending"),
    expiresAt: timestampSchema,
    intervalSeconds: z.number().int().min(1).max(300).optional(),
  })
  .strict();

const approvedPairingStatusSchema = z
  .object({
    status: z.literal("approved"),
    host: remoteHostSchema,
    credential: remoteCredentialSchema,
    peer: z
      .object({
        publicKey: z.string().min(1).max(16_384),
        keyId: z.string().min(1).max(512),
        scopes: z.array(scopeSchema).min(1).max(64),
      })
      .strict(),
  })
  .strict();

const rejectedPairingStatusSchema = z
  .object({
    status: z.literal("rejected"),
  })
  .strict();

const cancelledPairingStatusSchema = z
  .object({
    status: z.literal("cancelled"),
  })
  .strict();

const expiredPairingStatusSchema = z
  .object({
    status: z.literal("expired"),
  })
  .strict();

export const pairingStatusSchema = z.discriminatedUnion("status", [
  pendingPairingStatusSchema,
  approvedPairingStatusSchema,
  rejectedPairingStatusSchema,
  cancelledPairingStatusSchema,
  expiredPairingStatusSchema,
]);

export type PairingStatus = z.infer<typeof pairingStatusSchema>;
export type ApprovedPairingStatus = z.infer<typeof approvedPairingStatusSchema>;

export const connectionTicketRequestSchema = z
  .object({
    hostId: identifierSchema,
    deviceId: identifierSchema,
    role: z.enum(["client", "host"]),
    protocolVersion: z
      .literal(ORBIS_TRANSPORT_PROTOCOL_VERSION)
      .default(ORBIS_TRANSPORT_PROTOCOL_VERSION),
  })
  .strict();

export type ConnectionTicketRequest = z.input<typeof connectionTicketRequestSchema>;

export const connectionTicketSchema = z
  .object({
    ticket: z.string().min(1).max(16_384),
    expiresAt: timestampSchema,
    websocketUrl: z.string().url(),
    protocol: z.literal(ORBIS_TRANSPORT_SUBPROTOCOL),
    host: remoteHostSchema,
  })
  .strict();

export type ConnectionTicket = z.infer<typeof connectionTicketSchema>;

export const serverErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1).max(256),
        message: z.string().max(4096).optional(),
        retryable: z.boolean().optional(),
        retryAfterMs: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();

export const serverAcknowledgementSchema = z.object({ ok: z.literal(true) }).strict();

export const peerDescriptorSchema = z
  .object({
    deviceId: identifierSchema,
    deviceName: z.string().min(1).max(256).optional(),
    role: z.enum(["client", "host"]),
    version: z.string().min(1).max(128),
  })
  .strict();

export type PeerDescriptor = z.infer<typeof peerDescriptorSchema>;

export const transportHelloFrameSchema = z
  .object({
    kind: z.literal("hello"),
    id: identifierSchema,
    /** Shared by every physical endpoint attempt in one client connection race. */
    raceId: identifierSchema,
    protocolVersion: z.literal(ORBIS_TRANSPORT_PROTOCOL_VERSION),
    peer: peerDescriptorSchema,
  })
  .strict();

export const transportCapabilitiesSchema = z
  .object({
    methods: z.array(z.string().min(1).max(256)).max(1024),
    maxFrameBytes: z
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024)
      .optional(),
  })
  .strict();

export const transportWelcomeFrameSchema = z
  .object({
    kind: z.literal("welcome"),
    id: identifierSchema,
    protocolVersion: z.literal(ORBIS_TRANSPORT_PROTOCOL_VERSION),
    connectionId: identifierSchema,
    host: remoteHostSchema,
    capabilities: transportCapabilitiesSchema,
    endpointManifest: hostEndpointManifestSchema,
  })
  .strict();

export type TransportWelcomeFrame = z.infer<typeof transportWelcomeFrameSchema>;
export type TransportCapabilities = z.infer<typeof transportCapabilitiesSchema>;

export const transportActivateFrameSchema = z
  .object({
    kind: z.literal("activate"),
    id: identifierSchema,
    raceId: identifierSchema,
  })
  .strict();

export const transportActivatedFrameSchema = z
  .object({
    kind: z.literal("activated"),
    id: identifierSchema,
    raceId: identifierSchema,
  })
  .strict();

export const transportEndpointManifestFrameSchema = z
  .object({
    kind: z.literal("endpoint_manifest"),
    id: identifierSchema,
    manifest: hostEndpointManifestSchema,
  })
  .strict();

/** Relay-visible routing control; it contains no application data or identity key material. */
export const relayPeerCloseFrameSchema = z
  .object({
    kind: z.literal("relay_peer_close"),
    handshakeId: identifierSchema,
    code: z.number().int().min(1000).max(4999).optional(),
  })
  .strict();

export const transportRequestFrameSchema = z
  .object({
    kind: z.literal("request"),
    id: identifierSchema,
    requestId: identifierSchema,
    method: z.string().min(1).max(256),
    params: jsonValueSchema,
  })
  .strict();

export const transportCancelFrameSchema = z
  .object({
    kind: z.literal("cancel"),
    id: identifierSchema,
    requestId: identifierSchema,
    reason: z.enum(["aborted", "timeout"]),
  })
  .strict();

export const transportResponseFrameSchema = z
  .object({
    kind: z.literal("response"),
    id: identifierSchema,
    requestId: identifierSchema,
    result: jsonValueSchema,
  })
  .strict();

export const transportErrorFrameSchema = z
  .object({
    kind: z.literal("error"),
    id: identifierSchema,
    requestId: identifierSchema.optional(),
    error: z
      .object({
        code: z.string().min(1).max(256),
        message: z.string().max(4096).optional(),
        retryable: z.boolean().optional(),
        retryAfterMs: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();

export const transportEventSchema = z
  .object({
    eventId: identifierSchema,
    sessionId: identifierSchema,
    runId: identifierSchema.optional(),
    eventSeq: z.number().int().nonnegative(),
    time: timestampSchema,
    durability: z.enum(["durable", "transient"]),
    type: z.string().min(1).max(256),
    payload: jsonValueSchema,
    source: z
      .object({
        harness: z.string().min(1).max(256),
        nativeType: z.string().min(1).max(256).optional(),
        version: z.string().min(1).max(128).optional(),
      })
      .strict(),
  })
  .strict();

export type TransportEvent = z.infer<typeof transportEventSchema>;

export const transportEventFrameSchema = z
  .object({
    kind: z.literal("event"),
    id: identifierSchema,
    event: transportEventSchema,
  })
  .strict();

export const transportAckFrameSchema = z
  .object({
    kind: z.literal("ack"),
    id: identifierSchema,
    sessionId: identifierSchema,
    eventSeq: z.number().int().nonnegative(),
  })
  .strict();

export const incomingTransportFrameSchema = z.discriminatedUnion("kind", [
  transportWelcomeFrameSchema,
  transportActivatedFrameSchema,
  transportEndpointManifestFrameSchema,
  transportResponseFrameSchema,
  transportErrorFrameSchema,
  transportEventFrameSchema,
]);

export const incomingHostTransportFrameSchema = z.discriminatedUnion("kind", [
  transportActivateFrameSchema,
  transportRequestFrameSchema,
  transportCancelFrameSchema,
  transportAckFrameSchema,
]);

export type IncomingTransportFrame = z.infer<typeof incomingTransportFrameSchema>;
export type IncomingHostTransportFrame = z.infer<typeof incomingHostTransportFrameSchema>;
export type TransportHelloFrame = z.infer<typeof transportHelloFrameSchema>;
export type TransportRequestFrame = z.infer<typeof transportRequestFrameSchema>;
export type TransportCancelFrame = z.infer<typeof transportCancelFrameSchema>;
export type TransportAckFrame = z.infer<typeof transportAckFrameSchema>;
export type TransportActivateFrame = z.infer<typeof transportActivateFrameSchema>;
export type TransportActivatedFrame = z.infer<typeof transportActivatedFrameSchema>;
export type TransportEndpointManifestFrame = z.infer<typeof transportEndpointManifestFrameSchema>;
export type RelayPeerCloseFrame = z.infer<typeof relayPeerCloseFrameSchema>;
