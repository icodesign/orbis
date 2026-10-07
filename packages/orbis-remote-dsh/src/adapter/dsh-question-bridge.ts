import {
  validateAgentQuestionResponseForRequest,
  type AgentQuestionRequest,
  type AgentQuestionResponseInput,
  type AgentQuestionResponseResult,
  type AgentTimestamp,
} from "@orbisapp/orbis-agent-backend";

import {
  dshQuestionAnswer,
  dshQuestionRequestId,
  projectDshQuestionRequest,
} from "./dsh-question-projection";
import type { DshQuestionAnswer, DshQuestionRequest, DshUserQuestions } from "./dsh-types";

interface PendingQuestion {
  readonly request: AgentQuestionRequest;
  readonly resolve: (answer: DshQuestionAnswer) => void;
  readonly reject: (reason: unknown) => void;
  readonly next: () => Promise<DshQuestionAnswer>;
  readonly release: () => void;
}

/** Owns only foreground waterfall promises; continued questions remain native state. */
export class DshQuestionBridge {
  private readonly pending = new Map<string, PendingQuestion>();

  constructor(
    private readonly nextRequestId: () => string,
    private readonly native: DshUserQuestions,
    private readonly onChanged: () => void,
  ) {}

  requested(
    native: DshQuestionRequest,
    next: () => Promise<DshQuestionAnswer>,
    requestedAt: AgentTimestamp,
  ): Promise<DshQuestionAnswer> {
    if (native.signal?.aborted) return Promise.reject(questionError("ASK_ABORTED"));
    const requestId =
      native.wait === undefined ? this.nextRequestId() : dshQuestionRequestId(native.wait.callId);
    const request = projectDshQuestionRequest(native, requestId, requestedAt);
    const claim = new AbortController();
    const result = new Promise<DshQuestionAnswer>((resolve, reject) => {
      const abort = () => this.reject(requestId, questionError("ASK_ABORTED"));
      native.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(requestId, {
        next,
        reject,
        request,
        resolve,
        release: () => {
          native.signal?.removeEventListener("abort", abort);
          claim.abort();
        },
      });
    });
    if (native.wait?.timed === true && native.agent !== undefined) {
      // The native stream claim stops the unattended host timer. Releasing the
      // final mobile subscriber releases this claim before desktop delegation.
      void this.holdWait(native.agent, native.wait.callId, claim.signal, requestId);
    }
    this.onChanged();
    return result;
  }

  async respond(input: AgentQuestionResponseInput): Promise<AgentQuestionResponseResult> {
    const pending = this.pending.get(input.requestId);
    if (pending === undefined) return { accepted: false };
    validateAgentQuestionResponseForRequest(input, pending.request);
    if (input.response.kind === "cancelled") {
      this.reject(input.requestId, questionError("ASK_CANCELLED"));
    } else {
      const answer = dshQuestionAnswer(pending.request, input);
      this.remove(input.requestId)?.resolve(answer);
    }
    return { accepted: true };
  }

  delegate(): void {
    for (const requestId of [...this.pending.keys()]) {
      const pending = this.remove(requestId);
      if (pending !== undefined) void pending.next().then(pending.resolve, pending.reject);
    }
  }

  snapshot(): readonly AgentQuestionRequest[] {
    return [...this.pending.values()].map(({ request }) => request);
  }

  private remove(requestId: string): PendingQuestion | undefined {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return undefined;
    this.pending.delete(requestId);
    pending.release();
    this.onChanged();
    return pending;
  }

  private reject(requestId: string, reason: unknown): void {
    this.remove(requestId)?.reject(reason);
  }

  private async holdWait(
    agent: NonNullable<DshQuestionRequest["agent"]>,
    callId: string,
    signal: AbortSignal,
    requestId: string,
  ): Promise<void> {
    try {
      for await (const _frame of this.native.attachWait(agent, callId, signal)) {
        // Consuming the business stream retains the claim until release/settlement.
      }
    } catch (error) {
      if (!signal.aborted) this.reject(requestId, error);
    }
  }
}

function questionError(code: "ASK_ABORTED" | "ASK_CANCELLED"): Error & { readonly code: string } {
  return Object.assign(new Error("The DSH user question was cancelled"), {
    code,
    name: "UserQuestionError",
  });
}
