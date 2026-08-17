import { AgentBackendError } from "./errors";
import type {
  AgentPermissionOption,
  AgentPermissionOptionKind,
  AgentPermissionRequest,
  AgentPermissionResponseInput,
} from "./events";
import { agentTimestamp } from "./identifiers";

const MAX_PERMISSION_TEXT_LENGTH = 1024;
const MAX_PERMISSION_OPTIONS = 16;

function invalid(message: string): never {
  throw new AgentBackendError("invalid_argument", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PERMISSION_TEXT_LENGTH ||
    value !== value.trim()
  ) {
    return invalid(`${label} is invalid`);
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return invalid(`${label} is invalid`);
  }
  return value;
}

function boundedDetail(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PERMISSION_TEXT_LENGTH
  ) {
    return invalid(`${label} is invalid`);
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return invalid(`${label} is invalid`);
    }
  }
  return value;
}

function optionKind(value: unknown): AgentPermissionOptionKind {
  if (
    value === "allow_always" ||
    value === "allow_once" ||
    value === "reject_always" ||
    value === "reject_once"
  ) {
    return value;
  }
  return invalid("Permission option kind is invalid");
}

function permissionOption(value: unknown): AgentPermissionOption {
  const input = record(value, "Permission option");
  return {
    kind: optionKind(input.kind),
    label: boundedString(input.label, "Permission option label"),
    optionId: boundedString(input.optionId, "Permission option id"),
  };
}

/** Validate and normalize a driver-owned permission request before it enters session state. */
export function validateAgentPermissionRequest(value: unknown): AgentPermissionRequest {
  const input = record(value, "Permission request");
  const rawOptions = input.options;
  if (
    !Array.isArray(rawOptions) ||
    rawOptions.length < 2 ||
    rawOptions.length > MAX_PERMISSION_OPTIONS
  ) {
    return invalid("Permission request options are invalid");
  }
  const options = rawOptions.map(permissionOption);
  const optionIds = new Set(options.map((option) => option.optionId));
  if (optionIds.size !== options.length) return invalid("Permission option ids must be unique");
  if (!options.some((option) => option.kind.startsWith("allow_"))) {
    return invalid("Permission request requires an allow option");
  }
  if (!options.some((option) => option.kind.startsWith("reject_"))) {
    return invalid("Permission request requires a reject option");
  }

  const requestedAt = input.requestedAt;
  if (typeof requestedAt !== "string") return invalid("Permission request timestamp is invalid");
  return {
    ...(input.callId === undefined
      ? {}
      : { callId: boundedString(input.callId, "Permission call id") }),
    ...(input.detail === undefined
      ? {}
      : { detail: boundedDetail(input.detail, "Permission detail") }),
    options,
    requestedAt: agentTimestamp(requestedAt),
    requestId: boundedString(input.requestId, "Permission request id"),
    title: boundedString(input.title, "Permission title"),
  };
}

/** Validate a local or remote response without looking up the pending request. */
export function validateAgentPermissionResponseInput(value: unknown): AgentPermissionResponseInput {
  const input = record(value, "Permission response");
  return {
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: boundedString(input.idempotencyKey, "Permission idempotency key") }),
    optionId: boundedString(input.optionId, "Permission option id"),
    requestId: boundedString(input.requestId, "Permission request id"),
  };
}
