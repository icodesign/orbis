import { z } from "zod";

import { abortError, createAbortScope, defaultSleep, raceWithAbort, type Sleep } from "./abort";
import { isValidHeaderCredential } from "./credential";
import { OrbisTransportError } from "./errors";
import {
  connectionTicketRequestSchema,
  connectionTicketSchema,
  ORBIS_TRANSPORT_PROTOCOL_VERSION,
  pairingApprovalInputSchema,
  pairingChallengeSchema,
  pairingInitiationInputSchema,
  pairingLookupSchema,
  pairingStatusSchema,
  remoteHostSchema,
  serverAcknowledgementSchema,
  serverErrorResponseSchema,
  type ApprovedPairingStatus,
  type ConnectionTicket,
  type ConnectionTicketRequest,
  type PairingApprovalInput,
  type PairingChallenge,
  type PairingInitiationInput,
  type PairingLookup,
  type PairingStatus,
  type RemoteHost,
} from "./protocol";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

const identifierSchema = z.string().min(1).max(256);
const pairingReferenceSchema = z.object({
  pairingId: identifierSchema,
  pollingToken: z.string().min(16).max(4096),
});

export interface AccessTokenRequest {
  signal: AbortSignal;
  /** Normalized control-plane base URL that will receive the token. */
  serverUrl: string;
}

/** The application owns credential storage; the transport asks for a token per operation. */
export type AccessTokenProvider = (
  request: AccessTokenRequest,
) => Promise<string | null | undefined>;

export type FetchImplementation = typeof globalThis.fetch;

export interface TransportOperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type WaitForPairingOptions = TransportOperationOptions;

export interface OrbisTransportClientOptions {
  baseUrl: string;
  accessTokenProvider?: AccessTokenProvider;
  fetch?: FetchImplementation;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  /** Development only. Production callers must use HTTPS. */
  allowInsecureHttp?: boolean;
  now?: () => number;
  sleep?: Sleep;
}

type Authentication = { kind: "none" } | { kind: "access" } | { kind: "polling"; token: string };

interface RequestConfiguration<T> {
  method: "DELETE" | "GET" | "POST";
  path: string;
  auth: Authentication;
  body?: unknown;
  responseSchema: z.ZodType<T>;
  allowEmptyAcknowledgement?: boolean;
  options?: TransportOperationOptions;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const paths = Array.from(
      new Set(result.error.issues.map((issue) => issue.path.join(".")).filter(Boolean)),
    );
    const suffix = paths.length > 0 ? `: ${paths.join(", ")}` : "";
    throw new OrbisTransportError("invalid_argument", `${label} is invalid${suffix}`);
  }

  return result.data;
}

function normalizeBaseUrl(value: string, allowInsecureHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OrbisTransportError("invalid_argument", "baseUrl must be an absolute URL");
  }

  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    throw new OrbisTransportError("insecure_transport", "The Orbis control plane requires HTTPS");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new OrbisTransportError(
      "invalid_argument",
      "baseUrl must not contain credentials, a query, or a fragment",
    );
  }

  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function validateHeaderCredential(value: string, label: string): string {
  if (!isValidHeaderCredential(value, 16_384)) {
    throw new OrbisTransportError("authentication", `${label} is unavailable or invalid`);
  }
  return value;
}

function retryAfterFromHeader(response: Response, now: number): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - now);
  }

  return undefined;
}

function responseByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function pairingTerminalError(status: Exclude<PairingStatus["status"], "approved" | "pending">) {
  return new OrbisTransportError("pairing_terminal", `Pairing ended with status: ${status}`, {
    serverCode: `pairing_${status}`,
  });
}

export class OrbisTransportClient {
  private readonly baseUrlValue: URL;
  private readonly accessTokenProvider?: AccessTokenProvider;
  private readonly fetchImplementation: FetchImplementation;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly now: () => number;
  private readonly sleep: Sleep;

  constructor(options: OrbisTransportClientOptions) {
    this.baseUrlValue = normalizeBaseUrl(options.baseUrl, options.allowInsecureHttp ?? false);
    this.accessTokenProvider = options.accessTokenProvider;

    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") {
      throw new OrbisTransportError(
        "invalid_argument",
        "A fetch implementation is required in this runtime",
      );
    }
    this.fetchImplementation = fetchImplementation.bind(globalThis);

    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new OrbisTransportError(
        "invalid_argument",
        "requestTimeoutMs must be a positive number",
      );
    }

    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new OrbisTransportError(
        "invalid_argument",
        "maxResponseBytes must be a positive integer",
      );
    }

    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get baseUrl(): string {
    return this.baseUrlValue.toString();
  }

  initiatePairing(
    input: PairingInitiationInput,
    options?: TransportOperationOptions,
  ): Promise<PairingChallenge> {
    const body = parseInput(pairingInitiationInputSchema, input, "Pairing initiation input");
    return this.request({
      method: "POST",
      path: "v1/pairings",
      auth: { kind: "none" },
      body,
      responseSchema: pairingChallengeSchema,
      options,
    });
  }

  lookupPairing(pairingId: string, options?: TransportOperationOptions): Promise<PairingLookup> {
    const id = parseInput(identifierSchema, pairingId, "Pairing id");
    return this.request({
      method: "GET",
      path: `v1/pairings/${encodeURIComponent(id)}/preview`,
      auth: { kind: "access" },
      responseSchema: pairingLookupSchema,
      options,
    });
  }

  getPairingStatus(
    pairing: Pick<PairingChallenge, "pairingId" | "pollingToken">,
    options?: TransportOperationOptions,
  ): Promise<PairingStatus> {
    const reference = parseInput(pairingReferenceSchema, pairing, "Pairing reference");
    return this.request({
      method: "GET",
      path: `v1/pairings/${encodeURIComponent(reference.pairingId)}`,
      auth: { kind: "polling", token: reference.pollingToken },
      responseSchema: pairingStatusSchema,
      options,
    });
  }

  approvePairing(
    pairingId: string,
    input: PairingApprovalInput,
    options?: TransportOperationOptions,
  ): Promise<void> {
    const id = parseInput(identifierSchema, pairingId, "Pairing id");
    const body = parseInput(pairingApprovalInputSchema, input, "Pairing approval input");
    return this.requestAcknowledgement({
      method: "POST",
      path: `v1/pairings/${encodeURIComponent(id)}/approve`,
      auth: { kind: "access" },
      body,
      options,
    });
  }

  rejectPairing(pairingId: string, options?: TransportOperationOptions): Promise<void> {
    const id = parseInput(identifierSchema, pairingId, "Pairing id");
    return this.requestAcknowledgement({
      method: "POST",
      path: `v1/pairings/${encodeURIComponent(id)}/reject`,
      auth: { kind: "access" },
      options,
    });
  }

  cancelPairing(
    pairing: Pick<PairingChallenge, "pairingId" | "pollingToken">,
    options?: TransportOperationOptions,
  ): Promise<void> {
    const reference = parseInput(pairingReferenceSchema, pairing, "Pairing reference");
    return this.requestAcknowledgement({
      method: "DELETE",
      path: `v1/pairings/${encodeURIComponent(reference.pairingId)}`,
      auth: { kind: "polling", token: reference.pollingToken },
      options,
    });
  }

  listHosts(options?: TransportOperationOptions): Promise<RemoteHost[]> {
    return this.request({
      method: "GET",
      path: "v1/hosts",
      auth: { kind: "access" },
      responseSchema: z.array(remoteHostSchema).max(10_000),
      options,
    });
  }

  revokeHost(hostId: string, options?: TransportOperationOptions): Promise<void> {
    const id = parseInput(identifierSchema, hostId, "Host id");
    return this.requestAcknowledgement({
      method: "DELETE",
      path: `v1/hosts/${encodeURIComponent(id)}`,
      auth: { kind: "access" },
      options,
    });
  }

  createConnectionTicket(
    input: ConnectionTicketRequest,
    options?: TransportOperationOptions,
  ): Promise<ConnectionTicket> {
    const body = parseInput(connectionTicketRequestSchema, input, "Connection ticket request");
    return this.request({
      method: "POST",
      path: "v1/connection-tickets",
      auth: { kind: "access" },
      body,
      responseSchema: connectionTicketSchema,
      options,
    });
  }

  async waitForPairing(
    challengeInput: PairingChallenge,
    options: WaitForPairingOptions = {},
  ): Promise<ApprovedPairingStatus> {
    const challenge = parseInput(pairingChallengeSchema, challengeInput, "Pairing challenge");
    const scope = createAbortScope(options.signal, options.timeoutMs);
    let expiresAt = Date.parse(challenge.expiresAt);
    let intervalMs = challenge.intervalSeconds * 1000;

    try {
      for (;;) {
        const remainingMs = expiresAt - this.now();
        if (remainingMs <= 0) {
          throw pairingTerminalError("expired");
        }

        try {
          await raceWithAbort(this.sleep(Math.min(intervalMs, remainingMs), scope.signal), scope);
        } catch {
          if (scope.signal.aborted) {
            throw abortError(scope);
          }
          throw new OrbisTransportError("network", "Pairing polling could not be scheduled", {
            retryable: true,
          });
        }

        if (this.now() >= expiresAt) {
          throw pairingTerminalError("expired");
        }

        const status = await this.getPairingStatus(challenge, { signal: scope.signal });
        if (status.status === "approved") {
          return status;
        }
        if (status.status !== "pending") {
          throw pairingTerminalError(status.status);
        }

        expiresAt = Math.min(expiresAt, Date.parse(status.expiresAt));
        intervalMs = (status.intervalSeconds ?? intervalMs / 1000) * 1000;
      }
    } catch (error) {
      if (error instanceof OrbisTransportError) {
        throw error;
      }
      if (scope.signal.aborted) {
        throw abortError(scope);
      }
      throw error;
    } finally {
      scope.dispose();
    }
  }

  private async requestAcknowledgement(
    configuration: Omit<RequestConfiguration<{ ok: true }>, "responseSchema">,
  ): Promise<void> {
    await this.request({
      ...configuration,
      responseSchema: serverAcknowledgementSchema,
      allowEmptyAcknowledgement: true,
    });
  }

  private async request<T>(configuration: RequestConfiguration<T>): Promise<T> {
    const timeoutMs = configuration.options?.timeoutMs ?? this.requestTimeoutMs;
    const scope = createAbortScope(configuration.options?.signal, timeoutMs);

    try {
      const headers = new Headers({
        Accept: "application/json",
        "X-Orbis-Protocol-Version": String(ORBIS_TRANSPORT_PROTOCOL_VERSION),
      });

      if (configuration.body !== undefined) {
        headers.set("Content-Type", "application/json");
      }

      if (configuration.auth.kind === "access") {
        const token = await this.resolveAccessToken(scope);
        headers.set("Authorization", `Bearer ${token}`);
      } else if (configuration.auth.kind === "polling") {
        const token = validateHeaderCredential(configuration.auth.token, "Pairing polling token");
        headers.set("Authorization", `Pairing ${token}`);
      }

      const url = new URL(configuration.path, this.baseUrlValue);
      let response: Response;
      try {
        response = await raceWithAbort(
          this.fetchImplementation(url, {
            method: configuration.method,
            headers,
            body: configuration.body === undefined ? undefined : JSON.stringify(configuration.body),
            redirect: "error",
            signal: scope.signal,
          }),
          scope,
        );
      } catch {
        if (scope.signal.aborted) {
          throw abortError(scope);
        }
        throw new OrbisTransportError("network", "The remote server could not be reached", {
          retryable: true,
        });
      }

      let bodyText: string;
      let bodyTruncated: boolean;
      try {
        ({ text: bodyText, truncated: bodyTruncated } = await this.readResponseText(
          response,
          scope,
        ));
      } catch {
        if (scope.signal.aborted) {
          throw abortError(scope);
        }
        throw new OrbisTransportError("network", "The remote response could not be read", {
          retryable: true,
        });
      }

      if (!response.ok) {
        this.throwHttpError(response, bodyText);
      }
      if (bodyTruncated) {
        throw new OrbisTransportError("protocol", "The remote response exceeded the size limit");
      }
      if (bodyText.length === 0 && configuration.allowEmptyAcknowledgement) {
        return { ok: true } as T;
      }

      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw new OrbisTransportError("protocol", "The remote response was not valid JSON");
      }

      const result = configuration.responseSchema.safeParse(body);
      if (!result.success) {
        throw new OrbisTransportError(
          "protocol",
          "The remote response did not match the Orbis protocol",
        );
      }

      return result.data;
    } catch (error) {
      if (error instanceof OrbisTransportError) {
        throw error;
      }
      if (scope.signal.aborted) {
        throw abortError(scope);
      }
      throw error;
    } finally {
      scope.dispose();
    }
  }

  /**
   * Reads a response body while enforcing `maxResponseBytes`, so an oversized body is never
   * fully buffered in memory. The declared `Content-Length` is rejected before any read; a
   * streamed body is read chunk by chunk and cancelled as soon as the byte cap is exceeded.
   * Runtimes without a readable body stream (some React Native fetch implementations) fall
   * back to `response.text()` with a post-hoc size check.
   */
  private async readResponseText(
    response: Response,
    scope: ReturnType<typeof createAbortScope>,
  ): Promise<{ text: string; truncated: boolean }> {
    const declaredContentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredContentLength) && declaredContentLength > this.maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { text: "", truncated: true };
    }

    const stream = response.body;
    if (stream && typeof stream.getReader === "function") {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let totalBytes = 0;
      try {
        for (;;) {
          const result = await raceWithAbort(reader.read(), scope);
          if (result.done) {
            break;
          }
          totalBytes += result.value.byteLength;
          if (totalBytes > this.maxResponseBytes) {
            await reader.cancel().catch(() => undefined);
            return { text: "", truncated: true };
          }
          chunks.push(decoder.decode(result.value, { stream: true }));
        }
        chunks.push(decoder.decode());
        return { text: chunks.join(""), truncated: false };
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      }
    }

    const text = await raceWithAbort(response.text(), scope);
    if (responseByteLength(text) > this.maxResponseBytes) {
      return { text: "", truncated: true };
    }
    return { text, truncated: false };
  }

  private async resolveAccessToken(scope: ReturnType<typeof createAbortScope>): Promise<string> {
    if (!this.accessTokenProvider) {
      throw new OrbisTransportError(
        "authentication",
        "This operation requires an access token provider",
      );
    }

    let token: string | null | undefined;
    try {
      token = await raceWithAbort(
        Promise.resolve(
          this.accessTokenProvider({
            signal: scope.signal,
            serverUrl: this.baseUrlValue.toString(),
          }),
        ),
        scope,
      );
    } catch {
      if (scope.signal.aborted) {
        throw abortError(scope);
      }
      throw new OrbisTransportError("authentication", "The access token could not be obtained");
    }

    return validateHeaderCredential(token ?? "", "Access token");
  }

  private throwHttpError(response: Response, bodyText: string): never {
    const parsed =
      responseByteLength(bodyText) <= this.maxResponseBytes
        ? serverErrorResponseSchema.safeParse(
            (() => {
              try {
                return JSON.parse(bodyText);
              } catch {
                return undefined;
              }
            })(),
          )
        : undefined;

    const serverError = parsed?.success ? parsed.data.error : undefined;
    const retryAfterMs = serverError?.retryAfterMs ?? retryAfterFromHeader(response, this.now());
    const retryable = serverError?.retryable ?? (response.status === 429 || response.status >= 500);
    const code = response.status === 401 || response.status === 403 ? "authentication" : "http";

    throw new OrbisTransportError(
      code,
      `The remote server rejected the request (HTTP ${response.status})`,
      {
        status: response.status,
        serverCode: serverError?.code,
        retryable,
        retryAfterMs,
      },
    );
  }
}
