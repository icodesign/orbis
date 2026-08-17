export type AgentBackendErrorCode =
  | "closed"
  | "conflict"
  | "cursor_gap"
  | "cursor_conflict"
  | "invalid_argument"
  | "not_found"
  | "protocol"
  | "revision_conflict"
  | "unavailable"
  | "unsupported"
  | "version_unsupported";

export type AgentBackendErrorDetail = boolean | number | string;

export interface AgentBackendErrorOptions {
  details?: Readonly<Record<string, AgentBackendErrorDetail>>;
  retryable?: boolean;
}

/**
 * A domain error that can safely cross the backend/UI boundary. It deliberately
 * carries only caller-provided, display-safe details and never retains a raw
 * harness, provider, or transport error as its cause.
 */
export class AgentBackendError extends Error {
  readonly code: AgentBackendErrorCode;
  readonly details?: Readonly<Record<string, AgentBackendErrorDetail>>;
  readonly retryable: boolean;

  constructor(
    code: AgentBackendErrorCode,
    message: string,
    options: AgentBackendErrorOptions = {},
  ) {
    super(message);
    this.name = "AgentBackendError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

export function isAgentBackendError(error: unknown): error is AgentBackendError {
  return error instanceof AgentBackendError;
}
