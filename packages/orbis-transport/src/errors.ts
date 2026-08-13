export type OrbisTransportErrorCode =
  | "aborted"
  | "authentication"
  | "closed"
  | "http"
  | "insecure_transport"
  | "invalid_argument"
  | "network"
  | "pairing_terminal"
  | "protocol"
  | "remote_request"
  | "timeout"
  | "websocket";

export interface OrbisTransportErrorOptions {
  retryable?: boolean;
  retryAfterMs?: number;
  serverCode?: string;
  status?: number;
}

/**
 * A redacted error safe to surface outside the transport package.
 *
 * Raw response bodies, access tokens, pairing secrets, and connection tickets are
 * deliberately never stored on this object.
 */
export class OrbisTransportError extends Error {
  readonly code: OrbisTransportErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly serverCode?: string;
  readonly status?: number;

  constructor(
    code: OrbisTransportErrorCode,
    message: string,
    options: OrbisTransportErrorOptions = {},
  ) {
    super(message);
    this.name = "OrbisTransportError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.serverCode = options.serverCode;
    this.status = options.status;
  }
}

export function isOrbisTransportError(error: unknown): error is OrbisTransportError {
  return error instanceof OrbisTransportError;
}
