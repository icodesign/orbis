import type { AgentPromptReferenceSyntax } from "./capabilities";
import { AgentBackendError } from "./errors";
import {
  agentDriverId,
  createAgentSessionRef,
  type AgentDriverId,
  type AgentSessionRef,
} from "./identifiers";

export type AgentPromptReferenceSource = "files" | "sessions";

interface AgentPromptReferenceCompletionRequest {
  readonly cursor: number;
  readonly limit: number;
  readonly signal?: AbortSignal;
  readonly source: AgentPromptReferenceSource;
  readonly text: string;
}

export type AgentPromptReferenceCompletionInput = AgentPromptReferenceCompletionRequest &
  (
    | {
        readonly ref: AgentSessionRef;
      }
    | {
        readonly driverId: AgentDriverId;
        readonly workspaceRef: string;
      }
  );

export type AgentPromptReferenceCandidateKind = "directory" | "file" | "session";

export interface AgentPromptReferenceCandidate {
  readonly detail?: string;
  readonly insertText: string;
  readonly kind: AgentPromptReferenceCandidateKind;
  readonly label: string;
}

export interface AgentPromptReferenceCompletionResult {
  readonly candidates: readonly AgentPromptReferenceCandidate[];
  readonly end: number;
  readonly start: number;
}

export const AGENT_PROMPT_REFERENCE_MAX_TEXT_LENGTH = 65_536;
export const AGENT_PROMPT_REFERENCE_MAX_LIMIT = 64;
export const AGENT_PROMPT_REFERENCE_MAX_CANDIDATES = 64;
export const AGENT_PROMPT_REFERENCE_MAX_LABEL_LENGTH = 512;
export const AGENT_PROMPT_REFERENCE_MAX_DETAIL_LENGTH = 2_048;
export const AGENT_PROMPT_REFERENCE_MAX_INSERT_TEXT_LENGTH = 4_096;
export const AGENT_PROMPT_REFERENCE_MAX_WORKSPACE_REF_LENGTH = 2_048;

/**
 * Returns whether the cursor ends an active token for the syntax advertised by
 * the driver. The at-token grammar intentionally excludes embedded addresses
 * such as `name@example.com` and only recognizes tokens at a line boundary or
 * after whitespace.
 */
export function isAgentPromptReferenceActive(input: {
  readonly cursor: number;
  readonly syntax: AgentPromptReferenceSyntax;
  readonly text: string;
}): boolean {
  const lineStart = input.text.lastIndexOf("\n", input.cursor - 1) + 1;
  const beforeCursor = input.text.slice(lineStart, input.cursor);
  if (input.syntax === "at-token") {
    return /(?:^|\s)(?:@"[^"]*|@[^\s]*)$/u.test(beforeCursor);
  }
  return false;
}

function invalid(message: string): never {
  throw new AgentBackendError("invalid_argument", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function hasUnsafeControl(value: string, multiline: boolean): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 0x7f || (code <= 0x1f && (!multiline || ![0x09, 0x0a, 0x0d].includes(code)))) {
      return true;
    }
  }
  return false;
}

function text(value: unknown, label: string, max: number, multiline: boolean): string {
  if (typeof value !== "string" || value.length > max || hasUnsafeControl(value, multiline)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function display(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    hasUnsafeControl(value, false)
  ) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function position(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function source(value: unknown): AgentPromptReferenceSource {
  if (value !== "files" && value !== "sessions") return invalid("Reference source is invalid");
  return value;
}

function ref(value: unknown): AgentSessionRef {
  const input = record(value, "Reference completion session ref");
  if (
    typeof input.backendId !== "string" ||
    typeof input.driverId !== "string" ||
    typeof input.nativeSessionId !== "string" ||
    typeof input.sessionId !== "string"
  ) {
    return invalid("Reference completion session ref is invalid");
  }
  return createAgentSessionRef({
    backendId: input.backendId,
    driverId: input.driverId,
    nativeSessionId: input.nativeSessionId,
    sessionId: input.sessionId,
  });
}

function kind(value: unknown): AgentPromptReferenceCandidateKind {
  if (value !== "file" && value !== "directory" && value !== "session") {
    return invalid("Reference candidate kind is invalid");
  }
  return value;
}

function candidate(value: unknown): AgentPromptReferenceCandidate {
  const input = record(value, "Reference candidate");
  return {
    ...(input.detail === undefined
      ? {}
      : {
          detail: display(
            input.detail,
            "Reference candidate detail",
            AGENT_PROMPT_REFERENCE_MAX_DETAIL_LENGTH,
          ),
        }),
    insertText: display(
      input.insertText,
      "Reference candidate insertion",
      AGENT_PROMPT_REFERENCE_MAX_INSERT_TEXT_LENGTH,
    ),
    kind: kind(input.kind),
    label: display(
      input.label,
      "Reference candidate label",
      AGENT_PROMPT_REFERENCE_MAX_LABEL_LENGTH,
    ),
  };
}

export function validateAgentPromptReferenceCompletionInput(
  value: unknown,
): AgentPromptReferenceCompletionInput {
  const input = record(value, "Reference completion input");
  const cursor = position(input.cursor, "Reference completion cursor");
  const limit = position(input.limit, "Reference completion limit");
  if (limit < 1 || limit > AGENT_PROMPT_REFERENCE_MAX_LIMIT) {
    return invalid("Reference completion limit is invalid");
  }
  const textValue = text(
    input.text,
    "Reference completion text",
    AGENT_PROMPT_REFERENCE_MAX_TEXT_LENGTH,
    true,
  );
  if (cursor > textValue.length) return invalid("Reference completion cursor is out of range");
  const request = {
    cursor,
    limit,
    signal: input.signal instanceof AbortSignal ? input.signal : undefined,
    source: source(input.source),
    text: textValue,
  };
  if (input.ref !== undefined) {
    if (input.driverId !== undefined || input.workspaceRef !== undefined) {
      return invalid("Reference completion target is ambiguous");
    }
    return { ...request, ref: ref(input.ref) };
  }
  if (typeof input.driverId !== "string" || input.workspaceRef === undefined) {
    return invalid("Reference completion target is invalid");
  }
  return {
    ...request,
    driverId: agentDriverId(input.driverId),
    workspaceRef: display(
      input.workspaceRef,
      "Reference completion workspace ref",
      AGENT_PROMPT_REFERENCE_MAX_WORKSPACE_REF_LENGTH,
    ),
  };
}

export function validateAgentPromptReferenceCompletionResult(
  value: unknown,
  input?: Pick<AgentPromptReferenceCompletionInput, "cursor" | "limit" | "source" | "text">,
): AgentPromptReferenceCompletionResult | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = record(value, "Reference completion result");
  const start = position(raw.start, "Reference completion start");
  const end = position(raw.end, "Reference completion end");
  const candidatesValue = raw.candidates;
  if (
    !Array.isArray(candidatesValue) ||
    candidatesValue.length > AGENT_PROMPT_REFERENCE_MAX_CANDIDATES
  ) {
    return invalid("Reference completion candidates are invalid");
  }
  const candidates = candidatesValue.map(candidate);
  if (input !== undefined) {
    if (start > end || end > input.cursor || end > input.text.length) {
      return invalid("Reference completion replacement range is invalid");
    }
    if (candidates.length > input.limit)
      return invalid("Reference completion exceeds the requested limit");
    const expectedKind =
      input.source === "files" ? new Set(["file", "directory"]) : new Set(["session"]);
    if (candidates.some((item) => !expectedKind.has(item.kind))) {
      return invalid("Reference completion candidate source is invalid");
    }
  } else if (start > end) {
    return invalid("Reference completion replacement range is invalid");
  }
  const insertions = new Set(candidates.map((item) => item.insertText));
  if (insertions.size !== candidates.length)
    return invalid("Reference completion candidates must be unique");
  return { candidates, end, start };
}
