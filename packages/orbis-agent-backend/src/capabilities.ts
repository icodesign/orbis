import { AgentBackendError } from "./errors";
import { agentDriverId, type AgentDriverId } from "./identifiers";

export const AGENT_DRIVER_CAPABILITIES = [
  "input.attachments",
  "model.select",
  "permission.respond",
  "plan.select",
  "prompt.follow_up",
  "prompt.references.files",
  "prompt.references.sessions",
  "prompt.steer",
  "question.respond",
  "run.cancel",
  "session.create",
  "session.dispose",
  "session.fork",
  "session.list",
  "session.read",
  "session.resume",
  "session.subagents.list",
  "thinking.select",
  "workspace.open",
  "workspace.select",
] as const;

export type AgentDriverCapability = (typeof AGENT_DRIVER_CAPABILITIES)[number];

/** Display-safe availability for a driver that is known to the backend. */
export interface AgentDriverAvailability {
  readonly available: boolean;
  readonly reason?: string;
  readonly unsupportedCapabilities?: readonly AgentDriverCapability[];
}

export interface AgentDriverAvailabilityInput {
  readonly available: boolean;
  readonly reason?: string;
  readonly unsupportedCapabilities?: readonly AgentDriverCapability[];
}

export interface AgentDriverDescriptor {
  readonly availability: AgentDriverAvailability;
  readonly capabilities: readonly AgentDriverCapability[];
  readonly displayName: string;
  readonly id: AgentDriverId;
  readonly version?: string;
}

export interface AgentDriverDescriptorInput {
  readonly availability?: AgentDriverAvailabilityInput;
  readonly capabilities: readonly AgentDriverCapability[];
  readonly displayName: string;
  readonly id: string;
  readonly version?: string;
}

function displayValue(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new AgentBackendError("invalid_argument", `${label} is invalid`);
  }
  return normalized;
}

function capabilityList(
  values: readonly AgentDriverCapability[],
  label: string,
): AgentDriverCapability[] {
  const capabilities = [...new Set(values)];
  if (capabilities.length !== values.length) {
    throw new AgentBackendError("invalid_argument", `${label} must be unique`);
  }
  if (capabilities.some((capability) => !AGENT_DRIVER_CAPABILITIES.includes(capability))) {
    throw new AgentBackendError("invalid_argument", `${label} contains an unknown capability`);
  }
  return capabilities;
}

function availability(input: AgentDriverAvailabilityInput | undefined): AgentDriverAvailability {
  if (input === undefined) return { available: true };

  const unsupportedCapabilities = capabilityList(
    input.unsupportedCapabilities ?? [],
    "Unavailable capabilities",
  );
  if (input.available && (input.reason !== undefined || unsupportedCapabilities.length > 0)) {
    throw new AgentBackendError(
      "invalid_argument",
      "An available driver cannot report unavailable details",
    );
  }
  if (!input.available && input.reason === undefined) {
    throw new AgentBackendError("invalid_argument", "An unavailable driver requires a reason");
  }

  return {
    available: input.available,
    ...(input.reason === undefined
      ? {}
      : { reason: displayValue(input.reason, "Driver unavailable reason", 512) }),
    ...(unsupportedCapabilities.length === 0 ? {} : { unsupportedCapabilities }),
  };
}

export function createAgentDriverDescriptor(
  input: AgentDriverDescriptorInput,
): AgentDriverDescriptor {
  const capabilities = capabilityList(input.capabilities, "Driver capabilities");

  return {
    availability: availability(input.availability),
    capabilities,
    displayName: displayValue(input.displayName, "Driver display name", 256),
    id: agentDriverId(input.id),
    ...(input.version === undefined
      ? {}
      : { version: displayValue(input.version, "Driver version", 128) }),
  };
}

export function hasAgentDriverCapability(
  descriptor: AgentDriverDescriptor,
  capability: AgentDriverCapability,
): boolean {
  return descriptor.capabilities.includes(capability);
}
