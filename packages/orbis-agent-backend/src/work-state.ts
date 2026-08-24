import { AgentBackendError } from "./errors";
import type { AgentGoal, AgentGoalBlockedReason, AgentTodoItem, AgentWorkState } from "./events";
import { agentTimestamp } from "./identifiers";

const MAX_WORK_TEXT_LENGTH = 65_536;
const MAX_TODO_TEXT_LENGTH = 2_048;
const MAX_TODO_COUNT = 256;

function invalid(message: string): never {
  throw new AgentBackendError("invalid_argument", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function displayText(value: unknown, label: string, max: number, multiline: boolean): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !value.trim()) {
    return invalid(`${label} is invalid`);
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code === 0x7f ||
      (code <= 0x1f && (!multiline || (code !== 0x09 && code !== 0x0a && code !== 0x0d)))
    ) {
      return invalid(`${label} is invalid`);
    }
  }
  return value;
}

function text(value: unknown, label: string): string {
  return displayText(value, label, MAX_WORK_TEXT_LENGTH, true);
}

function todoText(value: unknown, label: string): string {
  return displayText(value, label, MAX_TODO_TEXT_LENGTH, false);
}

function identifier(value: unknown, label: string): string {
  const result = todoText(value, label);
  if (result.length > 1024 || result !== result.trim()) return invalid(`${label} is invalid`);
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid(`${label} is invalid`);
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid(`${label} is invalid`);
  return value as number;
}

function blockedReason(value: unknown): AgentGoalBlockedReason {
  const input = record(value, "Goal blocked reason");
  return {
    code: identifier(input.code, "Goal blocked reason code"),
    message: text(input.message, "Goal blocked reason message"),
  };
}

function goal(value: unknown): AgentGoal {
  const input = record(value, "Goal");
  const phase = input.phase;
  if (phase !== "active" && phase !== "blocked" && phase !== "complete" && phase !== "paused") {
    return invalid("Goal phase is invalid");
  }
  const hasBlockedReason = input.blockedReason !== undefined;
  if (phase === "blocked" && !hasBlockedReason) return invalid("Blocked goals require a reason");
  if (phase !== "blocked" && hasBlockedReason)
    return invalid("Only blocked goals may have a reason");
  return {
    ...(hasBlockedReason ? { blockedReason: blockedReason(input.blockedReason) } : {}),
    createdAt: agentTimestamp(
      typeof input.createdAt === "string"
        ? input.createdAt
        : invalid("Goal created time is invalid"),
    ),
    id: identifier(input.id, "Goal id"),
    maxGoalRounds: positiveInteger(input.maxGoalRounds, "Goal max rounds"),
    objective: text(input.objective, "Goal objective"),
    phase,
    revision: positiveInteger(input.revision, "Goal revision"),
    roundsStarted: nonNegativeInteger(input.roundsStarted, "Goal started rounds"),
    updatedAt: agentTimestamp(
      typeof input.updatedAt === "string"
        ? input.updatedAt
        : invalid("Goal updated time is invalid"),
    ),
  };
}

function todo(value: unknown): AgentTodoItem {
  const input = record(value, "Todo item");
  const status = input.status;
  if (status !== "pending" && status !== "in_progress" && status !== "completed") {
    return invalid("Todo status is invalid");
  }
  return { content: todoText(input.content, "Todo content"), status };
}

export function validateAgentGoal(value: unknown): AgentGoal {
  return goal(value);
}

export function validateAgentTodoItem(value: unknown): AgentTodoItem {
  return todo(value);
}

/** Validate a complete goal/todo snapshot; no incremental native fields enter the contract. */
export function validateAgentWorkState(value: unknown): AgentWorkState {
  const input = record(value, "Work state");
  if (!Array.isArray(input.todos) || input.todos.length > MAX_TODO_COUNT) {
    return invalid("Work state todos are invalid");
  }
  const todos = input.todos.map(todo);
  if (new Set(todos.map((item) => item.content)).size !== todos.length) {
    return invalid("Todo contents must be unique");
  }
  return {
    goal: input.goal === null ? null : goal(input.goal),
    todos,
  };
}
