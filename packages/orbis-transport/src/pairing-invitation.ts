import { z } from "zod";

import { fingerprintPublicKey, ORBIS_E2EE_PROTOCOL_VERSION, ORBIS_E2EE_SUITE } from "./e2ee";
import { base64UrlToBytes } from "./encoding";
import {
  hostEndpointKindSchema,
  hostEndpointObjectSchema,
  hostEndpointSchema,
  type HostEndpoint,
} from "./endpoints";
import { OrbisTransportError } from "./errors";
import { remoteScopeModeSchema, type RemoteScopeMode } from "./protocol";

export const ORBIS_PAIRING_URI_SCHEME = "orbis:" as const;

export type PairingBootstrapEndpoint = Pick<HostEndpoint, "kind" | "url">;

export interface PairingInvitation {
  version: typeof ORBIS_E2EE_PROTOCOL_VERSION;
  pairingId: string;
  pairingSecret: string;
  hostId: string;
  hostName: string;
  hostPublicKey: string;
  hostKeyId: string;
  scopeMode: RemoteScopeMode;
  requestedScopes: readonly string[];
  expiresAt: string;
  suite: typeof ORBIS_E2EE_SUITE;
  /** One bootstrap route only; the authenticated welcome advertises the full endpoint catalog. */
  endpoint: PairingBootstrapEndpoint;
}

const pairingEndpointSchema: z.ZodType<PairingBootstrapEndpoint> = hostEndpointObjectSchema.pick({
  kind: true,
  url: true,
});

const invitationSchema: z.ZodType<PairingInvitation> = z
  .object({
    version: z.literal(ORBIS_E2EE_PROTOCOL_VERSION),
    pairingId: z.string().min(1).max(256),
    pairingSecret: z.string().length(43),
    hostId: z.string().min(1).max(256),
    hostName: z.string().min(1).max(256),
    hostPublicKey: z.string().length(43),
    hostKeyId: z.string().startsWith("sha256:").max(128),
    scopeMode: remoteScopeModeSchema,
    requestedScopes: z.array(z.string().min(1).max(128)).min(1).max(64),
    expiresAt: z.string().datetime({ offset: true }),
    suite: z.literal(ORBIS_E2EE_SUITE),
    endpoint: pairingEndpointSchema,
  })
  .strict()
  .refine((value) => new Set(value.requestedScopes).size === value.requestedScopes.length, {
    message: "Pairing invitation scopes must be unique",
    path: ["requestedScopes"],
  });

function validateInvitation(
  input: PairingInvitation,
  options: { now?: number } = {},
): PairingInvitation {
  const invitation = invitationSchema.parse(input);
  base64UrlToBytes(invitation.pairingSecret, "Pairing secret", 32);
  base64UrlToBytes(invitation.hostPublicKey, "Host public key", 32);
  if (fingerprintPublicKey(invitation.hostPublicKey) !== invitation.hostKeyId) {
    throw new OrbisTransportError(
      "authentication",
      "The pairing invitation host fingerprint is invalid",
    );
  }
  if (Date.parse(invitation.expiresAt) <= (options.now ?? Date.now())) {
    throw new OrbisTransportError("pairing_terminal", "The pairing invitation has expired", {
      serverCode: "pairing_expired",
    });
  }
  const endpoint = hostEndpointSchema.parse(invitation.endpoint);
  return { ...invitation, endpoint: { kind: endpoint.kind, url: endpoint.url } };
}

export function serializePairingInvitation(
  input: PairingInvitation,
  options: { now?: number } = {},
): string {
  const invitation = validateInvitation(input, options);
  const url = new URL("orbis://pair");
  url.searchParams.set("v", String(invitation.version));
  url.searchParams.set("endpoint_kind", invitation.endpoint.kind);
  url.searchParams.set("endpoint", invitation.endpoint.url);
  url.searchParams.set("pairing", invitation.pairingId);
  url.searchParams.set("secret", invitation.pairingSecret);
  url.searchParams.set("host", invitation.hostId);
  url.searchParams.set("name", invitation.hostName);
  url.searchParams.set("key", invitation.hostPublicKey);
  url.searchParams.set("key_id", invitation.hostKeyId);
  url.searchParams.set("scope_mode", invitation.scopeMode);
  for (const scope of invitation.requestedScopes) url.searchParams.append("scope", scope);
  url.searchParams.set("expires", invitation.expiresAt);
  url.searchParams.set("suite", invitation.suite);
  return url.toString();
}

function requiredParameter(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || !values[0]) {
    throw new OrbisTransportError(
      "invalid_argument",
      `Pairing invitation parameter '${name}' is missing or duplicated`,
    );
  }
  return values[0];
}

export function parsePairingInvitation(
  value: string,
  options: { now?: number } = {},
): PairingInvitation {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new OrbisTransportError("invalid_argument", "Pairing invitation is not a valid URL");
  }
  if (url.protocol !== ORBIS_PAIRING_URI_SCHEME || url.hostname !== "pair" || url.pathname !== "") {
    throw new OrbisTransportError("invalid_argument", "Pairing invitation route is invalid");
  }
  if (url.username || url.password || url.hash) {
    throw new OrbisTransportError("invalid_argument", "Pairing invitation URL is malformed");
  }

  const allowed = new Set([
    "v",
    "endpoint_kind",
    "endpoint",
    "pairing",
    "secret",
    "host",
    "name",
    "key",
    "key_id",
    "scope_mode",
    "scope",
    "expires",
    "suite",
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new OrbisTransportError(
        "invalid_argument",
        "Pairing invitation contains an unsupported parameter",
      );
    }
  }

  return validateInvitation(
    {
      version: Number(requiredParameter(url, "v")) as typeof ORBIS_E2EE_PROTOCOL_VERSION,
      endpoint: {
        kind: hostEndpointKindSchema.parse(requiredParameter(url, "endpoint_kind")),
        url: requiredParameter(url, "endpoint"),
      },
      pairingId: requiredParameter(url, "pairing"),
      pairingSecret: requiredParameter(url, "secret"),
      hostId: requiredParameter(url, "host"),
      hostName: requiredParameter(url, "name"),
      hostPublicKey: requiredParameter(url, "key"),
      hostKeyId: requiredParameter(url, "key_id"),
      scopeMode: remoteScopeModeSchema.parse(requiredParameter(url, "scope_mode")),
      requestedScopes: url.searchParams.getAll("scope"),
      expiresAt: requiredParameter(url, "expires"),
      suite: requiredParameter(url, "suite") as typeof ORBIS_E2EE_SUITE,
    },
    options,
  );
}
