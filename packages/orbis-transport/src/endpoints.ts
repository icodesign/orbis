import { z } from "zod";

import { validateDirectSocketUrl } from "./websocket-internal";

const identifierSchema = z.string().min(1).max(256);
const timestampSchema = z.string().datetime({ offset: true });

export const hostEndpointKinds = ["lan", "tailnet", "tunnel", "relay"] as const;
export const hostEndpointKindSchema = z.enum(hostEndpointKinds);

/** Structural endpoint schema kept separate so narrower wire records can compose it safely. */
export const hostEndpointObjectSchema = z
  .object({
    kind: hostEndpointKindSchema,
    url: z.string().url(),
    expiresAt: timestampSchema.optional(),
  })
  .strict();

export const hostEndpointSchema = hostEndpointObjectSchema.superRefine((endpoint, context) => {
  let url: URL;
  try {
    url = validateDirectSocketUrl(endpoint.url);
  } catch {
    context.addIssue({
      code: "custom",
      message: "Endpoint URL is not an allowed Orbis WebSocket URL",
      path: ["url"],
    });
    return;
  }
  if ((endpoint.kind === "relay" || endpoint.kind === "tunnel") && url.protocol !== "wss:") {
    context.addIssue({
      code: "custom",
      message: "Public relay and tunnel endpoints must use WSS",
      path: ["url"],
    });
  }
});

export type HostEndpoint = z.infer<typeof hostEndpointSchema>;

export const hostEndpointManifestSchema = z
  .object({
    hostId: identifierSchema,
    hostKeyId: z.string().min(1).max(512),
    revision: z.number().int().nonnegative(),
    endpoints: z.array(hostEndpointSchema).min(1).max(16),
  })
  .strict()
  .superRefine((manifest, context) => {
    const urls = new Set<string>();
    for (const [index, endpoint] of manifest.endpoints.entries()) {
      let normalized: string;
      try {
        normalized = validateDirectSocketUrl(endpoint.url).toString();
      } catch {
        continue;
      }
      if (urls.has(normalized)) {
        context.addIssue({
          code: "custom",
          message: "Endpoint URLs must be unique",
          path: ["endpoints", index, "url"],
        });
      }
      urls.add(normalized);
    }
  });

export type HostEndpointManifest = z.infer<typeof hostEndpointManifestSchema>;

/**
 * Returns a canonical, immutable endpoint manifest. Endpoint kind is only a
 * routing/diagnostic hint; the subsequent AuthPSK/Auth handshake remains the
 * authority for the host identity.
 */
export function normalizeHostEndpointManifest(input: HostEndpointManifest): HostEndpointManifest {
  const parsed = hostEndpointManifestSchema.parse(input);
  return {
    ...parsed,
    endpoints: parsed.endpoints.map((endpoint) => ({
      ...endpoint,
      url: validateDirectSocketUrl(endpoint.url).toString(),
    })),
  };
}

export function activeHostEndpoints(
  manifest: HostEndpointManifest,
  now = Date.now(),
): readonly HostEndpoint[] {
  return normalizeHostEndpointManifest(manifest).endpoints.filter(
    (endpoint) => endpoint.expiresAt === undefined || Date.parse(endpoint.expiresAt) > now,
  );
}
