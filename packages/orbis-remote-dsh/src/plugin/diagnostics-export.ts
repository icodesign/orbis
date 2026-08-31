import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";

import { ORBIS_TRANSPORT_PROTOCOL_VERSION } from "@orbisapp/transport/protocol-version";

import packageManifest from "../../package.json";
import { ORBIS_DSH_DRIVER_VERSION } from "./constants";
import type { OrbisDshFileLogger } from "./file-logger";
import type { OrbisDshStatus } from "./host-service";

const DIAGNOSTICS_WINDOW_MS = 30 * 60 * 1_000;
const MAX_EXPORTED_LOG_ENTRIES = 10_000;

export interface OrbisDshDiagnosticsPort {
  export(): Promise<OrbisDshDiagnosticsArtifact>;
}

export interface OrbisDshDiagnosticsArtifact {
  readonly filename: string;
  readonly json: string;
}

export interface OrbisDshDiagnosticsExporterOptions {
  readonly logger: OrbisDshFileLogger;
  readonly now?: () => Date;
  readonly status: () => Promise<OrbisDshStatus>;
}

type JsonRecord = Record<string, unknown>;

/** Builds the support-safe host half of a Remote diagnostics incident. */
export class OrbisDshDiagnosticsExporter implements OrbisDshDiagnosticsPort {
  private readonly logger: OrbisDshFileLogger;
  private readonly now: () => Date;
  private readonly status: () => Promise<OrbisDshStatus>;

  constructor(options: OrbisDshDiagnosticsExporterOptions) {
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.status = options.status;
  }

  async export(): Promise<OrbisDshDiagnosticsArtifact> {
    const capturedAt = this.now();
    const from = new Date(capturedAt.getTime() - DIAGNOSTICS_WINDOW_MS);
    await this.logger.flush();
    const [status, snapshot] = await Promise.all([
      this.status(),
      readDiagnosticLogSnapshot(this.logger.path, from.getTime(), capturedAt.getTime()),
    ]);
    const failures = snapshot.entries.filter(
      (entry) => entry.event === "remote.request.failed" && typeof entry.requestId === "string",
    );
    const requestIds = [
      ...new Set(
        snapshot.entries.flatMap((entry) =>
          typeof entry.requestId === "string" ? [entry.requestId] : [],
        ),
      ),
    ];
    const latestFailure = failures.at(-1);
    const hostFingerprint = remoteDiagnosticsFingerprint(status.configuration.hostId);
    const envelope = {
      capturedAt: capturedAt.toISOString(),
      correlation: {
        hostFingerprint,
        requestIds,
        ...(latestFailure === undefined
          ? {}
          : {
              latestFailure: {
                at:
                  typeof latestFailure.at === "string"
                    ? latestFailure.at
                    : capturedAt.toISOString(),
                code:
                  typeof latestFailure.errorCode === "string" ? latestFailure.errorCode : "unknown",
                method: typeof latestFailure.method === "string" ? latestFailure.method : "unknown",
                requestId:
                  typeof latestFailure.requestId === "string" ? latestFailure.requestId : "unknown",
              },
            }),
      },
      environment: hostEnvironment(),
      format: "orbis.remote-diagnostics" as const,
      formatVersion: 1 as const,
      logs: snapshot,
      redaction: {
        omitted: [
          "access tokens and provider credentials",
          "endpoint URLs and IP addresses",
          "host and peer public keys",
          "pairing invitations and secrets",
          "prompt, transcript, and tool payloads",
          "raw DSH event recordings",
        ],
        profile: "support-safe-v1" as const,
        truncated: snapshot.truncated ? ["server diagnostics log"] : [],
      },
      retention: {
        maxEntries: MAX_EXPORTED_LOG_ENTRIES,
        maxWindowMs: DIAGNOSTICS_WINDOW_MS,
        rotatedFileRead: snapshot.rotatedFileRead,
      },
      source: "dsh-plugin" as const,
      status: supportSafeStatus(status),
      versions: {
        dshDriver: ORBIS_DSH_DRIVER_VERSION,
        plugin: packageManifest.version,
        protocol: String(ORBIS_TRANSPORT_PROTOCOL_VERSION),
      },
      window: { from: from.toISOString(), to: capturedAt.toISOString() },
    };
    return {
      filename: diagnosticsFileName("dsh-plugin", hostFingerprint, capturedAt.toISOString()),
      json: serializeDiagnostics(envelope),
    };
  }
}

function hostEnvironment(): JsonRecord {
  const isWsl =
    process.platform === "linux" &&
    (typeof process.env.WSL_INTEROP === "string" ||
      typeof process.env.WSL_DISTRO_NAME === "string");
  const distribution = isWsl ? process.env.WSL_DISTRO_NAME?.trim() : undefined;
  const hostMachine =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : process.platform === "linux"
          ? "linux"
          : "unknown";
  return {
    architecture: process.arch,
    host: {
      hostMachine,
      isWsl,
      ...(distribution ? { wslDistribution: sanitizeDiagnosticText(distribution) } : {}),
    },
    node: process.version,
    platform: process.platform,
  };
}

function supportSafeStatus(status: OrbisDshStatus): JsonRecord {
  return {
    configuration: {
      autoEndpointKinds: status.configuration.autoDirectEndpoints.map((endpoint) => endpoint.kind),
      directPort: status.configuration.directPort,
      endpointCount: status.configuration.endpoints.length,
      endpointKinds: status.configuration.endpoints.map((endpoint) => endpoint.kind),
      endpointRevision: status.configuration.endpointRevision,
      ready: status.configuration.ready,
    },
    connection: {
      error: status.connection.error ? sanitizeDiagnosticText(status.connection.error) : null,
      state: status.connection.state,
    },
    devices: status.devices.map((device) => ({
      connected: device.connected,
      error: device.error ? sanitizeDiagnosticText(device.error) : null,
      pairedAt: device.pairedAt,
      lastConnectedAt: device.lastConnectedAt ?? null,
      scopeMode: device.scopeMode,
      scopes: device.scopes,
      version: device.version,
    })),
    ...(status.pairing === undefined
      ? {}
      : {
          pairing: {
            active: true,
            phase: status.pairing.phase,
            transport: status.pairing.transport,
          },
        }),
  };
}

async function readDiagnosticLogSnapshot(
  path: string,
  fromMs: number,
  toMs: number,
): Promise<{
  readonly entries: readonly JsonRecord[];
  readonly invalidLines: number;
  readonly rotatedFileRead: boolean;
  readonly truncated: boolean;
}> {
  let invalidLines = 0;
  let rotatedFileRead = false;
  const entries: JsonRecord[] = [];
  for (const [candidate, rotated] of [
    [`${path}.1`, true],
    [path, false],
  ] as const) {
    let content: string;
    try {
      content = await readFile(candidate, "utf8");
      if (rotated) rotatedFileRead = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      invalidLines += 1;
      continue;
    }
    for (const line of content.split("\n")) {
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) {
          invalidLines += 1;
          continue;
        }
        const atMs = typeof parsed.at === "string" ? Date.parse(parsed.at) : Number.NaN;
        if (!Number.isFinite(atMs) || atMs < fromMs || atMs > toMs) continue;
        entries.push(sanitizeLogRecord(parsed));
      } catch {
        invalidLines += 1;
      }
    }
  }
  const truncated = entries.length > MAX_EXPORTED_LOG_ENTRIES;
  return {
    entries: truncated ? entries.slice(-MAX_EXPORTED_LOG_ENTRIES) : entries,
    invalidLines,
    rotatedFileRead,
    truncated,
  };
}

function sanitizeLogRecord(record: JsonRecord): JsonRecord {
  const upstreamFailure = record.event === "dsh.operation.failed";
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(record)) {
    if (upstreamFailure && key === "errorMessage") {
      if (typeof value === "string") {
        entries.push(["errorMessageBytes", Buffer.byteLength(value, "utf8")]);
      }
      continue;
    }
    if (upstreamFailure && key === "errorStack") continue;
    if (key === "requestId") {
      if (typeof value === "string") entries.push([key, sanitizeDiagnosticText(value)]);
      continue;
    }
    if (
      /^(?:backendId|deviceId|hostId|hostKeyId|pairingId|peerDeviceId|peerKeyId|sessionId)$/iu.test(
        key,
      )
    ) {
      if (typeof value === "string") entries.push([key, remoteDiagnosticsFingerprint(value)]);
      continue;
    }
    if (
      /^(?:accessToken|authorization|invitation|password|pairingSecret|privateKey|publicKey|secret|token)$/iu.test(
        key,
      )
    ) {
      entries.push([key, "[REDACTED]"]);
      continue;
    }
    if (typeof value === "string") entries.push([key, sanitizeDiagnosticText(value)]);
    if (typeof value === "boolean" || typeof value === "number" || value === null) {
      entries.push([key, value]);
    }
  }
  return Object.fromEntries(entries);
}

function sanitizeDiagnosticText(value: string): string {
  const home = homedir();
  const temporary = tmpdir();
  return value
    .replaceAll(home, "<HOME>")
    .replaceAll(temporary, "<TEMP>")
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

function remoteDiagnosticsFingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)}`;
}

function diagnosticsFileName(source: string, fingerprint: string, capturedAt: string): string {
  return `orbis-${source}-diagnostics-${safeFileNamePart(fingerprint)}-${safeFileNamePart(capturedAt)}.json`;
}

function safeFileNamePart(value: string): string {
  const safe = value.replaceAll(/[^A-Za-z0-9_-]+/gu, "-").replaceAll(/^-+|-+$/gu, "");
  return safe || "unknown";
}

function serializeDiagnostics(value: unknown): string {
  const ancestors: object[] = [];
  const serialized = JSON.stringify(
    value,
    function (key, candidate: unknown) {
      if (isSensitiveDiagnosticsKey(key)) return "[REDACTED]";
      if (typeof candidate === "bigint") return candidate.toString();
      if (typeof candidate === "string") return sanitizeDiagnosticText(candidate);
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

function isSensitiveDiagnosticsKey(key: string): boolean {
  return /^(?:accessToken|authorization|hostKeyId|hostPublicKey|invitation|password|pairingSecret|privateKey|publicKey|secret|token)$/iu.test(
    key,
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
