import type { IncomingMessage, ServerResponse } from "node:http";

import { type OrbisDshHostService } from "./host-service";

const MAX_BODY_BYTES = 32 * 1024;

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

function failure(response: ServerResponse, status: number, error: unknown): void {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message.slice(0, 512)
      : "The Orbis operation failed";
  send(response, status, { error: message });
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("The request body is too large");
    chunks.push(bytes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("The request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("The request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(label + " must be a string");
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(label + " must be an integer");
  return value as number;
}

function methodNotAllowed(response: ServerResponse): void {
  send(response, 405, { error: "Method not allowed" });
}

/** Creates the privileged local management route consumed by the settings page. */
export function createOrbisHttpRoute(service: OrbisDshHostService): OrbisHttpRoute {
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
        if (pathname === "/orbis/status") {
          if (request.method !== "GET") return methodNotAllowed(response);
          send(response, 200, await service.status());
          return;
        }
        if (pathname === "/orbis/config") {
          if (request.method !== "PUT") return methodNotAllowed(response);
          const body = await jsonBody(request);
          await service.configure({
            directPort: integer(body.directPort, "directPort"),
            hostName: string(body.hostName, "hostName"),
          });
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
        failure(response, 400, error);
      }
    },
  };
}
