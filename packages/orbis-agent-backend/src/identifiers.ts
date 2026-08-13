import { AgentBackendError } from "./errors";

declare const agentBackendBrand: unique symbol;

type AgentBackendBrand<TValue, TName extends string> = TValue & {
  readonly [agentBackendBrand]: TName;
};

export type AgentBackendId = AgentBackendBrand<string, "AgentBackendId">;
export type AgentDeliveryCursor = AgentBackendBrand<number, "AgentDeliveryCursor">;
export type AgentDriverId = AgentBackendBrand<string, "AgentDriverId">;
export type AgentEntryId = AgentBackendBrand<string, "AgentEntryId">;
export type AgentEventId = AgentBackendBrand<string, "AgentEventId">;
export type AgentNativeSessionId = AgentBackendBrand<string, "AgentNativeSessionId">;
export type AgentRunId = AgentBackendBrand<string, "AgentRunId">;
export type AgentSessionId = AgentBackendBrand<string, "AgentSessionId">;
export type AgentTimestamp = AgentBackendBrand<string, "AgentTimestamp">;

const MAX_IDENTIFIER_LENGTH = 256;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function identifier(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value !== value.trim() ||
    containsControlCharacter(value)
  ) {
    throw new AgentBackendError("invalid_argument", `${label} is invalid`);
  }
  return value;
}

export function agentBackendId(value: string): AgentBackendId {
  return identifier(value, "Backend id") as AgentBackendId;
}

export function agentDriverId(value: string): AgentDriverId {
  return identifier(value, "Driver id") as AgentDriverId;
}

export function agentEntryId(value: string): AgentEntryId {
  return identifier(value, "Entry id") as AgentEntryId;
}

export function agentEventId(value: string): AgentEventId {
  return identifier(value, "Event id") as AgentEventId;
}

export function agentNativeSessionId(value: string): AgentNativeSessionId {
  return identifier(value, "Native session id") as AgentNativeSessionId;
}

export function agentRunId(value: string): AgentRunId {
  return identifier(value, "Run id") as AgentRunId;
}

export function agentSessionId(value: string): AgentSessionId {
  return identifier(value, "Session id") as AgentSessionId;
}

export function agentTimestamp(value: string): AgentTimestamp {
  if (value !== value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new AgentBackendError("invalid_argument", "Timestamp is invalid");
  }
  return value as AgentTimestamp;
}

/** A server-assigned delivery cursor. `0` denotes a snapshot with no durable event applied. */
export function agentDeliveryCursor(value: number): AgentDeliveryCursor {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentBackendError("invalid_argument", "Delivery cursor is invalid");
  }
  return value as AgentDeliveryCursor;
}

export function nextAgentDeliveryCursor(cursor: AgentDeliveryCursor): AgentDeliveryCursor {
  if (cursor >= Number.MAX_SAFE_INTEGER) {
    throw new AgentBackendError("protocol", "Delivery cursor is exhausted");
  }
  return agentDeliveryCursor(cursor + 1);
}

export interface AgentSessionRef {
  readonly backendId: AgentBackendId;
  readonly driverId: AgentDriverId;
  readonly nativeSessionId: AgentNativeSessionId;
  /** Stable product-facing route/catalog identity. */
  readonly sessionId: AgentSessionId;
}

export interface AgentSessionRefInput {
  backendId: string;
  driverId: string;
  nativeSessionId: string;
  sessionId: string;
}

export function createAgentSessionRef(input: AgentSessionRefInput): AgentSessionRef {
  return {
    backendId: agentBackendId(input.backendId),
    driverId: agentDriverId(input.driverId),
    nativeSessionId: agentNativeSessionId(input.nativeSessionId),
    sessionId: agentSessionId(input.sessionId),
  };
}

/**
 * Collision-free identity for maps/cache namespaces. Product routing should use
 * `sessionId`; this key represents the execution locator itself.
 */
export function agentSessionLocatorKey(ref: AgentSessionRef): string {
  return [ref.backendId, ref.driverId, ref.nativeSessionId]
    .map((value) => `${value.length}:${value}`)
    .join("|");
}

export function isSameAgentSessionRef(left: AgentSessionRef, right: AgentSessionRef): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.backendId === right.backendId &&
    left.driverId === right.driverId &&
    left.nativeSessionId === right.nativeSessionId
  );
}
