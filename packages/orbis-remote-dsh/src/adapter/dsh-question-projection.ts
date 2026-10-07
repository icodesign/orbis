import {
  AgentBackendError,
  agentTimestamp,
  validateAgentQuestionRequest,
  validateAgentQuestionResponseForRequest,
  type AgentQuestionRequest,
  type AgentQuestionResponseInput,
  type AgentTimestamp,
} from "@orbisapp/orbis-agent-backend";

import type {
  DshQuestionAnswer,
  DshQuestionRequest,
  DshSessionEvent,
  DshSessionProjectionValues,
} from "./dsh-types";

export function dshQuestionRequestId(callId: string): string {
  return `orbis-dsh-question-call:${encodeURIComponent(callId)}`;
}

export function projectDshQuestionRequest(
  native: Pick<DshQuestionRequest, "questions">,
  requestId: string,
  requestedAt: AgentTimestamp,
): AgentQuestionRequest {
  const questions = native.questions.map((raw, questionIndex) => {
    if (typeof raw.id !== "string" || !raw.id.trim() || raw.id !== raw.id.trim()) {
      throw new AgentBackendError("protocol", "DSH question id is invalid");
    }
    if (typeof raw.question !== "string" || !raw.question.trim()) {
      throw new AgentBackendError("protocol", "DSH question text is invalid");
    }
    const nativeOptions = raw.options ?? [];
    if (!Array.isArray(nativeOptions)) {
      throw new AgentBackendError("protocol", "DSH question options are invalid");
    }
    const labels = new Set<string>();
    const options = nativeOptions.map((option, optionIndex) => {
      if (typeof option.label !== "string" || !option.label.trim()) {
        throw new AgentBackendError("protocol", "DSH question option is invalid");
      }
      if (labels.has(option.label)) {
        throw new AgentBackendError("protocol", "DSH question option labels must be unique");
      }
      labels.add(option.label);
      const optionId = `dsh-option-${questionIndex}-${optionIndex}`;
      return {
        ...(option.description === undefined ? {} : { description: option.description }),
        label: option.label,
        optionId,
      };
    });
    const intent =
      raw.intent === undefined
        ? undefined
        : (() => {
            if (raw.intent.kind !== "plan-review" || typeof raw.intent.approve !== "string") {
              throw new AgentBackendError("protocol", "DSH question intent is invalid");
            }
            const approveIndex = nativeOptions.findIndex(
              (option) => option.label === raw.intent?.approve,
            );
            if (approveIndex < 0) {
              throw new AgentBackendError(
                "protocol",
                "DSH plan-review intent references an unknown option",
              );
            }
            return {
              approveOptionId: `dsh-option-${questionIndex}-${approveIndex}`,
              kind: "plan-review" as const,
            };
          })();
    return {
      ...(raw.detail === undefined ? {} : { detail: raw.detail }),
      ...(raw.header === undefined ? {} : { header: raw.header }),
      ...(intent === undefined ? {} : { intent }),
      multiSelect: raw.multiSelect ?? false,
      options,
      question: raw.question,
      questionId: raw.id,
    };
  });
  return validateAgentQuestionRequest({
    questions,
    requestedAt,
    requestId,
  });
}

export function dshQuestionAnswer(
  request: AgentQuestionRequest,
  input: AgentQuestionResponseInput,
): DshQuestionAnswer {
  const validated = validateAgentQuestionResponseForRequest(input, request);
  if (validated.response.kind === "cancelled") {
    throw new AgentBackendError(
      "unsupported",
      "A continued question can be answered or skipped, but cannot be cancelled",
    );
  }
  const answers = validated.response.answers.map((answer) => ({
    ...(answer.customText === undefined ? {} : { custom: answer.customText }),
    id: answer.questionId,
    selected: answer.optionIds.map((optionId) => {
      const label = request.questions
        .find((question) => question.questionId === answer.questionId)
        ?.options.find((option) => option.optionId === optionId)?.label;
      if (label === undefined) {
        throw new AgentBackendError("protocol", "DSH question option mapping is invalid");
      }
      return label;
    }),
  }));
  return { answers };
}

/** Only native continued questions accept replies through userQuestions.answer. */
export function projectDshContinuedQuestions(
  values: DshSessionProjectionValues,
  eventForCall: (callId: string) => DshSessionEvent | undefined,
): readonly AgentQuestionRequest[] {
  return (values.userQuestions?.active ?? [])
    .filter((question) => question.state === "continued")
    .map((question) => {
      const event = eventForCall(question.callId);
      if (event === undefined || !Number.isFinite(event.time)) {
        throw new AgentBackendError("protocol", "DSH continued question has no recorded tool call");
      }
      return projectDshQuestionRequest(
        question,
        dshQuestionRequestId(question.callId),
        agentTimestamp(new Date(event.time).toISOString()),
      );
    });
}

export function isDshQuestionCall(event: DshSessionEvent, callId: string): boolean {
  if (event.type !== "tool/call" && event.type !== "tool/ptc-dispatch") return false;
  if (typeof event.data !== "object" || event.data === null) return false;
  const data = event.data as { readonly callId?: unknown; readonly subCallId?: unknown };
  return (event.type === "tool/call" ? data.callId : data.subCallId) === callId;
}
