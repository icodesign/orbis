import { sha256 } from "@hpke/common";

export const ORBIS_REMOTE_DIAGNOSTICS_FORMAT = "orbis.remote-diagnostics" as const;
export const ORBIS_REMOTE_DIAGNOSTICS_FORMAT_VERSION = 1 as const;
export const ORBIS_REMOTE_DIAGNOSTICS_REDACTION_PROFILE = "support-safe-v1" as const;

export type OrbisRemoteDiagnosticsSource = "dsh-plugin" | "ios";

export interface OrbisRemoteDiagnosticsWindow {
  readonly from: string;
  readonly to: string;
}

export interface OrbisRemoteDiagnosticsLatestFailure {
  readonly at: string;
  readonly code: string;
  readonly method: string;
  readonly requestId: string;
  readonly serverCode?: string;
}

export interface OrbisRemoteDiagnosticsCorrelation {
  readonly endpointFingerprints?: readonly string[];
  readonly hostFingerprint?: string;
  readonly latestFailure?: OrbisRemoteDiagnosticsLatestFailure;
  readonly requestIds: readonly string[];
}

export interface OrbisRemoteDiagnosticsRedactionManifest {
  readonly omitted: readonly string[];
  readonly profile: typeof ORBIS_REMOTE_DIAGNOSTICS_REDACTION_PROFILE;
  readonly truncated: readonly string[];
}

/**
 * Describes the bounded data included in one support export. The manifest is
 * intentionally open-ended so the host and mobile collectors can report
 * their distinct retention limits without changing the envelope version.
 */
export interface OrbisRemoteDiagnosticsRetentionManifest {
  readonly [key: string]: unknown;
  readonly maxAgeDays?: number;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
}

export interface OrbisRemoteDiagnosticsEnvelope<Status = unknown, Logs = unknown> {
  readonly capturedAt: string;
  readonly correlation: OrbisRemoteDiagnosticsCorrelation;
  readonly environment: unknown;
  readonly format: typeof ORBIS_REMOTE_DIAGNOSTICS_FORMAT;
  readonly formatVersion: typeof ORBIS_REMOTE_DIAGNOSTICS_FORMAT_VERSION;
  readonly logs: Logs;
  readonly redaction: OrbisRemoteDiagnosticsRedactionManifest;
  readonly retention: OrbisRemoteDiagnosticsRetentionManifest;
  readonly source: OrbisRemoteDiagnosticsSource;
  readonly status: Status;
  readonly versions: Readonly<Record<string, string | null>>;
  readonly window: OrbisRemoteDiagnosticsWindow;
}

export type OrbisRemoteDiagnosticsEnvelopeInput<Status = unknown, Logs = unknown> = Omit<
  OrbisRemoteDiagnosticsEnvelope<Status, Logs>,
  "capturedAt" | "format" | "formatVersion"
>;

export function createRemoteDiagnosticsEnvelope<Status = unknown, Logs = unknown>(
  input: OrbisRemoteDiagnosticsEnvelopeInput<Status, Logs>,
  capturedAt = new Date().toISOString(),
): OrbisRemoteDiagnosticsEnvelope<Status, Logs> {
  return {
    capturedAt,
    correlation: input.correlation,
    environment: input.environment,
    format: ORBIS_REMOTE_DIAGNOSTICS_FORMAT,
    formatVersion: ORBIS_REMOTE_DIAGNOSTICS_FORMAT_VERSION,
    logs: input.logs,
    redaction: input.redaction,
    retention: input.retention,
    source: input.source,
    status: input.status,
    versions: input.versions,
    window: input.window,
  };
}

/**
 * Creates a stable, support-safe identifier without retaining the original
 * value. A short digest is enough to correlate one export's records while
 * avoiding host IDs, endpoint URLs, and key material in the artifact.
 */
export function fingerprintRemoteDiagnosticsValue(value: string): string {
  const digest = sha256(new TextEncoder().encode(value));
  let hexadecimal = "";
  for (const byte of digest) hexadecimal += byte.toString(16).padStart(2, "0");
  return `sha256:${hexadecimal.slice(0, 16)}`;
}

/** Alias kept deliberately descriptive at call sites that fingerprint a host. */
export const remoteDiagnosticsFingerprint = fingerprintRemoteDiagnosticsValue;

export interface RemoteDiagnosticsStoredEndpoint {
  readonly kind: string;
  readonly url: string;
  readonly expiresAt?: string;
}

export interface RemoteDiagnosticsStoredHarness {
  readonly id: string;
  readonly version?: string;
  readonly capabilities: readonly string[];
}

/** Structural input keeps this transport package independent of the database package. */
export interface RemoteDiagnosticsStoredServer {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly endpoints: readonly RemoteDiagnosticsStoredEndpoint[];
  readonly endpointRevision: number;
  readonly hostPublicKey: string;
  readonly hostKeyId: string;
  readonly permissionMode: string;
  readonly scopes: readonly string[];
  readonly harnesses: readonly RemoteDiagnosticsStoredHarness[];
  readonly enabled: boolean;
  readonly status: string;
  readonly pairedAt: number;
  readonly updatedAt: number;
  readonly lastSeenAt?: number;
}

export interface RedactedRemoteDiagnosticsEndpoint {
  readonly expiresAt?: string;
  readonly fingerprint: string;
  readonly kind: string;
}

export interface RedactedRemoteDiagnosticsHarness {
  readonly capabilities: readonly string[];
  readonly id: string;
  readonly version?: string;
}

/**
 * Support-safe projection of the persisted remote server. User-facing names
 * and raw secrets are intentionally omitted; endpoint kinds and fingerprints
 * remain useful when comparing route selection across exports.
 */
export interface RedactedRemoteDiagnosticsServer {
  readonly enabled: boolean;
  readonly endpointRevision: number;
  readonly endpoints: readonly RedactedRemoteDiagnosticsEndpoint[];
  readonly harnesses: readonly RedactedRemoteDiagnosticsHarness[];
  readonly hostFingerprint: string;
  readonly hostKeyFingerprint: string;
  readonly id: string;
  readonly lastSeenAt?: number;
  readonly pairedAt: number;
  readonly permissionMode: string;
  readonly platform: string;
  readonly scopes: readonly string[];
  readonly status: string;
  readonly updatedAt: number;
}

export function redactStoredRemoteServer(
  server: RemoteDiagnosticsStoredServer,
): RedactedRemoteDiagnosticsServer {
  const endpointFingerprintSalt = server.hostPublicKey || server.hostKeyId || server.id;
  return {
    enabled: server.enabled,
    endpointRevision: server.endpointRevision,
    endpoints: server.endpoints.map((endpoint) => ({
      ...(endpoint.expiresAt === undefined ? {} : { expiresAt: endpoint.expiresAt }),
      fingerprint: fingerprintRemoteDiagnosticsValue(
        `${endpointFingerprintSalt}\u0000${endpoint.url}`,
      ),
      kind: endpoint.kind,
    })),
    harnesses: server.harnesses.map((harness) => ({
      capabilities: [...harness.capabilities],
      id: fingerprintRemoteDiagnosticsValue(harness.id),
      ...(harness.version === undefined ? {} : { version: harness.version }),
    })),
    // `id` is the persisted hostId and is the cross-side correlation key used
    // by the DSH export. Keep key identity separate so a pinning mismatch is
    // still diagnosable without exposing either raw value.
    hostFingerprint: fingerprintRemoteDiagnosticsValue(server.id),
    hostKeyFingerprint: fingerprintRemoteDiagnosticsValue(
      server.hostPublicKey || server.hostKeyId || server.id,
    ),
    id: fingerprintRemoteDiagnosticsValue(server.id),
    ...(server.lastSeenAt === undefined ? {} : { lastSeenAt: server.lastSeenAt }),
    pairedAt: server.pairedAt,
    permissionMode: server.permissionMode,
    platform: server.platform,
    scopes: [...server.scopes],
    status: server.status,
    updatedAt: server.updatedAt,
  };
}

/**
 * Scrubs diagnostic text before it crosses the support boundary. This is a
 * defense in depth for errors and log messages supplied by a host runtime.
 */
export function sanitizeRemoteDiagnosticsText(value: string): string {
  return value
    .replaceAll(/\b(?:wss?|https?):\/\/[^\s,)}\]]+/giu, "<URL>")
    .replaceAll(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s,;)}\]]+/gu, "<PATH>")
    .replaceAll(/(^|[\s('"`])\/(?:[^/\s]+\/)*[^\s,;)}\]]+/gu, "$1<PATH>")
    .replaceAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "<IP>")
    .replaceAll(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replaceAll(
      /((?:access[_-]?token|authorization|password|pairing[_-]?secret|private[_-]?key|secret|token)\s*[:=]\s*)[^\s,;]+/giu,
      "$1[REDACTED]",
    )
    .slice(0, 4_096);
}

/**
 * Serializes support diagnostics defensively. Errors, bigint values, and
 * circular references are represented without allowing an export action to
 * crash while formatting an already-failed operation. Key and text redaction
 * remains a final defense if a collector accidentally passes raw details.
 */
export function serializeRemoteDiagnostics(value: unknown): string {
  const ancestors: object[] = [];
  const serializedErrors = new WeakSet<Error>();
  const serialized = JSON.stringify(
    value,
    function (key, candidate: unknown) {
      if (isSensitiveDiagnosticsKey(key)) return "[REDACTED]";
      if (typeof candidate === "bigint") return candidate.toString();
      if (candidate instanceof Error) {
        if (serializedErrors.has(candidate)) return "[Repeated Error]";
        serializedErrors.add(candidate);
        return errorRecord(candidate);
      }
      if (typeof candidate === "string") return sanitizeRemoteDiagnosticsText(candidate);
      if (typeof candidate === "number" && !Number.isFinite(candidate)) return String(candidate);
      if (candidate && typeof candidate === "object") {
        while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
        if (ancestors.includes(candidate)) return "[Circular]";
        ancestors.push(candidate);
      }
      return candidate;
    },
    2,
  );
  return `${serialized ?? "null"}\n`;
}

export function remoteDiagnosticsFileName(
  source: OrbisRemoteDiagnosticsSource,
  serverFingerprint: string | undefined,
  capturedAt: string,
): string {
  const safeFingerprint =
    serverFingerprint === undefined ? "" : `-${safeFileNamePart(serverFingerprint)}`;
  return `orbis-${source}-diagnostics${safeFingerprint}-${safeFileNamePart(capturedAt)}.json`;
}

function errorRecord(error: Error): Record<string, unknown> {
  const result: Record<string, unknown> = {
    message: error.message,
    name: error.name,
  };
  if (error.stack !== undefined) result.stack = error.stack;
  if (error.cause !== undefined) result.cause = error.cause;
  for (const [key, value] of Object.entries(error)) result[key] = value;
  return result;
}

function isSensitiveDiagnosticsKey(key: string): boolean {
  return /^(?:accessToken|authorization|hostKeyId|hostPublicKey|invitation|password|pairingSecret|privateKey|publicKey|secret|token)$/iu.test(
    key,
  );
}

function safeFileNamePart(value: string): string {
  const safe = value.replaceAll(/[^A-Za-z0-9_-]+/gu, "-").replaceAll(/^-+|-+$/gu, "");
  return safe || "unknown";
}
