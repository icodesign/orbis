import { AgentBackendError } from "./errors";
import type {
  AgentQuestionAnswerItem,
  AgentQuestionItem,
  AgentQuestionOption,
  AgentQuestionRequest,
  AgentQuestionResponseInput,
} from "./events";
import { agentTimestamp } from "./identifiers";

const MAX_QUESTION_TEXT_LENGTH = 2048;
const MAX_QUESTION_DETAIL_LENGTH = 65_536;
const MAX_QUESTION_COUNT = 32;
const MAX_QUESTION_OPTIONS = 32;

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

function id(value: unknown, label: string): string {
  const result = displayText(value, label, 1024, false);
  if (result !== result.trim()) return invalid(`${label} is invalid`);
  return result;
}

function text(value: unknown, label: string): string {
  return displayText(value, label, MAX_QUESTION_TEXT_LENGTH, true);
}

function singleLine(value: unknown, label: string): string {
  return displayText(value, label, MAX_QUESTION_TEXT_LENGTH, false);
}

function detail(value: unknown, label: string): string {
  return displayText(value, label, MAX_QUESTION_DETAIL_LENGTH, true);
}

function option(value: unknown): AgentQuestionOption {
  const input = record(value, "Question option");
  return {
    ...(input.description === undefined
      ? {}
      : { description: text(input.description, "Question option description") }),
    label: singleLine(input.label, "Question option label"),
    optionId: id(input.optionId, "Question option id"),
  };
}

function questionItem(value: unknown): AgentQuestionItem {
  const input = record(value, "Question item");
  const rawOptions = input.options;
  if (!Array.isArray(rawOptions) || rawOptions.length > MAX_QUESTION_OPTIONS) {
    return invalid("Question item options are invalid");
  }
  const options = rawOptions.map(option);
  if (new Set(options.map((item) => item.optionId)).size !== options.length) {
    return invalid("Question option ids must be unique");
  }
  const multiSelect = input.multiSelect;
  if (typeof multiSelect !== "boolean") return invalid("Question multi-select flag is invalid");

  let intent: AgentQuestionItem["intent"];
  if (input.intent !== undefined) {
    const rawIntent = record(input.intent, "Question intent");
    if (rawIntent.kind !== "plan-review") return invalid("Question intent is invalid");
    const approveOptionId = id(rawIntent.approveOptionId, "Question approve option id");
    if (!options.some((item) => item.optionId === approveOptionId)) {
      return invalid("Question approve option id must reference an option");
    }
    if (input.detail === undefined) return invalid("Plan-review questions require detail");
    intent = { approveOptionId, kind: "plan-review" };
  }

  return {
    ...(input.detail === undefined ? {} : { detail: detail(input.detail, "Question detail") }),
    ...(input.header === undefined ? {} : { header: singleLine(input.header, "Question header") }),
    ...(intent === undefined ? {} : { intent }),
    multiSelect,
    options,
    question: text(input.question, "Question text"),
    questionId: id(input.questionId, "Question id"),
  };
}

/** Validate and normalize a complete driver-owned Ask User request. */
export function validateAgentQuestionRequest(value: unknown): AgentQuestionRequest {
  const input = record(value, "Question request");
  if (
    !Array.isArray(input.questions) ||
    input.questions.length === 0 ||
    input.questions.length > MAX_QUESTION_COUNT
  ) {
    return invalid("Question request questions are invalid");
  }
  const questions = input.questions.map(questionItem);
  if (new Set(questions.map((item) => item.questionId)).size !== questions.length) {
    return invalid("Question ids must be unique");
  }
  if (typeof input.requestedAt !== "string")
    return invalid("Question request timestamp is invalid");
  return {
    questions,
    requestedAt: agentTimestamp(input.requestedAt),
    requestId: id(input.requestId, "Question request id"),
  };
}

function answerItem(value: unknown): AgentQuestionAnswerItem {
  const input = record(value, "Question answer");
  if (!Array.isArray(input.optionIds)) return invalid("Question answer option ids are invalid");
  const optionIds = input.optionIds.map((optionId) => id(optionId, "Question option id"));
  if (new Set(optionIds).size !== optionIds.length) {
    return invalid("Question answer option ids must be unique");
  }
  return {
    ...(input.customText === undefined
      ? {}
      : { customText: detail(input.customText, "Question custom text") }),
    optionIds,
    questionId: id(input.questionId, "Question id"),
  };
}

/** Validate response shape without resolving it against a pending request. */
export function validateAgentQuestionResponseInput(value: unknown): AgentQuestionResponseInput {
  const input = record(value, "Question response");
  const response = record(input.response, "Question response body");
  const kind = response.kind;
  if (kind === "cancelled") {
    return {
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: id(input.idempotencyKey, "Question idempotency key") }),
      requestId: id(input.requestId, "Question request id"),
      response: { kind },
    };
  }
  if (kind !== "answered" || !Array.isArray(response.answers)) {
    return invalid("Question response kind or answers are invalid");
  }
  const answers = response.answers.map(answerItem);
  if (new Set(answers.map((item) => item.questionId)).size !== answers.length) {
    return invalid("Question answer question ids must be unique");
  }
  return {
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: id(input.idempotencyKey, "Question idempotency key") }),
    requestId: id(input.requestId, "Question request id"),
    response: { answers, kind },
  };
}

/**
 * Resolve a response against the current full request. Answered responses must
 * include exactly one answer for every question and may only reference the
 * options advertised by that question. The returned answer order follows the
 * request order so reconnects and stores have one canonical representation.
 */
export function validateAgentQuestionResponseForRequest(
  value: unknown,
  request: AgentQuestionRequest,
): AgentQuestionResponseInput {
  const response = validateAgentQuestionResponseInput(value);
  if (response.requestId !== request.requestId)
    return invalid("Question request id does not match");
  if (response.response.kind === "cancelled") return response;

  const byId = new Map(request.questions.map((question) => [question.questionId, question]));
  const answerById = new Map(
    response.response.answers.map((answer) => [answer.questionId, answer]),
  );
  if (answerById.size !== request.questions.length) {
    return invalid("Question response must answer every question exactly once");
  }
  const answers = request.questions.map((question) => {
    const answer = answerById.get(question.questionId);
    if (answer === undefined || !byId.has(answer.questionId)) {
      return invalid("Question response must answer every question exactly once");
    }
    if (!question.multiSelect && answer.optionIds.length > 1) {
      return invalid("A single-select question cannot have multiple options");
    }
    if (!question.multiSelect && answer.optionIds.length > 0 && answer.customText !== undefined) {
      return invalid("A single-select question cannot combine options and custom text");
    }
    const optionIds = new Set(question.options.map((option) => option.optionId));
    if (answer.optionIds.some((optionId) => !optionIds.has(optionId))) {
      return invalid("Question response references an unknown option");
    }
    return answer;
  });
  return { ...response, response: { answers, kind: "answered" } };
}
