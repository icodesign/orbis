import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

import { z } from "zod";

import type { OrbisDshDiagnosticsPort } from "./diagnostics-export";
import { type OrbisDshHostService } from "./host-service";
import type {
  OrbisDshRawEventExportMetadata,
  OrbisDshRawEventRecordingStatus,
} from "./raw-dsh-event-recorder";
import type {
  OrbisDshRawEventReplayStatus,
  OrbisDshRawEventReplayer,
} from "./raw-dsh-event-replayer";

export type OrbisRawDshEventRecordingStatus = OrbisDshRawEventRecordingStatus;

export interface OrbisRawDshEventRecorderPort {
  latestExport(): Promise<OrbisDshRawEventExportMetadata | undefined>;
  start(): Promise<OrbisRawDshEventRecordingStatus>;
  status(): OrbisRawDshEventRecordingStatus;
  stop(): Promise<OrbisRawDshEventRecordingStatus>;
}

export type OrbisRawDshEventReplayerPort = Pick<
  OrbisDshRawEventReplayer,
  "cancel" | "start" | "status"
>;

const MAX_BODY_BYTES = 32 * 1024;

const configureRequestSchema = z.object({
  directPort: z.number().int(),
  hostName: z.string(),
});

export interface OrbisHttpRoute {
  readonly kind: "prefix";
  readonly path: "/orbis";
  readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Pairing invitations and credentials are sensitive. The plugin only mounts
 * while the DSH web server binds loopback, and this additional Host and Origin
 * fence prevents a DNS-rebound page from reading this independent route.
 */
function isTrustedLoopbackRequest(request: IncomingMessage): boolean {
  const host = header(request, "host");
  if (!host) return false;
  let authority: URL;
  try {
    authority = new URL("http://" + host);
  } catch {
    return false;
  }
  if (
    authority.pathname !== "/" ||
    authority.search !== "" ||
    authority.hash !== "" ||
    authority.username !== "" ||
    authority.password !== ""
  ) {
    return false;
  }
  const hostname = authority.hostname.toLowerCase();
  if (
    hostname !== "127.0.0.1" &&
    hostname !== "::1" &&
    hostname !== "[::1]" &&
    hostname !== "localhost"
  ) {
    return false;
  }
  if (header(request, "sec-fetch-site") === "cross-site") return false;
  const origin = header(request, "origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === authority.host;
  } catch {
    return false;
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function safeDownloadFilename(value: string, fallback: string): string {
  const filename = value.replace(/[^A-Za-z0-9._-]/gu, "_");
  return filename.length > 0 ? filename : fallback;
}

async function sendRecordingExport(
  response: ServerResponse,
  recorder: OrbisRawDshEventRecorderPort,
): Promise<void> {
  const artifact = await recorder.latestExport();
  if (artifact === undefined) throw new Error("No DSH event recording is available to export");
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="${safeDownloadFilename(
      artifact.filename,
      "dsh-raw-events.jsonl",
    )}"`,
    "content-length": String(artifact.bytes),
    "content-type": "application/x-ndjson; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  await pipeline(createReadStream(artifact.path), response);
}

async function sendDiagnosticsExport(
  response: ServerResponse,
  diagnostics: OrbisDshDiagnosticsPort,
): Promise<void> {
  const artifact = await diagnostics.export();
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="${safeDownloadFilename(
      artifact.filename,
      "orbis-diagnostics.json",
    )}"`,
    "content-length": String(Buffer.byteLength(artifact.json, "utf8")),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(artifact.json);
}

function failure(response: ServerResponse, status: number, error: unknown): void {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message.slice(0, 512)
      : "The Orbis operation failed";
  send(response, status, { error: message });
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("The request body is too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("The request body must be valid JSON");
  }
}

function methodNotAllowed(response: ServerResponse): void {
  send(response, 405, { error: "Method not allowed" });
}

function replayActive(status: OrbisDshRawEventReplayStatus): boolean {
  return status.state === "preparing" || status.state === "waiting" || status.state === "replaying";
}

function replayFilename(request: IncomingMessage): string | undefined {
  const value = header(request, "x-orbis-replay-filename");
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("The replay filename is invalid");
  }
}

/** Creates the privileged local management route consumed by the settings page. */
export interface OrbisHttpRouteOptions {
  readonly diagnostics?: OrbisDshDiagnosticsPort;
  readonly recorder?: OrbisRawDshEventRecorderPort;
  readonly replayer?: OrbisRawDshEventReplayerPort;
}

export function createOrbisHttpRoute(
  service: OrbisDshHostService,
  options: OrbisHttpRouteOptions = {},
): OrbisHttpRoute {
  const { diagnostics, recorder, replayer } = options;
  return {
    kind: "prefix",
    path: "/orbis",
    handler: async (request, response) => {
      if (!isTrustedLoopbackRequest(request)) {
        failure(response, 403, new Error("Orbis management is available only on loopback"));
        return;
      }
      const pathname = new URL(request.url ?? "/", "http://orbis.local").pathname;
      try {
        if (pathname === "/orbis/diagnostics/export") {
          if (diagnostics === undefined) {
            failure(response, 404, new Error("Orbis diagnostics export is unavailable"));
            return;
          }
          if (request.method !== "GET") return methodNotAllowed(response);
          await sendDiagnosticsExport(response, diagnostics);
          return;
        }
        if (pathname === "/orbis/replay") {
          if (replayer === undefined) {
            failure(response, 404, new Error("DSH event replay is unavailable"));
            return;
          }
          if (request.method === "GET") {
            send(response, 200, replayer.status());
            return;
          }
          if (request.method === "POST") {
            if (recorder?.status().state === "recording") {
              throw new Error("Stop the active DSH event recording before starting a replay");
            }
            if ((await service.status()).connection.state !== "connected") {
              throw new Error("Turn on Orbis access before starting a DSH event replay");
            }
            const filename = replayFilename(request);
            send(
              response,
              200,
              await replayer.start({
                data: request,
                ...(filename === undefined ? {} : { filename }),
              }),
            );
            return;
          }
          if (request.method === "DELETE") {
            send(response, 200, await replayer.cancel());
            return;
          }
          return methodNotAllowed(response);
        }
        if (pathname === "/orbis/recording/export") {
          if (recorder === undefined) {
            failure(response, 404, new Error("DSH event recording is unavailable"));
            return;
          }
          if (request.method !== "GET") return methodNotAllowed(response);
          await sendRecordingExport(response, recorder);
          return;
        }
        if (pathname === "/orbis/recording") {
          if (recorder === undefined) {
            failure(response, 404, new Error("DSH event recording is unavailable"));
            return;
          }
          if (request.method === "GET") {
            send(response, 200, recorder.status());
            return;
          }
          if (request.method === "POST") {
            if (replayer !== undefined && replayActive(replayer.status())) {
              throw new Error("Cancel the active DSH event replay before starting a recording");
            }
            send(response, 200, await recorder.start());
            return;
          }
          if (request.method === "DELETE") {
            send(response, 200, await recorder.stop());
            return;
          }
          return methodNotAllowed(response);
        }
        if (pathname === "/orbis/status") {
          if (request.method !== "GET") return methodNotAllowed(response);
          send(response, 200, await service.status());
          return;
        }
        if (pathname === "/orbis/config") {
          if (request.method !== "PUT") return methodNotAllowed(response);
          const result = configureRequestSchema.safeParse(await jsonBody(request));
          if (!result.success) {
            throw new Error("The request body must include directPort and hostName");
          }
          await service.configure(result.data);
          send(response, 200, await service.status());
          return;
        }
        if (pathname === "/orbis/connect") {
          if (request.method !== "POST") return methodNotAllowed(response);
          await service.connect();
          send(response, 200, await service.status());
          return;
        }
        if (pathname === "/orbis/disconnect") {
          if (request.method !== "POST") return methodNotAllowed(response);
          await service.disconnect();
          send(response, 200, await service.status());
          return;
        }
        if (pathname === "/orbis/pairings") {
          if (request.method === "POST") {
            await service.startPairing();
            send(response, 200, await service.status());
            return;
          }
          if (request.method === "DELETE") {
            await service.cancelPairing();
            send(response, 200, await service.status());
            return;
          }
          return methodNotAllowed(response);
        }
        const devicePrefix = "/orbis/devices/";
        if (pathname.startsWith(devicePrefix)) {
          if (request.method !== "DELETE") return methodNotAllowed(response);
          const keyId = decodeURIComponent(pathname.slice(devicePrefix.length));
          await service.revokeDevice(keyId);
          send(response, 200, await service.status());
          return;
        }
        failure(response, 404, new Error("Orbis route not found"));
      } catch (error) {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : new Error("Orbis export failed"));
          return;
        }
        failure(response, 400, error);
      }
    },
  };
}
