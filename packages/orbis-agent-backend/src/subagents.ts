import { AgentBackendError } from "./errors";
import {
  createAgentSessionRef,
  isSameAgentSessionRef,
  agentSessionLocatorKey,
  type AgentSessionRef,
} from "./identifiers";

export type AgentSessionSubagentActivity = "inactive" | "running";
export type AgentSessionSubagentMode = "continuable" | "one-shot";
export type AgentSessionSubagentDiagnosticReason = "corrupt" | "unavailable" | "unsupported";

interface AgentSessionSubagentIdentity {
  readonly depth: number;
  readonly parentRef: AgentSessionRef;
  readonly ref: AgentSessionRef;
}

export type AgentSessionSubagentChild = AgentSessionSubagentIdentity & {
  readonly activity: AgentSessionSubagentActivity;
  readonly hasChildren: boolean;
  readonly kind: "child";
} & (
    | { readonly label?: string; readonly mode: "one-shot" }
    | { readonly label: string; readonly mode: "continuable" }
  );

export type AgentSessionSubagentDiagnostic = AgentSessionSubagentIdentity & {
  readonly kind: "diagnostic";
  readonly reason: AgentSessionSubagentDiagnosticReason;
};

/** One stable pre-order row returned by a backend-owned subagent listing. */
export type AgentSessionSubagentEntry =
  | AgentSessionSubagentChild
  | AgentSessionSubagentDiagnostic;

export const AGENT_SESSION_SUBAGENT_MAX_ENTRIES = 1024;
export const AGENT_SESSION_SUBAGENT_MAX_DEPTH = 1024;
export const AGENT_SESSION_SUBAGENT_MAX_LABEL_LENGTH = 512;

function invalid(message: string): never {
  throw new AgentBackendError("invalid_argument", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function display(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > AGENT_SESSION_SUBAGENT_MAX_LABEL_LENGTH ||
    value !== value.trim() ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function sessionRef(value: unknown, label: string): AgentSessionRef {
  const input = record(value, label);
  if (
    typeof input.backendId !== "string" ||
    typeof input.driverId !== "string" ||
    typeof input.nativeSessionId !== "string" ||
    typeof input.sessionId !== "string"
  ) {
    return invalid(`${label} is invalid`);
  }
  const ref = createAgentSessionRef({
    backendId: input.backendId,
    driverId: input.driverId,
    nativeSessionId: input.nativeSessionId,
    sessionId: input.sessionId,
  });
  return ref;
}

function depth(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > AGENT_SESSION_SUBAGENT_MAX_DEPTH
  ) {
    return invalid("Subagent depth is invalid");
  }
  return value as number;
}

function activity(value: unknown): AgentSessionSubagentActivity {
  if (value !== "running" && value !== "inactive") {
    return invalid("Subagent activity is invalid");
  }
  return value;
}

function mode(value: unknown): AgentSessionSubagentMode {
  if (value !== "one-shot" && value !== "continuable") {
    return invalid("Subagent mode is invalid");
  }
  return value;
}

function reason(value: unknown): AgentSessionSubagentDiagnosticReason {
  if (value !== "corrupt" && value !== "unavailable" && value !== "unsupported") {
    return invalid("Subagent diagnostic reason is invalid");
  }
  return value;
}

export function validateAgentSessionSubagentEntry(
  value: unknown,
): AgentSessionSubagentEntry {
  const input = record(value, "Subagent entry");
  const ref = sessionRef(input.ref, "Subagent ref");
  const parentRef = sessionRef(input.parentRef, "Subagent parent ref");
  if (isSameAgentSessionRef(ref, parentRef)) {
    return invalid("Subagent ref and parent ref must differ");
  }
  const entryDepth = depth(input.depth);
  if (input.kind === "diagnostic") {
    return {
      depth: entryDepth,
      kind: "diagnostic",
      parentRef,
      reason: reason(input.reason),
      ref,
    };
  }
  if (input.kind !== "child") return invalid("Subagent entry kind is invalid");
  const entryMode = mode(input.mode);
  const label = input.label === undefined ? undefined : display(input.label, "Subagent label");
  if (entryMode === "continuable" && label === undefined) {
    return invalid("Continuable subagents require a label");
  }
  if (typeof input.activity !== "string") return invalid("Subagent activity is invalid");
  if (typeof input.hasChildren !== "boolean") return invalid("Subagent hasChildren is invalid");
  return {
    activity: activity(input.activity),
    depth: entryDepth,
    hasChildren: input.hasChildren,
    kind: "child",
    ...(label === undefined ? {} : { label }),
    mode: entryMode,
    parentRef,
    ref,
  } as AgentSessionSubagentChild;
}

/** Validates and preserves the backend's stable pre-order entry sequence. */
export function validateAgentSessionSubagentList(
  value: unknown,
  rootRef: AgentSessionRef,
): readonly AgentSessionSubagentEntry[] {
  if (!Array.isArray(value) || value.length > AGENT_SESSION_SUBAGENT_MAX_ENTRIES) {
    return invalid("Subagent list is invalid");
  }
  const validatedRoot = sessionRef(rootRef, "Subagent root ref");
  const rootKey = agentSessionLocatorKey(validatedRoot);
  const seen = new Set<string>();
  const seenChildren = new Map<string, number>();
  const entries = value.map((entry) => {
    const validated = validateAgentSessionSubagentEntry(entry);
    const key = agentSessionLocatorKey(validated.ref);
    if (seen.has(key)) return invalid("Subagent list contains duplicate refs");
    if (key === rootKey) return invalid("Subagent list contains its root ref");
    if (
      validated.ref.backendId !== validatedRoot.backendId ||
      validated.ref.driverId !== validatedRoot.driverId ||
      validated.parentRef.backendId !== validatedRoot.backendId ||
      validated.parentRef.driverId !== validatedRoot.driverId
    ) {
      return invalid("Subagent list contains a foreign backend or driver ref");
    }
    if (validated.depth === 1) {
      if (!isSameAgentSessionRef(validated.parentRef, validatedRoot)) {
        return invalid("Depth-one subagents must refer to the root ref");
      }
    } else {
      const parentDepth = seenChildren.get(agentSessionLocatorKey(validated.parentRef));
      if (parentDepth === undefined || validated.depth !== parentDepth + 1) {
        return invalid("Subagent list is not in stable pre-order");
      }
    }
    seen.add(key);
    if (validated.kind === "child") seenChildren.set(key, validated.depth);
    return validated;
  });
  return Object.freeze(entries);
}
