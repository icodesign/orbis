import {
  AgentBackendError,
  agentDeliveryCursor,
  agentEntryId,
  agentEventId,
  agentRunId,
  agentSessionLocatorKey,
  agentTimestamp,
  createAgentBackendDescriptor,
  createAgentDriverDescriptor,
  createAgentSessionRef,
  isAgentBackendError,
  isSameAgentSessionRef,
  nextAgentDeliveryCursor,
  validateAgentQuestionRequest,
  validateAgentQuestionResponseForRequest,
  validateAgentSessionSubagentList,
  validateAgentPromptInput,
  validateAgentPromptReferenceCompletionInput,
  validateAgentPromptReferenceCompletionResult,
  validateAgentPermissionRequest,
  validateAgentPermissionResponseInput,
  type AgentBackend,
  type AgentAttachmentReadResult,
  type AgentBackendDescriptor,
  type AgentCancelInput,
  type AgentCancelResult,
  type AgentContentBlock,
  type AgentDriverDescriptor,
  type AgentDriverCapability,
  type AgentHarnessDriver,
  type AgentModelListInput,
  type AgentModelMetadata,
  type AgentQueuedInput,
  type AgentModelSelection,
  type AgentPermissionRequest,
  type AgentPermissionResponseInput,
  type AgentPermissionResponseResult,
  type AgentQuestionRequest,
  type AgentQuestionResponseInput,
  type AgentQuestionResponseResult,
  type AgentWorkState,
  type AgentJsonValue,
  type AgentWorkspaceDescriptor,
  type AgentWorkspaceBrowseInput,
  type AgentWorkspaceCreateFolderInput,
  type AgentWorkspaceFolderDescriptor,
  type AgentWorkspaceFolderListing,
  type AgentWorkspaceRegisterInput,
  type AgentWorkspaceRegisterResult,
  type AgentPromptInput,
  type AgentPromptContentBlock,
  type AgentPromptReceipt,
  type AgentPromptReferenceCompletionInput,
  type AgentPromptReferenceCompletionResult,
  type AgentRuntimeStatusListener,
  type AgentRuntimeStatus,
  type AgentSessionCreateInput,
  type AgentSessionConfigOption,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type AgentSessionProjection,
  type AgentSessionRecord,
  type AgentSessionRef,
  type AgentSessionRuntime,
  type AgentSessionSummary,
  type AgentSessionStatePatch,
  type AgentSessionSubagentEntry,
  type AgentSessionUpdateInput,
  type AgentSessionUpdateResult,
  type AgentTimestamp,
} from "@orbisapp/orbis-agent-backend";

import { DshDeltaCoalescer, type DshDeltaInput } from "./dsh-delta-coalescer";
import {
  DshSessionEntryProjector,
  dshEventIdentity,
  dshContentBlocks,
  dshJson,
  dshRunId,
  dshTimestamp,
  dshProjectionState,
  reduceDshProjectionState,
  metadataPatchForDshEvent,
  nextDshRunId,
  readDshSessionProjection,
  runFinishForDshEvent,
  runStartForDshEvent,
  titleForDshEvent,
} from "./dsh-projection";
import type {
  DshAgent,
  DshAgentInboxEvent,
  DshApprovalOutcome,
  DshApprovalRequest,
  DshImageAttachmentReference,
  DshContext,
  DshInteractionAvailability,
  DshModelTarget,
  DshQuestionAnswer,
  DshQuestionRequest,
  DshSession,
  DshSessionCatalogEntry,
  DshSessionEvent,
  DshSessionInspection,
  DshSessionPermissionProvider,
  DshSessionModeProvider,
  DshSessionSubagentProvider,
  DshSessionAttachmentPort,
  DshPromptReferenceProvider,
  DshUserMessageContent,
  DshUserMessage,
  DshWorkspace,
  DshWorkspaceId,
} from "./dsh-types";

export const DSH_LOCAL_DRIVER_ID = "dsh";

const DSH_LOCAL_CAPABILITIES = [
  "prompt.follow_up",
  "prompt.steer",
  "run.cancel",
  "session.create",
  "session.list",
  "session.read",
  "session.resume",
  "workspace.select",
] as const;

interface DshPermissionPending {
  readonly request: AgentPermissionRequest;
  readonly resolve: (outcome: DshApprovalOutcome) => void;
  readonly next: () => Promise<DshApprovalOutcome>;
  readonly removeAbort: () => void;
}

class DshPermissionInteraction {
  private readonly pending = new Map<string, DshPermissionPending>();

  constructor(
    private readonly nextRequestId: () => string,
    private readonly onChanged: (pending: readonly AgentPermissionRequest[]) => void,
  ) {}

  requested(
    native: DshApprovalRequest,
    next: () => Promise<DshApprovalOutcome>,
    requestedAt: AgentTimestamp,
  ): Promise<DshApprovalOutcome> {
    const requestId = this.nextRequestId();
    const request = validateAgentPermissionRequest({
      ...(native.callId === undefined ? {} : { callId: native.callId }),
      ...(native.reason === undefined ? {} : { detail: native.reason }),
      options: [
        { kind: "allow_once", label: "Allow once", optionId: "allow_once" },
        { kind: "reject_once", label: "Reject", optionId: "reject_once" },
      ],
      requestedAt,
      requestId,
      title: native.toolName,
    });
    const result = new Promise<DshApprovalOutcome>((resolve) => {
      const abort = () => this.finish(requestId, "cancelled");
      native.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(requestId, {
        next,
        removeAbort: () => native.signal?.removeEventListener("abort", abort),
        request,
        resolve,
      });
    });
    this.publish();
    return result;
  }

  async respond(input: AgentPermissionResponseInput): Promise<AgentPermissionResponseResult> {
    const validated = validateAgentPermissionResponseInput(input);
    const pending = this.pending.get(validated.requestId);
    if (pending === undefined) return { accepted: false };
    const option = pending.request.options.find(
      (candidate) => candidate.optionId === validated.optionId,
    );
    if (option === undefined) {
      throw new AgentBackendError(
        "invalid_argument",
        "Permission option is not valid for this request",
      );
    }
    this.finish(validated.requestId, option.kind === "allow_once" ? "allowed-once" : "rejected");
    return { accepted: true };
  }

  delegate(): void {
    for (const requestId of [...this.pending.keys()]) this.delegateOne(requestId);
  }

  snapshot(): readonly AgentPermissionRequest[] {
    return [...this.pending.values()].map((item) => item.request);
  }

  private publish(): void {
    this.onChanged(this.snapshot());
  }

  private finish(requestId: string, outcome: DshApprovalOutcome): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    pending.removeAbort();
    this.publish();
    pending.resolve(outcome);
  }

  private delegateOne(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    pending.removeAbort();
    this.publish();
    void pending.next().then(pending.resolve, () => pending.resolve("unavailable"));
  }
}

interface DshQuestionPending {
  readonly optionLabels: ReadonlyMap<string, string>;
  readonly request: AgentQuestionRequest;
  readonly resolve: (answer: DshQuestionAnswer) => void;
  readonly reject: (reason: unknown) => void;
  readonly next: () => Promise<DshQuestionAnswer>;
  readonly removeAbort: () => void;
}

/** Maps one DSH Ask User batch to the canonical, opaque-id question domain. */
class DshQuestionBridge {
  private readonly pending = new Map<string, DshQuestionPending>();

  constructor(
    private readonly nextRequestId: () => string,
    private readonly onChanged: (pending: readonly AgentQuestionRequest[]) => void,
  ) {}

  requested(
    native: DshQuestionRequest,
    next: () => Promise<DshQuestionAnswer>,
    requestedAt: AgentTimestamp,
  ): Promise<DshQuestionAnswer> {
    const requestId = this.nextRequestId();
    const optionLabels = new Map<string, string>();
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
        optionLabels.set(`${raw.id}\u0000${optionId}`, option.label);
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
    const request = validateAgentQuestionRequest({
      questions,
      requestedAt,
      requestId,
    });
    const result = new Promise<DshQuestionAnswer>((resolve, reject) => {
      const abort = () => this.reject(requestId, questionError("ASK_ABORTED"));
      native.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(requestId, {
        next,
        optionLabels,
        reject,
        removeAbort: () => native.signal?.removeEventListener("abort", abort),
        request,
        resolve,
      });
    });
    this.publish();
    return result;
  }

  async respond(input: AgentQuestionResponseInput): Promise<AgentQuestionResponseResult> {
    const pending = this.pending.get(input.requestId);
    if (pending === undefined) return { accepted: false };
    const validated = validateAgentQuestionResponseForRequest(input, pending.request);
    if (validated.response.kind === "cancelled") {
      this.reject(input.requestId, questionError("ASK_CANCELLED"));
      return { accepted: true };
    }
    const answers = validated.response.answers.map((answer) => ({
      ...(answer.customText === undefined ? {} : { custom: answer.customText }),
      id: answer.questionId,
      selected: answer.optionIds.map((optionId) => {
        const label = pending.optionLabels.get(`${answer.questionId}\u0000${optionId}`);
        if (label === undefined) {
          throw new AgentBackendError("protocol", "DSH question option mapping is invalid");
        }
        return label;
      }),
    }));
    this.finish(input.requestId, { answers });
    return { accepted: true };
  }

  delegate(): void {
    for (const requestId of [...this.pending.keys()]) this.delegateOne(requestId);
  }

  snapshot(): readonly AgentQuestionRequest[] {
    return [...this.pending.values()].map((item) => item.request);
  }

  private publish(): void {
    this.onChanged(this.snapshot());
  }

  private finish(requestId: string, answer: DshQuestionAnswer): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    pending.removeAbort();
    this.publish();
    pending.resolve(answer);
  }

  private reject(requestId: string, reason: unknown): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    pending.removeAbort();
    this.publish();
    pending.reject(reason);
  }

  private delegateOne(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    pending.removeAbort();
    this.publish();
    void pending.next().then(pending.resolve, pending.reject);
  }
}

function questionError(code: "ASK_ABORTED" | "ASK_CANCELLED"): Error & { readonly code: string } {
  return Object.assign(new Error("The DSH user question was cancelled"), {
    code,
    name: "UserQuestionError",
  });
}

export interface DshLocalBackendOptions {
  /** Defaults to the local product backend: `local` / `This device`. */
  readonly backend?: {
    readonly displayName?: string;
    readonly id?: string;
  };
  /** DSH Cordis services injected by the actual host bundle. */
  readonly context: DshContext;
  /**
   * DSH's lightweight durable catalog. The bundle owns its storage-specific
   * implementation so listing never has to replay every historical transcript.
   */
  readonly listSessionCatalog: () => Promise<readonly DshSessionCatalogEntry[]>;
  /** DSH's `createUserMessage`, injected from `@deepseek-ai/dsh-llm`. */
  readonly createUserMessage: (input: {
    readonly content: readonly DshUserMessageContent[];
    readonly source: { readonly kind: "user" };
  }) => DshUserMessage;
  /** Allows the composing host to provide a deterministic session-id source. */
  readonly createSessionId?: () => string;
  /** Defaults to the DSH product name. */
  readonly driver?: {
    readonly displayName?: string;
    readonly version?: string;
  };
  readonly now?: () => AgentTimestamp;
  readonly attachments?: DshSessionAttachmentPort;
  /** Authenticated Orbis presence; absent means DSH Web retains interaction ownership. */
  readonly interactionAvailability?: DshInteractionAvailability;
  /** DSH-owned @file/@session grammar and candidate discovery. */
  readonly promptReferences?: DshPromptReferenceProvider;
  readonly onError?: (error: AgentBackendError) => void;
  /** Receives the original DSH failure before it is mapped to a support-safe public error. */
  readonly onUpstreamError?: (error: unknown) => void;
  /** Optional composition seam for DSH's session permission preset service. */
  readonly permissionPresets?: DshSessionPermissionProvider;
  /** Optional composition seam for DSH's logged plan-mode service. */
  readonly planMode?: DshSessionModeProvider;
  /** Optional composition seam for DSH's authoritative subagent listing. */
  readonly subagents?: DshSessionSubagentProvider;
  /** DSH's branded `SessionId` constructor, injected from `@deepseek-ai/dsh-session`. */
  readonly toSessionId: (value: string) => unknown;
}

/**
 * A durable catalog row moved for a session outside this backend's controllers.
 * The signal deliberately carries no summary: DSH's catalog is the authority
 * and the observer re-reads it rather than trusting an event payload.
 */
export interface DshLocalCatalogChange {
  readonly ref: AgentSessionRef;
}

export type DshLocalCatalogListener = (change: DshLocalCatalogChange) => void;

interface DshLocalControllerHost {
  readonly driverDescriptor: AgentDriverDescriptor;
  readonly attachments?: DshSessionAttachmentPort;

  createUserMessage(content: readonly DshUserMessageContent[]): DshUserMessage;
  detachController(controller: DshLocalSessionController): void;
  inspect(ref: AgentSessionRef): Promise<DshSessionInspection>;
  readAttachment(
    ref: AgentSessionRef,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<AgentAttachmentReadResult>;
  isCurrentAgent(agent: DshAgent): boolean;
  now(): AgentTimestamp;
  readCurrentModel(ref: AgentSessionRef): Promise<AgentModelSelection | undefined>;
  report(error: AgentBackendError): void;
  reportUpstreamError(error: unknown): void;
  selectCurrentModel(
    ref: AgentSessionRef,
    selection: AgentModelSelection,
  ): Promise<AgentModelSelection>;
  permissionOptions(ref: AgentSessionRef): AgentSessionConfigOption | undefined;
  readonly planMode?: DshSessionModeProvider;
  readPlanMode(
    agent: DshAgent,
  ): { readonly active: boolean; readonly pending?: boolean } | undefined;
  setPlanMode(
    agent: DshAgent,
    active: boolean,
  ): Promise<"committed" | "queued" | "cancelled" | "noop">;
}

type DshInboxTarget = "next-step" | "next-turn";

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    binary += String.fromCharCode(...value.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function findDshAttachmentReference(
  events: readonly DshSessionEvent[],
  attachmentId: string,
): DshImageAttachmentReference | undefined {
  for (const event of events) {
    if (event.type !== "user/message") continue;
    const data = event.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
    const content = (data as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
      const image = block as Record<string, unknown>;
      if (
        image.type !== "image" ||
        typeof image.attachment !== "object" ||
        image.attachment === null
      ) {
        continue;
      }
      const reference = image.attachment as Record<string, unknown>;
      if (
        reference.attachmentId === attachmentId &&
        typeof reference.mediaType === "string" &&
        typeof reference.bytes === "number" &&
        typeof reference.width === "number" &&
        typeof reference.height === "number"
      ) {
        return {
          attachmentId,
          bytes: reference.bytes,
          height: reference.height,
          mediaType: reference.mediaType,
          ...(typeof reference.name === "string" ? { name: reference.name } : {}),
          width: reference.width,
        };
      }
    }
  }
  return undefined;
}

function defaultNow(): AgentTimestamp {
  return agentTimestamp(new Date().toISOString());
}

function defaultSessionId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new AgentBackendError(
      "invalid_argument",
      "The DSH backend requires a session-id factory when crypto.randomUUID is unavailable",
    );
  }
  return `dsh-${globalThis.crypto.randomUUID()}`;
}

function publicUnavailable(message = "The local DSH backend is unavailable"): AgentBackendError {
  return new AgentBackendError("unavailable", message, { retryable: true });
}

function queuedInput(
  message: DshUserMessage,
  kind: AgentQueuedInput["kind"],
  queuedAt: AgentTimestamp,
): AgentQueuedInput {
  const id = String(message.id).trim();
  if (!id || !Array.isArray(message.content)) {
    throw new AgentBackendError("protocol", "DSH inbox contains an invalid user message");
  }
  const content = dshContentBlocks(message.content);
  if (content.length === 0) {
    throw new AgentBackendError("protocol", "DSH inbox contains an empty user message");
  }
  return { content, id, kind, queuedAt };
}

function normalizedSessionId(value: string): string {
  const id = value.trim();
  if (!id || id.length > 256) {
    throw new AgentBackendError("invalid_argument", "DSH session id is invalid");
  }
  return id;
}

function optionalModel(value: AgentModelSelection | undefined): AgentModelSelection | undefined {
  if (value === undefined) return undefined;
  if (!value.provider.trim() || !value.modelId.trim()) {
    throw new AgentBackendError("invalid_argument", "DSH model selection is invalid");
  }
  return value;
}

function modelSelectionFromTarget(target: DshModelTarget): AgentModelSelection {
  const provider = target.provider.trim();
  const modelId = target.model.trim();
  if (!provider || !modelId) {
    throw new AgentBackendError("protocol", "DSH returned an invalid model selection");
  }
  const thinkingLevel = target.reasoningEffort?.trim();
  return {
    modelId,
    provider,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

function sameModelSelection(
  left: AgentModelSelection | undefined,
  right: AgentModelSelection | undefined,
): boolean {
  return (
    left?.provider === right?.provider &&
    left?.modelId === right?.modelId &&
    left?.thinkingLevel === right?.thinkingLevel
  );
}

function stateRevisionForEvents(events: readonly DshSessionEvent[]): number {
  let revision = 0;
  for (const event of events) {
    if (
      runStartForDshEvent(event) !== undefined ||
      runFinishForDshEvent(event) !== undefined ||
      metadataPatchForDshEvent(event) !== undefined ||
      isDshPermissionConfigEvent(event) ||
      event.type === "agent/inbox/spliced" ||
      event.type === "plan/mode" ||
      event.type === "goal/change" ||
      event.type === "todo/write" ||
      event.type === "turn/start"
    ) {
      revision += 1;
    }
  }
  return revision;
}

function isDshPermissionConfigEvent(event: DshSessionEvent): boolean {
  return (
    event.type === "permission/preset" ||
    event.type === "sandbox/mode" ||
    event.type === "approval/policy"
  );
}

function optionalWorkspace(value: string | undefined): string {
  const workspace = value?.trim();
  if (!workspace || workspace.length > 256) {
    throw new AgentBackendError(
      "invalid_argument",
      "A registered DSH workspace is required to create a session",
    );
  }
  return workspace;
}

function dshWorkspaceId(value: string): DshWorkspaceId {
  return value as DshWorkspaceId;
}

function sameNativeSession(session: DshSession, nativeSessionId: string): boolean {
  return String(session.id) === nativeSessionId && String(session.header.id) === nativeSessionId;
}

function inspectionFromLiveSession(session: DshSession): DshSessionInspection {
  return { events: session.events, meta: session.header };
}

function summaryFromCatalogEntry(
  ref: AgentSessionRef,
  entry: DshSessionCatalogEntry,
  runtimeStatus: AgentRuntimeStatus,
): AgentSessionSummary {
  const title = entry.title?.trim();
  return {
    createdAt: dshTimestamp(entry.createdAt, "session creation timestamp"),
    ref,
    runtimeStatus,
    ...(title ? { title } : {}),
    updatedAt: dshTimestamp(entry.updatedAt, "session update timestamp"),
  };
}

function withCatalogTitle(
  summary: AgentSessionSummary,
  catalogEntry: AgentSessionSummary | undefined,
): AgentSessionSummary {
  if (summary.title !== undefined) return summary;
  const title = catalogEntry?.title;
  return title === undefined ? summary : { ...summary, title };
}

function activeRunId(inspection: DshSessionInspection): ReturnType<typeof agentRunId> | undefined {
  let active: ReturnType<typeof agentRunId> | undefined;
  for (const event of inspection.events) {
    const started = runStartForDshEvent(event);
    if (started !== undefined) {
      active = started.id;
      continue;
    }
    const finished = runFinishForDshEvent(event);
    if (finished !== undefined && active === finished.runId) active = undefined;
  }
  return active;
}

type DshActivityRecord = Readonly<Record<string, unknown>>;

function dshActivityRecord(value: unknown, label: string): DshActivityRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentBackendError("protocol", `DSH ${label} is invalid`);
  }
  return value as DshActivityRecord;
}

function dshActivityInteger(
  data: DshActivityRecord,
  key: string,
  label: string,
  minimum = 1,
): number {
  const value = data[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new AgentBackendError("protocol", `DSH ${label} is invalid`);
  }
  return value as number;
}

/** Maps the stable, user-useful DSH lifecycle records to one transient event. */
function runActivityForDshEvent(
  event: DshSessionEvent,
  currentRunId: ReturnType<typeof agentRunId> | undefined,
): Extract<AgentSessionEvent, { readonly type: "run.activity" }>["payload"] | undefined {
  if (
    event.type === "step/start" ||
    event.type === "llm/retry-started" ||
    event.type === "llm/retry"
  ) {
    const data = dshActivityRecord(event.data, event.type);
    const turn = dshActivityInteger(data, "turn", `${event.type} turn`, 1);
    dshActivityInteger(data, "step", `${event.type} step`);
    if (event.type === "llm/retry-started") {
      dshActivityInteger(data, "retry", "retry number", 1);
    }
    if (event.type === "llm/retry") {
      const retry = dshActivityInteger(data, "retry", "retry number", 1);
      const maxRetries = data.maxRetries;
      if (
        maxRetries !== undefined &&
        (!Number.isSafeInteger(maxRetries) || (maxRetries as number) < retry)
      ) {
        throw new AgentBackendError("protocol", "DSH retry maximum is invalid");
      }
      const delayMs = dshActivityInteger(data, "delayMs", "retry delay", 0);
      if (currentRunId === undefined || dshRunId(turn) !== currentRunId) return undefined;
      const retryLabel =
        maxRetries === undefined ? `Retry ${retry}` : `Retry ${retry}/${maxRetries}`;
      return {
        detail: `${retryLabel} · waiting ${delayMs}ms`,
        kind: "retry",
        runId: currentRunId,
      };
    }
    if (currentRunId === undefined || dshRunId(turn) !== currentRunId) return undefined;
    return { kind: "thinking", runId: currentRunId };
  }

  if (event.type === "compaction/start") {
    const data = dshActivityRecord(event.data, "compaction start");
    const compactionId = data.compactionId;
    if (typeof compactionId !== "string" || compactionId.length === 0) {
      throw new AgentBackendError("protocol", "DSH compaction id is invalid");
    }
    if (data.turn === null) return undefined;
    const turn = dshActivityInteger(data, "turn", "compaction turn", 1);
    if (currentRunId === undefined || dshRunId(turn) !== currentRunId) return undefined;
    return { kind: "summarizing", runId: currentRunId };
  }

  return undefined;
}

/**
 * A harness-neutral local DSH backend over DSH's durable session-persistence
 * catalog. The adapter never treats its active-agent map as history authority.
 */
export class DshLocalBackend implements AgentBackend, DshLocalControllerHost {
  readonly descriptor: AgentBackendDescriptor;
  readonly driverDescriptor: AgentDriverDescriptor;
  get attachments(): DshSessionAttachmentPort | undefined {
    return this.options.attachments;
  }

  private closed = false;
  private readonly controllers = new Map<string, DshLocalSessionController>();
  private readonly opening = new Map<string, Promise<DshLocalSessionController>>();
  private readonly sessionWorkspaceRefs = new Map<string, string>();
  private readonly removeEventListener: () => void;
  private readonly removeInboxEventListeners: readonly (() => void)[];
  private readonly removeInteractionListeners: readonly (() => void)[];
  private readonly removeAvailabilityListener: (() => void) | undefined;
  private readonly catalogListeners = new Set<DshLocalCatalogListener>();
  private readonly driver: DshLocalHarnessDriver;
  private readonly clock: () => AgentTimestamp;
  private readonly permissionInteractions = new Map<string, DshPermissionInteraction>();
  private readonly questionInteractions = new Map<string, DshQuestionBridge>();
  private interactionSequence = 0;

  constructor(private readonly options: DshLocalBackendOptions) {
    this.assertOptions(options);
    this.descriptor = createAgentBackendDescriptor({
      displayName: options.backend?.displayName ?? "This device",
      id: options.backend?.id ?? "local",
      kind: "local",
    });
    const capabilities: AgentDriverCapability[] = [
      ...DSH_LOCAL_CAPABILITIES,
      "model.select",
      ...(options.interactionAvailability === undefined
        ? []
        : (["permission.respond", "question.respond"] as const)),
      ...(options.planMode === undefined && options.context.planMode === undefined
        ? []
        : (["plan.select"] as const)),
      ...(options.attachments === undefined ? [] : (["input.attachments"] as const)),
      ...(options.promptReferences === undefined
        ? []
        : (["prompt.references.files", "prompt.references.sessions"] as const)),
      ...(options.subagents === undefined ? [] : (["session.subagents.list"] as const)),
    ];
    this.driverDescriptor = createAgentDriverDescriptor({
      capabilities,
      displayName: options.driver?.displayName ?? "DeepSeek Harness",
      id: DSH_LOCAL_DRIVER_ID,
      ...(options.promptReferences === undefined
        ? {}
        : { promptReferenceSyntax: "at-token" as const }),
      ...(options.driver?.version === undefined ? {} : { version: options.driver.version }),
    });
    this.clock = options.now ?? defaultNow;
    this.driver = new DshLocalHarnessDriver(this);
    this.removeEventListener = options.context.on("session/event", (session, event) => {
      this.forwardNativeEvent(session, event);
    });
    const inboxEvents = [
      "agent/inbox/inserted",
      "agent/inbox/claimed",
      "agent/inbox/discarded",
    ] as const;
    this.removeInboxEventListeners = inboxEvents.map((event) =>
      options.context.on(event, ({ agent }: DshAgentInboxEvent) => {
        this.forwardInboxEvent(agent);
      }),
    );
    this.removeInteractionListeners =
      options.interactionAvailability === undefined
        ? []
        : [
            options.context.on(
              "approval/request",
              (request, next) => this.receivePermissionRequest(request, next),
              { prepend: true },
            ),
            options.context.on(
              "user-questions/request",
              (request, next) => this.receiveQuestionRequest(request, next),
              { prepend: true },
            ),
          ];
    this.removeAvailabilityListener = options.interactionAvailability?.subscribe(
      (sessionId, available) => {
        if (!available) this.delegateInteractions(sessionId);
      },
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.delegateInteractions();
    this.removeAvailabilityListener?.();
    for (const remove of this.removeInteractionListeners) remove();
    this.removeEventListener();
    for (const remove of this.removeInboxEventListeners) remove();
    this.catalogListeners.clear();
    await Promise.all([...this.controllers.values()].map((controller) => controller.dispose()));
  }

  async browseWorkspaceFolders(
    _input: AgentWorkspaceBrowseInput,
  ): Promise<AgentWorkspaceFolderListing> {
    throw new AgentBackendError("unsupported", "Local DSH folder browsing is host-owned");
  }

  async createWorkspaceFolder(
    _input: AgentWorkspaceCreateFolderInput,
  ): Promise<AgentWorkspaceFolderDescriptor> {
    throw new AgentBackendError("unsupported", "Local DSH folder creation is host-owned");
  }

  async registerWorkspace(
    _input: AgentWorkspaceRegisterInput,
  ): Promise<AgentWorkspaceRegisterResult> {
    throw new AgentBackendError("unsupported", "Local DSH workspace registration is host-owned");
  }

  /**
   * Signals that DSH's own catalog moved for a session this backend does not
   * currently own a controller for — typically a session created or advanced in
   * DSH Web. Sessions with a controller already publish their changes through
   * the runtime event stream, so re-announcing them here would only duplicate
   * work for every observer.
   */
  observeCatalog(listener: DshLocalCatalogListener): () => void {
    this.catalogListeners.add(listener);
    return () => this.catalogListeners.delete(listener);
  }

  /** Announces a host-created session that did not arrive through the public remote create RPC. */
  announceCatalogChanged(ref: AgentSessionRef): void {
    this.assertOpen();
    this.assertDshRef(ref);
    this.notifyCatalogChanged(ref);
  }

  async connectRuntime(ref: AgentSessionRef): Promise<DshLocalSessionRuntime> {
    this.assertOpen();
    this.assertDshRef(ref);
    return this.withPublicErrors(async () => (await this.controllerFor(ref)).connect());
  }

  async createSession(input: AgentSessionCreateInput): Promise<AgentSessionRecord> {
    this.assertOpen();
    if (input.driverId !== this.driverDescriptor.id) {
      throw new AgentBackendError("unsupported", "The requested DSH driver is unavailable", {
        details: { driverId: input.driverId },
      });
    }
    if (input.title !== undefined) {
      throw new AgentBackendError(
        "unsupported",
        "DSH session titles are managed by its title service",
      );
    }
    const workspaceRef = optionalWorkspace(input.workspaceRef);
    const model = optionalModel(input.model);
    const nativeSessionId = normalizedSessionId(
      input.nativeSessionId ?? (this.options.createSessionId ?? defaultSessionId)(),
    );
    const ref = this.refForNativeId(nativeSessionId);

    return this.withPublicErrors(async () => {
      await this.assertSessionDoesNotExist(ref);
      const workspace = this.requireWorkspace(workspaceRef);
      const agent = await this.openDshSession(nativeSessionId, { workspaceId: workspace.id });
      this.sessionWorkspaceRefs.set(nativeSessionId, workspaceRef);
      const controller = this.installController(ref, agent);
      if (model === undefined) await controller.refreshModelSelection();
      else await controller.initializeModelSelection(model);
      const projection = await this.inspectProjection(ref);
      return {
        createdAt: projection.metadata.createdAt,
        ref: controller.ref,
        updatedAt: projection.metadata.updatedAt,
      };
    });
  }

  /** Direct access for host composition; product code uses `listDrivers()`. */
  getDshDriver(): DshLocalHarnessDriver {
    return this.driver;
  }

  async listDrivers(): Promise<readonly AgentDriverDescriptor[]> {
    this.assertOpen();
    return [this.driverDescriptor];
  }

  async listModels(input: AgentModelListInput = {}): Promise<readonly AgentModelMetadata[]> {
    this.assertOpen();
    if (input.driverId !== undefined && input.driverId !== this.driverDescriptor.id) return [];
    return this.withPublicErrors(async () => {
      const value = await this.options.context.sessionController.modelCatalog();
      return value.groups.flatMap((provider) =>
        provider.models.map((model) => ({
          ...(model.reasoning === undefined
            ? {}
            : {
                ...(model.reasoning.defaultEffort === undefined
                  ? {}
                  : { defaultThinkingLevel: model.reasoning.defaultEffort }),
                thinkingLevels: model.reasoning.efforts.map((effort) => ({
                  ...(effort.description === undefined ? {} : { description: effort.description }),
                  displayName: effort.name,
                  id: effort.id,
                })),
              }),
          ...(model.description === undefined ? {} : { description: model.description }),
          displayName: model.name,
          modelId: model.id,
          provider: provider.id,
          providerDisplayName: provider.name,
        })),
      );
    });
  }

  async listWorkspaces(input: {
    readonly driverId: AgentSessionRef["driverId"];
  }): Promise<readonly AgentWorkspaceDescriptor[]> {
    this.assertOpen();
    if (input.driverId !== this.driverDescriptor.id) return [];
    return this.options.context.workspace.list().map((workspace) => {
      const ref = String(workspace.id).trim();
      const displayName = workspace.title.trim();
      if (!ref || ref.length > 256 || !displayName || displayName.length > 256) {
        throw new AgentBackendError("protocol", "DSH reported an invalid workspace");
      }
      return { displayName, ref };
    });
  }

  async listSessions(
    input: { readonly driverId?: AgentSessionRef["driverId"]; readonly limit?: number } = {},
  ): Promise<readonly AgentSessionSummary[]> {
    this.assertOpen();
    if (input.driverId !== undefined && input.driverId !== this.driverDescriptor.id) return [];
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit <= 0)) {
      throw new AgentBackendError("invalid_argument", "Session list limit is invalid");
    }

    return this.withPublicErrors(async () => {
      const records = new Map<string, AgentSessionSummary>();
      const catalog = await this.options.listSessionCatalog();
      for (const entry of catalog) {
        const nativeSessionId = normalizedSessionId(String(entry.id));
        const ref = this.refForNativeId(nativeSessionId);
        records.set(agentSessionLocatorKey(ref), summaryFromCatalogEntry(ref, entry, "ready"));
      }
      // Fresh DSH sessions may be deliberately lazy until their first durable
      // event. They remain discoverable for this host process through their
      // active controller, but cannot survive a DSH restart before materializing.
      for (const controller of this.controllers.values()) {
        if (!controller.isCurrent()) continue;
        const key = agentSessionLocatorKey(controller.ref);
        // The live controller is the fresher authority: DSH checkpoints its
        // projection cache on a throttled write-behind, so a title changed
        // mid-turn reaches this summary before it reaches the catalog. The
        // catalog title only fills in when this session's log carried no
        // title event the controller could fold.
        records.set(key, withCatalogTitle(controller.summary(), records.get(key)));
      }
      const summaries = await Promise.all(
        [...records.values()].map(async (summary) => ({
          ...summary,
          workspaceRef: await this.workspaceRefFor(summary.ref),
        })),
      );
      summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return input.limit === undefined ? summaries : summaries.slice(0, input.limit);
    });
  }

  async listSessionSubagents(
    ref: AgentSessionRef,
    signal?: AbortSignal,
  ): Promise<readonly AgentSessionSubagentEntry[]> {
    this.assertOpen();
    this.assertDshRef(ref);
    const provider = this.options.subagents;
    if (provider === undefined) {
      throw new AgentBackendError("unsupported", "DSH subagent listing is unavailable");
    }
    if (signal?.aborted) {
      throw publicUnavailable("The DSH subagent listing was cancelled");
    }
    return this.withPublicErrors(async () => {
      try {
        const nativeEntries = await provider.listDescendants(ref.nativeSessionId, signal);
        if (signal?.aborted) {
          throw publicUnavailable("The DSH subagent listing was cancelled");
        }
        const entries = nativeEntries.map((entry): AgentSessionSubagentEntry => {
          const childRef = this.refForNativeId(nativeSubagentId(entry.id, "Subagent id"));
          const parentRef = this.refForNativeId(
            nativeSubagentId(entry.parentId, "Subagent parent id"),
          );
          if (entry.kind === "diagnostic") {
            return {
              depth: entry.depth,
              kind: "diagnostic",
              parentRef,
              reason: entry.reason,
              ref: childRef,
            };
          }
          if (entry.mode === "continuable") {
            if (typeof entry.label !== "string") {
              throw new AgentBackendError("protocol", "DSH continuable subagent label is invalid");
            }
            return {
              activity: entry.activity,
              depth: entry.depth,
              hasChildren: entry.hasChildren,
              kind: "child",
              label: entry.label,
              mode: "continuable",
              parentRef,
              ref: childRef,
            };
          }
          return {
            activity: entry.activity,
            depth: entry.depth,
            hasChildren: entry.hasChildren,
            kind: "child",
            ...(entry.label === undefined ? {} : { label: entry.label }),
            mode: "one-shot",
            parentRef,
            ref: childRef,
          };
        });
        return validateAgentSessionSubagentList(entries, ref);
      } catch (error) {
        if (isDshCancellation(error)) {
          throw publicUnavailable("The DSH subagent listing was cancelled");
        }
        throw error;
      }
    });
  }

  async readSession(ref: AgentSessionRef): Promise<AgentSessionProjection> {
    this.assertOpen();
    this.assertDshRef(ref);
    return this.withPublicErrors(async () => {
      const inspection = await this.inspect(ref);
      const projection = readDshSessionProjection(ref, inspection);
      const controller = this.controllers.get(agentSessionLocatorKey(ref));
      let decorated = projection;
      if (controller !== undefined) {
        await controller.refreshModelSelection();
        decorated = controller.decorateProjection(projection);
      } else if (
        this.options.context.agents.get(this.options.toSessionId(ref.nativeSessionId)) !== undefined
      ) {
        const model = await this.readCurrentModel(ref);
        if (model !== undefined) {
          decorated = { ...projection, metadata: { ...projection.metadata, model } };
        }
      }
      const permissionOptions = this.permissionOptions(ref);
      return {
        ...decorated,
        ...(permissionOptions === undefined ? {} : { configOptions: [permissionOptions] }),
        workspaceRef: await this.workspaceRefFor(ref),
      };
    });
  }

  async completePromptReferences(
    input: AgentPromptReferenceCompletionInput,
  ): Promise<AgentPromptReferenceCompletionResult | undefined> {
    this.assertOpen();
    const validated = validateAgentPromptReferenceCompletionInput(input);
    const provider = this.options.promptReferences;
    if (provider === undefined) {
      throw new AgentBackendError("unsupported", "DSH prompt reference completion is unavailable");
    }
    return this.withPublicErrors(async () => {
      const request = {
        cursor: validated.cursor,
        limit: validated.limit,
        ...(validated.signal === undefined ? {} : { signal: validated.signal }),
        source: validated.source,
        text: validated.text,
      };
      const result = await (async () => {
        if ("ref" in validated) {
          this.assertDshRef(validated.ref);
          const controller = await this.controllerFor(validated.ref);
          return provider.complete({ ...request, agent: controller.agentForMode() });
        }
        if (validated.driverId !== this.driverDescriptor.id) {
          throw new AgentBackendError("invalid_argument", "Reference completion driver is invalid");
        }
        const workspace = this.requireWorkspace(validated.workspaceRef);
        return provider.complete({ ...request, workspacePath: workspace.path });
      })();
      return validateAgentPromptReferenceCompletionResult(result, validated);
    });
  }

  async updateSession(
    ref: AgentSessionRef,
    input: AgentSessionUpdateInput,
  ): Promise<AgentSessionUpdateResult> {
    this.assertOpen();
    this.assertDshRef(ref);
    const keys = Object.keys(input.patch);
    if (keys.length === 0) {
      throw new AgentBackendError("invalid_argument", "A DSH session update requires a patch");
    }
    if (
      input.expectedRevision !== undefined &&
      (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    ) {
      throw new AgentBackendError("invalid_argument", "Expected session revision is invalid");
    }
    if (input.patch.configOptions !== undefined) {
      const value = input.patch.configOptions.permissions;
      if (keys.length !== 1 || Object.keys(input.patch.configOptions).length !== 1) {
        throw new AgentBackendError(
          "invalid_argument",
          "DSH permission updates must set the permissions option",
        );
      }
      if (typeof value !== "string") {
        throw new AgentBackendError("invalid_argument", "DSH permission preset is invalid");
      }
      const provider = this.options.permissionPresets;
      if (provider === undefined) {
        throw new AgentBackendError("unsupported", "DSH permission preset updates are unavailable");
      }
      const controller = await this.controllerFor(ref);
      const currentRevision = controller.currentStateRevision();
      if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
        throw new AgentBackendError("revision_conflict", "The DSH session state has changed", {
          details: { currentRevision, expectedRevision: input.expectedRevision },
        });
      }
      return this.withPublicErrors(async () => {
        await provider.set(ref.nativeSessionId, value);
        return { revision: await this.readStateRevision(ref) };
      });
    }
    if (input.patch.mode !== undefined) {
      if (keys.length !== 1 || (input.patch.mode !== "plan" && input.patch.mode !== null)) {
        throw new AgentBackendError("invalid_argument", "DSH session mode must be plan or null");
      }
      const provider = this.options.planMode ?? this.options.context.planMode;
      if (provider === undefined) {
        throw new AgentBackendError("unsupported", "DSH plan mode updates are unavailable");
      }
      const controller = await this.controllerFor(ref);
      const currentRevision = controller.currentStateRevision();
      if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
        throw new AgentBackendError("revision_conflict", "The DSH session state has changed", {
          details: { currentRevision, expectedRevision: input.expectedRevision },
        });
      }
      await provider.set(controller.agentForMode(), input.patch.mode === "plan");
      return { revision: controller.currentStateRevision() };
    }
    if (keys.length !== 1 || input.patch.model === undefined) {
      throw new AgentBackendError("unsupported", "DSH only supports session model updates");
    }
    if (input.patch.model === null) {
      throw new AgentBackendError("unsupported", "A DSH session model cannot be cleared");
    }
    const model = optionalModel(input.patch.model)!;
    return this.withPublicErrors(async () => {
      const controller = await this.controllerFor(ref);
      return { revision: await controller.selectModel(model, input.expectedRevision) };
    });
  }

  /** State revisions count metadata/run transitions, not every transcript entry. */
  async readStateRevision(ref: AgentSessionRef): Promise<number> {
    this.assertOpen();
    this.assertDshRef(ref);
    return this.withPublicErrors(async () => {
      const controller = this.controllers.get(agentSessionLocatorKey(ref));
      if (controller !== undefined) return controller.currentStateRevision();
      return stateRevisionForEvents((await this.inspect(ref)).events);
    });
  }

  detachController(controller: DshLocalSessionController): void {
    const key = agentSessionLocatorKey(controller.ref);
    if (this.controllers.get(key) === controller) this.controllers.delete(key);
  }

  async inspect(ref: AgentSessionRef): Promise<DshSessionInspection> {
    this.assertOpen();
    const nativeSessionId = ref.nativeSessionId;
    const live = this.options.context.agents.get(this.options.toSessionId(nativeSessionId));
    if (live !== undefined && sameNativeSession(live.session, nativeSessionId)) {
      return inspectionFromLiveSession(live.session);
    }
    return await this.options.context.sessionPersistence.inspect(
      this.options.toSessionId(nativeSessionId),
    );
  }

  createUserMessage(content: readonly DshUserMessageContent[]): DshUserMessage {
    return this.options.createUserMessage({
      content,
      source: { kind: "user" },
    });
  }

  async readAttachment(
    ref: AgentSessionRef,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<AgentAttachmentReadResult> {
    this.assertDshRef(ref);
    const port = this.options.attachments;
    if (port === undefined) {
      throw new AgentBackendError("unsupported", "DSH attachment reads are unavailable");
    }
    const inspection = await this.inspect(ref);
    const reference = findDshAttachmentReference(inspection.events, attachmentId);
    if (reference === undefined) {
      throw new AgentBackendError("not_found", "The attachment is not part of this session");
    }
    const stored = await port.readImage(reference, signal);
    return {
      attachmentId: stored.reference.attachmentId,
      bytes: stored.reference.bytes,
      data: encodeBase64(stored.data),
      height: stored.reference.height,
      mimeType: stored.reference.mediaType,
      ...(stored.reference.name === undefined ? {} : { name: stored.reference.name }),
      width: stored.reference.width,
    };
  }

  isCurrentAgent(agent: DshAgent): boolean {
    return this.options.context.agents.get(agent.id) === agent;
  }

  now(): AgentTimestamp {
    return this.clock();
  }

  permissionOptions(ref: AgentSessionRef): AgentSessionConfigOption | undefined {
    return this.options.permissionPresets?.describe(ref.nativeSessionId);
  }

  readPlanMode(
    agent: DshAgent,
  ): { readonly active: boolean; readonly pending?: boolean } | undefined {
    return (this.options.planMode ?? this.options.context.planMode)?.get(agent);
  }

  async setPlanMode(
    agent: DshAgent,
    active: boolean,
  ): Promise<"committed" | "queued" | "cancelled" | "noop"> {
    const provider = this.options.planMode ?? this.options.context.planMode;
    if (provider === undefined) {
      throw new AgentBackendError("unsupported", "DSH plan mode updates are unavailable");
    }
    return await provider.set(agent, active);
  }

  async readCurrentModel(ref: AgentSessionRef): Promise<AgentModelSelection | undefined> {
    const agent = this.options.context.agents.get(this.options.toSessionId(ref.nativeSessionId));
    if (agent === undefined || !sameNativeSession(agent.session, ref.nativeSessionId))
      return undefined;
    const current = this.options.context.sessionProjections.snapshot(agent.session).values
      .modelSelection?.next;
    return current === null || current === undefined
      ? undefined
      : modelSelectionFromTarget(current);
  }

  async selectCurrentModel(
    ref: AgentSessionRef,
    selection: AgentModelSelection,
  ): Promise<AgentModelSelection> {
    const value = await this.options.context.sessionController.selectModel({
      model: selection.modelId,
      provider: selection.provider,
      ...(selection.thinkingLevel === undefined
        ? {}
        : { reasoningEffort: selection.thinkingLevel }),
      sessionId: this.options.toSessionId(ref.nativeSessionId),
    });
    return modelSelectionFromTarget(value.selected);
  }

  report(error: AgentBackendError): void {
    try {
      this.options.onError?.(error);
    } catch {
      // DSH's append path must never be destabilized by a diagnostic observer.
    }
  }

  private assertOptions(options: DshLocalBackendOptions): void {
    if (
      !options ||
      typeof options.toSessionId !== "function" ||
      typeof options.createUserMessage !== "function" ||
      typeof options.context?.on !== "function" ||
      typeof options.context?.agents?.get !== "function" ||
      typeof options.context?.sessionController?.create !== "function" ||
      typeof options.context?.sessionController?.modelCatalog !== "function" ||
      typeof options.context?.sessionController?.selectModel !== "function" ||
      typeof options.context?.sessionPersistence?.inspect !== "function" ||
      typeof options.context?.sessionPersistence?.list !== "function" ||
      typeof options.context?.sessionProjections?.snapshot !== "function" ||
      typeof options.context?.workspace?.get !== "function"
    ) {
      throw new AgentBackendError(
        "invalid_argument",
        "The DSH context does not provide its session persistence and agent lifecycle services",
      );
    }
  }

  private receivePermissionRequest(
    request: DshApprovalRequest,
    next: () => Promise<DshApprovalOutcome>,
  ): Promise<DshApprovalOutcome> {
    if (!this.canClaimInteraction(request.agent)) return next();
    const sessionId = String(request.agent.session.id);
    const interaction = this.permissionInteraction(sessionId);
    const result = interaction.requested(request, next, this.now());
    if (this.options.interactionAvailability?.isAvailable(sessionId) !== true)
      interaction.delegate();
    return result;
  }

  private receiveQuestionRequest(
    request: DshQuestionRequest,
    next: () => Promise<DshQuestionAnswer>,
  ): Promise<DshQuestionAnswer> {
    if (request.agent === undefined || !this.canClaimInteraction(request.agent)) return next();
    const sessionId = String(request.agent.session.id);
    const interaction = this.questionInteraction(sessionId);
    const result = interaction.requested(request, next, this.now());
    if (this.options.interactionAvailability?.isAvailable(sessionId) !== true)
      interaction.delegate();
    return result;
  }

  private canClaimInteraction(agent: DshAgent): boolean {
    const sessionId = String(agent.session.id);
    return (
      !this.closed &&
      this.options.interactionAvailability?.isAvailable(sessionId) === true &&
      this.options.context.agents.get(agent.id) === agent
    );
  }

  private permissionInteraction(sessionId: string): DshPermissionInteraction {
    const existing = this.permissionInteractions.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new DshPermissionInteraction(
      () => this.nextInteractionId("approval"),
      (pending) => this.controllerForInteraction(sessionId)?.publishPermissionState(pending),
    );
    this.permissionInteractions.set(sessionId, created);
    return created;
  }

  private questionInteraction(sessionId: string): DshQuestionBridge {
    const existing = this.questionInteractions.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new DshQuestionBridge(
      () => this.nextInteractionId("question"),
      (pending) => this.controllerForInteraction(sessionId)?.publishQuestionState(pending),
    );
    this.questionInteractions.set(sessionId, created);
    return created;
  }

  private controllerForInteraction(sessionId: string): DshLocalSessionController | undefined {
    return this.controllers.get(agentSessionLocatorKey(this.refForNativeId(sessionId)));
  }

  private nextInteractionId(kind: "approval" | "question"): string {
    this.interactionSequence += 1;
    return `orbis-dsh-${kind}-${this.interactionSequence}`;
  }

  private delegateInteractions(sessionId?: string): void {
    if (sessionId === undefined) {
      for (const interaction of this.permissionInteractions.values()) interaction.delegate();
      for (const interaction of this.questionInteractions.values()) interaction.delegate();
      return;
    }
    this.permissionInteractions.get(sessionId)?.delegate();
    this.questionInteractions.get(sessionId)?.delegate();
  }

  private assertOpen(): void {
    if (this.closed) throw new AgentBackendError("closed", "The local DSH backend is closed");
  }

  private assertDshRef(ref: AgentSessionRef): void {
    if (ref.backendId !== this.descriptor.id) {
      throw new AgentBackendError("conflict", "The session belongs to another backend", {
        details: { backendId: ref.backendId },
      });
    }
    if (ref.driverId !== this.driverDescriptor.id) {
      throw new AgentBackendError("unsupported", "The session does not use the DSH driver", {
        details: { driverId: ref.driverId },
      });
    }
  }

  private refForNativeId(nativeSessionId: string): AgentSessionRef {
    return createAgentSessionRef({
      backendId: this.descriptor.id,
      driverId: this.driverDescriptor.id,
      nativeSessionId,
      // DSH's durable session id is already its stable catalog identity.
      sessionId: nativeSessionId,
    });
  }

  private async assertSessionDoesNotExist(ref: AgentSessionRef): Promise<void> {
    const key = agentSessionLocatorKey(ref);
    if (
      this.controllers.has(key) ||
      this.options.context.agents.get(this.options.toSessionId(ref.nativeSessionId))
    ) {
      throw new AgentBackendError("conflict", "A DSH session with this id already exists");
    }
    const headers = await this.options.context.sessionPersistence.list();
    if (headers.some((header) => String(header.id) === ref.nativeSessionId)) {
      throw new AgentBackendError("conflict", "A DSH session with this id already exists");
    }
  }

  private requireWorkspace(workspaceRef: string): DshWorkspace {
    const workspace = this.options.context.workspace.get(dshWorkspaceId(workspaceRef));
    if (workspace === undefined) {
      throw new AgentBackendError("not_found", "The requested DSH workspace was not found", {
        details: { workspaceRef },
      });
    }
    if (!workspace.path || !workspace.title) {
      throw new AgentBackendError("protocol", "The registered DSH workspace is invalid");
    }
    return workspace;
  }

  private async controllerFor(ref: AgentSessionRef): Promise<DshLocalSessionController> {
    const key = agentSessionLocatorKey(ref);
    const existing = this.controllers.get(key);
    if (existing !== undefined) {
      if (!isSameAgentSessionRef(existing.ref, ref)) {
        throw new AgentBackendError(
          "conflict",
          "The DSH session has conflicting catalog identities",
        );
      }
      if (existing.isCurrent()) {
        await existing.refreshModelSelection();
        return existing;
      }
      await existing.dispose();
    }
    const inFlight = this.opening.get(key);
    if (inFlight !== undefined) return inFlight;
    const opening = this.openController(ref);
    this.opening.set(key, opening);
    try {
      return await opening;
    } finally {
      if (this.opening.get(key) === opening) this.opening.delete(key);
    }
  }

  private async openController(ref: AgentSessionRef): Promise<DshLocalSessionController> {
    const inspection = await this.inspect(ref);
    const nativeId = this.options.toSessionId(ref.nativeSessionId);
    const existing = this.options.context.agents.get(nativeId);
    if (existing !== undefined) {
      if (!sameNativeSession(existing.session, ref.nativeSessionId)) {
        throw new AgentBackendError("protocol", "DSH resolved another live session");
      }
      const controller = this.installController(ref, existing);
      await controller.refreshModelSelection();
      return controller;
    }
    const agent = await this.openDshSession(
      ref.nativeSessionId,
      inspection.meta.cwd === undefined ? {} : { cwd: inspection.meta.cwd },
    );
    const controller = this.installController(ref, agent);
    await controller.refreshModelSelection();
    return controller;
  }

  /**
   * Opens sessions through DSH's product gateway. That gateway is the owner of
   * preset resolution and composition, including tools, prompts, and plugin
   * setup; calling the raw agent registry here would create a bare LLM agent.
   */
  private async openDshSession(
    nativeSessionId: string,
    location: { readonly cwd?: string; readonly workspaceId?: unknown },
  ): Promise<DshAgent> {
    const sessionId = this.options.toSessionId(nativeSessionId);
    const value = await this.options.context.sessionController.create({ ...location, sessionId });
    if (String(value.sessionId) !== nativeSessionId) {
      throw new AgentBackendError("protocol", "DSH opened a session with an unexpected id");
    }
    const agent = this.options.context.agents.get(sessionId);
    if (agent === undefined || !sameNativeSession(agent.session, nativeSessionId)) {
      throw new AgentBackendError("protocol", "DSH did not publish the opened session agent");
    }
    if (this.closed) {
      throw new AgentBackendError("closed", "The local DSH backend is closed");
    }
    return agent;
  }

  private installController(ref: AgentSessionRef, agent: DshAgent): DshLocalSessionController {
    const key = agentSessionLocatorKey(ref);
    const existing = this.controllers.get(key);
    if (existing !== undefined) {
      if (!existing.isCurrent() || !isSameAgentSessionRef(existing.ref, ref)) {
        throw new AgentBackendError("conflict", "The DSH session controller is conflicted");
      }
      return existing;
    }
    const permissionBridge =
      this.options.interactionAvailability === undefined
        ? undefined
        : this.permissionInteraction(ref.nativeSessionId);
    const questionBridge =
      this.options.interactionAvailability === undefined
        ? undefined
        : this.questionInteraction(ref.nativeSessionId);
    const controller = new DshLocalSessionController(
      this,
      ref,
      agent,
      permissionBridge,
      questionBridge,
    );
    this.controllers.set(key, controller);
    if (permissionBridge !== undefined)
      controller.publishPermissionState(permissionBridge.snapshot());
    if (questionBridge !== undefined) controller.publishQuestionState(questionBridge.snapshot());
    return controller;
  }

  private async inspectProjection(ref: AgentSessionRef): Promise<AgentSessionProjection> {
    return readDshSessionProjection(ref, await this.inspect(ref));
  }

  private async workspaceRefFor(ref: AgentSessionRef): Promise<string | null> {
    const known = this.sessionWorkspaceRefs.get(ref.nativeSessionId);
    if (known !== undefined) return known;
    const workspace = this.options.context.workspace
      .list()
      .find((candidate) =>
        candidate.sessionIds?.some(
          (sessionId) => String(sessionId) === String(ref.nativeSessionId),
        ),
      );
    if (workspace === undefined) return null;
    const workspaceRef = String(workspace.id);
    this.sessionWorkspaceRefs.set(ref.nativeSessionId, workspaceRef);
    return workspaceRef;
  }

  private forwardNativeEvent(session: DshSession, event: DshSessionEvent): void {
    if (this.closed) return;
    const nativeSessionId = String(session.id);
    const ref = this.refForNativeId(nativeSessionId);
    const controller = this.controllers.get(agentSessionLocatorKey(ref));
    if (controller === undefined || !controller.accepts(session)) {
      // DSH Web drives sessions this backend never opened. Their durable
      // catalog row still moves, so announce it instead of dropping the event;
      // otherwise the only way to observe such a session is an explicit list.
      this.notifyCatalogChanged(ref);
      return;
    }
    controller.receive(event);
  }

  private notifyCatalogChanged(ref: AgentSessionRef): void {
    for (const listener of this.catalogListeners) {
      try {
        listener({ ref });
      } catch {
        // Catalog observers are passive freshness hints by contract.
      }
    }
  }

  private forwardInboxEvent(agent: DshAgent): void {
    if (this.closed) return;
    const ref = this.refForNativeId(String(agent.id));
    const controller = this.controllers.get(agentSessionLocatorKey(ref));
    if (controller === undefined || !controller.accepts(agent.session)) return;
    controller.receiveInboxChanged();
  }

  private async withPublicErrors<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    try {
      return await operation();
    } catch (error) {
      if (isAgentBackendError(error)) throw error;
      this.reportUpstreamError(error);
      const code = dshRemoteFailureCode(error);
      if (
        code === "gateway/bad-request" ||
        code === "session/attachment-invalid" ||
        code === "session/model-unavailable" ||
        code === "session/title-invalid"
      ) {
        throw new AgentBackendError("invalid_argument", "The requested DSH operation is invalid");
      }
      if (
        code === "session/not-found" ||
        code === "session/queue-item-not-found" ||
        code === "subagent/not-found" ||
        code === "workspace/not-found"
      ) {
        throw new AgentBackendError("not_found", "The requested DSH resource was not found");
      }
      if (
        code === "agent-preset/conflict" ||
        code === "session/agent-busy" ||
        code === "session/conflict"
      ) {
        throw new AgentBackendError("conflict", "The DSH session is busy or conflicted");
      }
      throw publicUnavailable();
    }
  }

  reportUpstreamError(error: unknown): void {
    try {
      this.options.onUpstreamError?.(error);
    } catch {
      // A diagnostic observer must never change public error mapping.
    }
  }
}

function dshRemoteFailureCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isDshCancellation(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "CANCELLED" || code === "cancelled" || code === "gateway/cancelled";
}

function nativeSubagentId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new AgentBackendError("protocol", `DSH ${label.toLowerCase()} is invalid`);
  }
  return value;
}

/** DSH's driver view over one backend. */
export class DshLocalHarnessDriver implements AgentHarnessDriver {
  readonly descriptor: AgentDriverDescriptor;

  constructor(private readonly backend: DshLocalBackend) {
    this.descriptor = backend.driverDescriptor;
  }

  async close(): Promise<void> {
    await this.backend.close();
  }

  async connectRuntime(ref: AgentSessionRef): Promise<DshLocalSessionRuntime> {
    return this.backend.connectRuntime(ref);
  }

  async createSession(
    input: Omit<AgentSessionCreateInput, "driverId"> = {},
  ): Promise<AgentSessionRecord> {
    return this.backend.createSession({ ...input, driverId: this.descriptor.id });
  }

  async listSessions(
    input: { readonly limit?: number } = {},
  ): Promise<readonly AgentSessionSummary[]> {
    return this.backend.listSessions({ ...input, driverId: this.descriptor.id });
  }

  async listSessionSubagents(
    ref: AgentSessionRef,
    signal?: AbortSignal,
  ): Promise<readonly AgentSessionSubagentEntry[]> {
    return this.backend.listSessionSubagents(ref, signal);
  }

  async listModels(): Promise<readonly AgentModelMetadata[]> {
    return this.backend.listModels({ driverId: this.descriptor.id });
  }

  async listWorkspaces(): Promise<readonly AgentWorkspaceDescriptor[]> {
    return this.backend.listWorkspaces({ driverId: this.descriptor.id });
  }

  async readSession(ref: AgentSessionRef): Promise<AgentSessionProjection> {
    return this.backend.readSession(ref);
  }

  async completePromptReferences(
    input: AgentPromptReferenceCompletionInput,
  ): Promise<AgentPromptReferenceCompletionResult | undefined> {
    return this.backend.completePromptReferences(input);
  }

  async readAttachment(
    ref: AgentSessionRef,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<AgentAttachmentReadResult> {
    return this.backend.readAttachment(ref, attachmentId, signal);
  }

  async updateSession(
    ref: AgentSessionRef,
    input: AgentSessionUpdateInput,
  ): Promise<AgentSessionUpdateResult> {
    return this.backend.updateSession(ref, input);
  }
}

/** A detachable observer façade; closing it never cancels the DSH agent. */
export class DshLocalSessionRuntime implements AgentSessionRuntime {
  readonly ref: AgentSessionRef;

  private closed = false;
  private readonly listeners = new Set<AgentSessionEventListener>();
  private readonly statusListeners = new Set<AgentRuntimeStatusListener>();
  private observedStatus: AgentRuntimeStatus;

  constructor(
    private readonly controller: DshLocalSessionController,
    ref: AgentSessionRef,
  ) {
    this.ref = ref;
    this.observedStatus = controller.runtimeStatus();
  }

  async cancel(input: AgentCancelInput = {}): Promise<AgentCancelResult> {
    this.assertOpen();
    return this.controller.cancel(this, input);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.controller.disconnect(this);
  }

  getStatus(): AgentRuntimeStatus {
    return this.closed ? "closed" : this.controller.runtimeStatus();
  }

  /** Flushes coalesced transient deltas for a snapshot boundary. */
  flushPendingDeltas(): void {
    this.assertOpen();
    this.controller.flushPendingDeltas(this);
  }

  observeStatus(listener: AgentRuntimeStatusListener): () => void {
    const status = this.getStatus();
    this.observedStatus = status;
    this.statusListeners.add(listener);
    this.notifyStatus(listener, status);
    return () => this.statusListeners.delete(listener);
  }

  pendingInputs(): readonly AgentQueuedInput[] {
    return this.controller.pendingInputs();
  }

  async prompt(input: AgentPromptInput): Promise<AgentPromptReceipt> {
    this.assertOpen();
    return this.controller.prompt(this, input);
  }

  async respondPermission(
    input: AgentPermissionResponseInput,
  ): Promise<AgentPermissionResponseResult> {
    this.assertOpen();
    return this.controller.respondPermission(this, input);
  }

  async respondQuestion(input: AgentQuestionResponseInput): Promise<AgentQuestionResponseResult> {
    this.assertOpen();
    return this.controller.respondQuestion(this, input);
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    const pending = this.controller.permissionSnapshot();
    if (pending.length > 0) this.controller.publishPermissionState(pending);
    const questions = this.controller.questionSnapshot();
    if (questions.length > 0) this.controller.publishQuestionState(questions);
    return () => this.listeners.delete(listener);
  }

  markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.publishStatus();
    this.listeners.clear();
    this.statusListeners.clear();
  }

  publish(event: AgentSessionEvent): void {
    if (this.closed) return;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observers cannot corrupt a DSH agent's lifecycle.
      }
    }
    if (event.type === "session.state.changed") this.publishStatus();
  }

  private assertOpen(): void {
    if (this.closed) throw new AgentBackendError("closed", "The DSH session runtime is closed");
  }

  private publishStatus(): void {
    const status = this.getStatus();
    if (status === this.observedStatus) return;
    this.observedStatus = status;
    for (const listener of this.statusListeners) this.notifyStatus(listener, status);
  }

  private notifyStatus(listener: AgentRuntimeStatusListener, status: AgentRuntimeStatus): void {
    try {
      listener(status);
    } catch {
      // Runtime status observers are passive and cannot own the DSH lifecycle.
    }
  }
}

/** Owns one DSH agent acquisition and survives runtime-façade/page switches. */
class DshLocalSessionController {
  readonly ref: AgentSessionRef;

  private cursor = agentDeliveryCursor(0);
  private activeRunId: ReturnType<typeof agentRunId> | undefined;
  private activeRunStartedAt: AgentTimestamp | undefined;
  /** Folded incrementally so catalog listings never rescan a live transcript. */
  private title: string | undefined;
  private stateRevision: number;
  private modelInitialized = false;
  private selectedModel: AgentModelSelection | undefined;
  private modelSelectedAt: AgentTimestamp | undefined;
  private disposed = false;
  private runtime: DshLocalSessionRuntime | undefined;
  private readonly projector = new DshSessionEntryProjector();
  private readonly deltaSequence = new Map<string, number>();
  private readonly deltaCoalescer: DshDeltaCoalescer;
  private readonly pendingInboxIds: Record<DshInboxTarget, string[]> = {
    "next-step": [],
    "next-turn": [],
  };
  private readonly pendingInputTimes = new Map<string, AgentTimestamp>();
  private readonly permissionBridge: DshPermissionInteraction | undefined;
  private readonly questionBridge: DshQuestionBridge | undefined;
  private mode: "plan" | null;
  private workState: AgentWorkState;
  private readonly overlayTools = new Map<
    string,
    { readonly callId: string; readonly name: string }
  >();

  constructor(
    private readonly host: DshLocalControllerHost,
    ref: AgentSessionRef,
    private readonly agent: DshAgent,
    permissionBridge?: DshPermissionInteraction,
    questionBridge?: DshQuestionBridge,
  ) {
    this.ref = ref;
    this.permissionBridge = permissionBridge;
    this.questionBridge = questionBridge;
    this.deltaCoalescer = new DshDeltaCoalescer({
      emit: (delta) => this.publishDelta(delta),
    });
    const folded = dshProjectionState(agent.session.events);
    this.mode = folded.mode;
    this.workState = folded.workState;
    this.activeRunId = activeRunId({ events: agent.session.events, meta: agent.session.header });
    this.stateRevision = stateRevisionForEvents(agent.session.events);
    // Seed stateful tool-call correlation without replaying historical events.
    for (const event of agent.session.events) {
      this.recordInboxSplice(event);
      this.projector.project(event);
      this.title = titleForDshEvent(event) ?? this.title;
    }
  }

  currentStateRevision(): number {
    return this.stateRevision;
  }

  permissionSnapshot(): readonly AgentPermissionRequest[] {
    return this.permissionBridge?.snapshot() ?? [];
  }

  questionSnapshot(): readonly AgentQuestionRequest[] {
    return this.questionBridge?.snapshot() ?? [];
  }

  async initializeModelSelection(selection: AgentModelSelection): Promise<void> {
    this.assertOpen();
    this.selectedModel = await this.host.selectCurrentModel(this.ref, selection);
    this.modelInitialized = true;
  }

  async refreshModelSelection(): Promise<void> {
    this.assertOpen();
    const current = await this.host.readCurrentModel(this.ref);
    if (current === undefined) return;
    if (!this.modelInitialized) {
      this.selectedModel = current;
      this.modelInitialized = true;
      return;
    }
    if (sameModelSelection(this.selectedModel, current)) return;
    this.selectedModel = current;
    const occurredAt = this.host.now();
    this.modelSelectedAt = occurredAt;
    this.emitModelState(occurredAt, "external-model-selection");
  }

  async selectModel(selection: AgentModelSelection, expectedRevision?: number): Promise<number> {
    this.assertOpen();
    await this.refreshModelSelection();
    if (expectedRevision !== undefined && expectedRevision !== this.stateRevision) {
      throw new AgentBackendError("revision_conflict", "The DSH session state has changed", {
        details: { currentRevision: this.stateRevision, expectedRevision },
      });
    }
    if (sameModelSelection(this.selectedModel, selection)) return this.stateRevision;
    this.selectedModel = await this.host.selectCurrentModel(this.ref, selection);
    this.modelInitialized = true;
    const occurredAt = this.host.now();
    this.modelSelectedAt = occurredAt;
    this.emitModelState(occurredAt, "model-selection");
    return this.stateRevision;
  }

  accepts(session: DshSession): boolean {
    return !this.disposed && this.agent.session === session;
  }

  isCurrent(): boolean {
    return !this.disposed && this.host.isCurrentAgent(this.agent);
  }

  agentForMode(): DshAgent {
    this.assertOpen();
    return this.agent;
  }

  connect(): DshLocalSessionRuntime {
    this.assertOpen();
    if (this.runtime !== undefined && this.runtime.getStatus() !== "closed") return this.runtime;
    const runtime = new DshLocalSessionRuntime(this, this.ref);
    this.runtime = runtime;
    return runtime;
  }

  async cancel(
    runtime: DshLocalSessionRuntime,
    input: AgentCancelInput,
  ): Promise<AgentCancelResult> {
    this.assertAttached(runtime);
    if (this.agent.status !== "running") return { cancelled: false };
    try {
      this.agent.cancel(
        { kind: "user" },
        input.keepInbox === undefined ? undefined : { keepInbox: input.keepInbox },
      );
    } catch (error) {
      this.host.reportUpstreamError(error);
      throw publicUnavailable("The DSH run could not be cancelled");
    }
    return { cancelled: true };
  }

  flushPendingDeltas(runtime: DshLocalSessionRuntime): void {
    this.assertAttached(runtime);
    this.deltaCoalescer.flush();
  }

  disconnect(runtime: DshLocalSessionRuntime): void {
    if (runtime !== this.runtime) {
      runtime.markClosed();
      return;
    }
    this.deltaCoalescer.flush();
    runtime.markClosed();
    this.runtime = undefined;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.deltaCoalescer.close();
    this.runtime?.markClosed();
    this.runtime = undefined;
    this.host.detachController(this);
  }

  decorateProjection(projection: AgentSessionProjection): AgentSessionProjection {
    const permissions =
      this.permissionBridge === undefined
        ? {}
        : { pendingPermissions: this.permissionBridge.snapshot() };
    const questions =
      this.questionBridge === undefined ? {} : { pendingQuestions: this.questionBridge.snapshot() };
    if (!this.modelInitialized || this.selectedModel === undefined) {
      return {
        ...projection,
        ...permissions,
        ...questions,
        mode: this.mode,
        workState: this.workState,
      };
    }
    return {
      ...projection,
      ...permissions,
      ...questions,
      mode: this.mode,
      metadata: {
        ...projection.metadata,
        model: this.selectedModel,
        updatedAt: this.modelSelectedAt ?? projection.metadata.updatedAt,
      },
      workState: this.workState,
    };
  }

  pendingInputs(): readonly AgentQueuedInput[] {
    const queuedInputFor = (
      message: DshUserMessage,
      kind: AgentQueuedInput["kind"],
    ): AgentQueuedInput => {
      const id = String(message.id).trim();
      const queuedAt = this.pendingInputTimes.get(id);
      if (queuedAt === undefined) {
        throw new AgentBackendError("protocol", "DSH inbox is missing its durable enqueue time");
      }
      return queuedInput(message, kind, queuedAt);
    };
    return [
      ...this.agent.inbox.nextStep.map((message) => queuedInputFor(message, "steer")),
      ...this.agent.inbox.nextTurn.map((message) => queuedInputFor(message, "follow_up")),
    ];
  }

  async prompt(
    runtime: DshLocalSessionRuntime,
    input: AgentPromptInput,
  ): Promise<AgentPromptReceipt> {
    this.assertAttached(runtime);
    const canonical = validateAgentPromptInput(input);
    const inspection = await this.host.inspect(this.ref);
    const running = this.agent.status === "running";
    if (input.delivery !== undefined && !running) {
      throw new AgentBackendError(
        "conflict",
        "DSH steering and follow-up require an active run for this session",
      );
    }
    if (input.delivery === undefined && running) {
      throw new AgentBackendError("conflict", "A DSH run is already active for this session");
    }

    const imageInputs = canonical.content.filter(
      (block): block is Extract<AgentPromptContentBlock, { readonly type: "image" }> =>
        block.type === "image",
    );
    const attachmentPort = imageInputs.length === 0 ? undefined : this.host.attachments;
    if (imageInputs.length > 0 && attachmentPort === undefined) {
      throw new AgentBackendError("unsupported", "DSH image prompts are unavailable");
    }
    const imageRefs =
      attachmentPort === undefined
        ? []
        : await attachmentPort.admitEncodedImages(
            imageInputs.map((image) => ({
              data: image.data,
              mediaType: image.mimeType,
              ...(image.name === undefined ? {} : { name: image.name }),
            })),
          );
    if (imageRefs.length !== imageInputs.length) {
      throw new AgentBackendError("protocol", "DSH attachment admission returned the wrong count");
    }
    let imageIndex = 0;
    const messageContent: DshUserMessageContent[] = canonical.content.map((block) =>
      block.type === "text" ? block : { attachment: imageRefs[imageIndex++]!, type: "image" },
    );
    const message = this.createUserMessage(messageContent);
    const runId = running
      ? (activeRunId(inspection) ?? nextDshRunId(inspection.events))
      : nextDshRunId(inspection.events);
    try {
      if (input.delivery === "steer") this.agent.steer(message);
      else this.agent.followup(message);
    } catch (error) {
      this.host.reportUpstreamError(error);
      throw publicUnavailable("The DSH run could not accept the prompt");
    }
    return { acceptedAt: this.host.now(), runId };
  }

  async respondPermission(
    runtime: DshLocalSessionRuntime,
    input: AgentPermissionResponseInput,
  ): Promise<AgentPermissionResponseResult> {
    this.assertAttached(runtime);
    if (this.permissionBridge === undefined) {
      throw new AgentBackendError("unsupported", "DSH permission responses are unavailable");
    }
    return this.permissionBridge.respond(input);
  }

  async respondQuestion(
    runtime: DshLocalSessionRuntime,
    input: AgentQuestionResponseInput,
  ): Promise<AgentQuestionResponseResult> {
    this.assertAttached(runtime);
    if (this.questionBridge === undefined) {
      throw new AgentBackendError("unsupported", "DSH question responses are unavailable");
    }
    return this.questionBridge.respond(input);
  }

  publishPermissionState(pending: readonly AgentPermissionRequest[]): void {
    if (this.disposed || this.permissionBridge === undefined) return;
    const native =
      this.agent.session.events.at(-1) ??
      ({ data: {}, seq: 0, time: Date.now(), type: "permission/state" } satisfies DshSessionEvent);
    this.emitState(native, `permission-${this.stateRevision + 1}`, {
      pendingPermissions: pending,
    });
  }

  publishQuestionState(pending: readonly AgentQuestionRequest[]): void {
    if (this.disposed || this.questionBridge === undefined) return;
    const native =
      this.agent.session.events.at(-1) ??
      ({ data: {}, seq: 0, time: Date.now(), type: "question/state" } satisfies DshSessionEvent);
    this.emitState(native, `question-${this.stateRevision + 1}`, {
      pendingQuestions: pending,
    });
  }

  receive(event: DshSessionEvent): void {
    if (this.disposed) return;
    try {
      if (event.type !== "assistant/chunk") this.deltaCoalescer.flush();
      const folded = reduceDshProjectionState(
        { mode: this.mode, workState: this.workState },
        event,
      );
      this.recordInboxSplice(event);
      const started = runStartForDshEvent(event);
      if (started !== undefined) {
        this.activeRunId = started.id;
        this.activeRunStartedAt = started.startedAt;
        if (event.type === "turn/start") this.workState = folded.workState;
        this.emitState(event, "run-start", {
          activeRun: started,
          ...(event.type === "turn/start" ? { workState: this.workState } : {}),
          runState: "running",
        });
      }

      const activity = runActivityForDshEvent(event, this.activeRunId);
      if (activity !== undefined) this.emitActivity(event, activity);

      const metadata = metadataPatchForDshEvent(event);
      if (metadata !== undefined) {
        // An explicit null clears the title; an absent key leaves it alone.
        if (metadata.title !== undefined) this.title = metadata.title ?? undefined;
        this.emitState(event, "metadata", metadata);
      }

      if (event.type === "plan/mode") {
        this.mode = folded.mode;
        this.emitState(event, "plan-mode", { mode: this.mode });
      }
      if (event.type === "goal/change" || event.type === "todo/write") {
        this.workState = folded.workState;
        this.emitState(event, "work-state", { workState: this.workState });
      }

      if (isDshPermissionConfigEvent(event)) {
        const permissionOptions = this.host.permissionOptions(this.ref);
        if (permissionOptions !== undefined) {
          this.emitState(event, "permission-config", { configOptions: [permissionOptions] });
        }
      }

      const entry = this.projector.project(event);
      if (event.type === "tool/call") this.emitToolCallState(event);
      if (entry !== undefined) {
        if (entry.kind === "tool") {
          const overlayEntryId = agentEntryId(`tool-${entry.callId}`);
          this.emitToolState(event, "tool-finish", {
            callId: entry.callId,
            ...(entry.content === undefined ? {} : { content: entry.content }),
            entryId: overlayEntryId,
            ...(entry.input === undefined ? {} : { input: entry.input }),
            name: entry.name,
            status: entry.status,
          });
          this.overlayTools.delete(String(overlayEntryId));
        }
        const settlesEntryId =
          entry.kind === "tool"
            ? agentEntryId(`tool-${entry.callId}`)
            : entry.kind === "message" && event.type === "assistant/message"
              ? entry.id
              : undefined;
        this.emitDurable(event, entry, settlesEntryId);
      }

      if (event.type === "assistant/chunk") this.emitChunkEvents(event);

      const finished = runFinishForDshEvent(event);
      if (finished !== undefined) {
        const startedAt = this.activeRunStartedAt ?? finished.finishedAt;
        this.activeRunStartedAt = undefined;
        this.activeRunId = undefined;
        this.emitState(event, "run-finish", {
          activeRun: null,
          lastRun: {
            ...(finished.error === undefined ? {} : { error: finished.error }),
            finishedAt: finished.finishedAt,
            id: finished.runId,
            outcome: finished.outcome,
            startedAt,
          },
          runState: finished.outcome === "failed" ? "error" : "idle",
        });
      }
    } catch (error) {
      this.host.report(
        isAgentBackendError(error)
          ? error
          : new AgentBackendError("protocol", "DSH emitted an invalid session event"),
      );
    }
  }

  receiveInboxChanged(): void {
    if (this.disposed) return;
    const native =
      this.agent.session.events.at(-1) ??
      ({ data: {}, seq: 0, time: Date.now(), type: "agent/inbox" } satisfies DshSessionEvent);
    try {
      this.emitState(native, `inbox-${this.stateRevision + 1}`, {
        pendingInputs: this.pendingInputs(),
      });
    } catch (error) {
      this.host.report(
        isAgentBackendError(error)
          ? error
          : new AgentBackendError("protocol", "DSH emitted an invalid inbox state"),
      );
    }
  }

  runtimeStatus(): AgentRuntimeStatus {
    if (this.disposed) return "closed";
    return this.agent.status === "running" ? "running" : "ready";
  }

  /** Catalog metadata for a live session without reconstructing its transcript. */
  summary(): AgentSessionSummary {
    const createdAt = dshTimestamp(
      this.agent.session.header.createdAt,
      "session creation timestamp",
    );
    const lastEventTime = this.agent.session.events.at(-1)?.time;
    const title = this.title?.trim();
    return {
      createdAt,
      ref: this.ref,
      runtimeStatus: this.runtimeStatus(),
      ...(title ? { title } : {}),
      updatedAt:
        lastEventTime !== undefined && Number.isFinite(lastEventTime)
          ? dshTimestamp(lastEventTime, "session update timestamp")
          : createdAt,
    };
  }

  private assertAttached(runtime: DshLocalSessionRuntime): void {
    this.assertOpen();
    if (runtime !== this.runtime) {
      throw new AgentBackendError("closed", "The DSH session runtime is no longer connected");
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new AgentBackendError("closed", "The DSH session runtime is closed");
  }

  private recordInboxSplice(event: DshSessionEvent): void {
    if (event.type !== "agent/inbox/spliced") return;
    if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) {
      throw new AgentBackendError("protocol", "DSH inbox splice is invalid");
    }
    const data = event.data as Record<string, unknown>;
    const target = data.target;
    if (target !== "next-step" && target !== "next-turn") {
      throw new AgentBackendError("protocol", "DSH inbox target is invalid");
    }
    const rawStart = data.start;
    const rawRemovedCount = data.removedCount ?? 0;
    const inserted = data.inserted;
    if (
      typeof rawStart !== "number" ||
      !Number.isSafeInteger(rawStart) ||
      rawStart < 0 ||
      typeof rawRemovedCount !== "number" ||
      !Number.isSafeInteger(rawRemovedCount) ||
      rawRemovedCount < 0 ||
      !Array.isArray(inserted)
    ) {
      throw new AgentBackendError("protocol", "DSH inbox splice coordinates are invalid");
    }
    const start = rawStart;
    const removedCount = rawRemovedCount;
    const pendingIds = this.pendingInboxIds[target];
    if (start > pendingIds.length || start + removedCount > pendingIds.length) {
      throw new AgentBackendError("protocol", "DSH inbox splice exceeds its pending state");
    }
    const insertedIds = inserted.map((message) => {
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        throw new AgentBackendError("protocol", "DSH inbox message is invalid");
      }
      const id = String((message as Record<string, unknown>).id).trim();
      if (!id) throw new AgentBackendError("protocol", "DSH inbox message id is invalid");
      return id;
    });
    if (new Set(insertedIds).size !== insertedIds.length) {
      throw new AgentBackendError("protocol", "DSH inbox splice contains duplicate messages");
    }
    const removedIds = new Set(pendingIds.slice(start, start + removedCount));
    if (insertedIds.some((id) => this.pendingInputTimes.has(id) && !removedIds.has(id))) {
      throw new AgentBackendError("protocol", "DSH inbox message identity is duplicated");
    }
    const queuedAt = dshTimestamp(event.time, "DSH inbox timestamp");
    const removed = pendingIds.splice(start, removedCount);
    for (const id of removed) this.pendingInputTimes.delete(id);
    pendingIds.splice(start, 0, ...insertedIds);
    for (const id of insertedIds) this.pendingInputTimes.set(id, queuedAt);
  }

  private createUserMessage(content: readonly DshUserMessageContent[]): DshUserMessage {
    return this.host.createUserMessage(content);
  }

  private emitDurable(
    native: DshSessionEvent,
    entry: AgentSessionProjection["entries"][number],
    settlesEntryId?: ReturnType<typeof agentEntryId>,
  ): void {
    this.deltaCoalescer.flush();
    this.cursor = nextAgentDeliveryCursor(this.cursor);
    this.runtime?.publish({
      cursor: this.cursor,
      durability: "durable",
      eventId: agentEventId(dshEventIdentity(native, "entry")),
      occurredAt: dshTimestamp(native.time),
      payload: {
        entry,
        ...(settlesEntryId === undefined ? {} : { settlesEntryId }),
      },
      sessionId: this.ref.sessionId,
      source: this.source(native.type),
      type: "entry.appended",
    });
  }

  private emitDelta(
    native: DshSessionEvent,
    suffix: string,
    entryId: ReturnType<typeof agentEntryId>,
    part: "text" | "thinking" | "tool_input" | "tool_output",
    delta: string,
    blockIndex: number,
  ): void {
    this.deltaCoalescer.push({
      eventId: agentEventId(dshEventIdentity(native, suffix)),
      occurredAt: dshTimestamp(native.time),
      payload: { blockIndex, delta, entryId, part },
      sessionId: this.ref.sessionId,
      source: this.source(native.type),
    });
  }

  private publishDelta(delta: DshDeltaInput): void {
    const runtime = this.runtime;
    if (runtime === undefined) return;
    const key = String(delta.payload.entryId);
    const chunkSeq = (this.deltaSequence.get(key) ?? 0) + 1;
    this.deltaSequence.set(key, chunkSeq);
    runtime.publish({
      ...delta,
      durability: "transient",
      payload: { ...delta.payload, chunkSeq },
      type: "entry.delta",
    });
  }

  private emitToolCallState(event: DshSessionEvent): void {
    if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) return;
    const data = event.data as Readonly<Record<string, unknown>>;
    const callId = data.callId;
    const name = data.name;
    if (typeof callId !== "string" || !callId || typeof name !== "string" || !name) return;
    const entryId = agentEntryId(`tool-${callId}`);
    const input =
      typeof data.arguments === "string"
        ? (() => {
            try {
              return dshJson(JSON.parse(data.arguments));
            } catch {
              return undefined;
            }
          })()
        : undefined;
    this.overlayTools.set(String(entryId), { callId, name });
    this.emitToolState(event, "tool-start", {
      callId,
      entryId,
      ...(input === undefined ? {} : { input }),
      name,
      status: "running",
    });
  }

  private emitToolState(
    native: DshSessionEvent,
    suffix: string,
    tool: {
      readonly callId: string;
      readonly content?: readonly AgentContentBlock[];
      readonly entryId: ReturnType<typeof agentEntryId>;
      readonly input?: AgentJsonValue;
      readonly name: string;
      readonly status: "pending" | "running" | "success" | "error" | "cancelled";
    },
  ): void {
    this.deltaCoalescer.flush();
    this.runtime?.publish({
      durability: "transient",
      eventId: agentEventId(dshEventIdentity(native, suffix)),
      occurredAt: dshTimestamp(native.time),
      payload: { tool },
      sessionId: this.ref.sessionId,
      source: this.source(native.type),
      type: "tool.state.changed",
    });
  }

  private emitState(native: DshSessionEvent, suffix: string, patch: AgentSessionStatePatch): void {
    this.deltaCoalescer.flush();
    this.stateRevision += 1;
    this.runtime?.publish({
      durability: "transient",
      eventId: agentEventId(dshEventIdentity(native, suffix)),
      occurredAt: dshTimestamp(native.time),
      payload: { patch, revision: this.stateRevision },
      sessionId: this.ref.sessionId,
      source: this.source(native.type),
      type: "session.state.changed",
    });
  }

  private emitActivity(
    native: DshSessionEvent,
    payload: Extract<AgentSessionEvent, { readonly type: "run.activity" }>["payload"],
  ): void {
    this.deltaCoalescer.flush();
    this.runtime?.publish({
      durability: "transient",
      eventId: agentEventId(dshEventIdentity(native, "activity")),
      occurredAt: dshTimestamp(native.time),
      payload,
      sessionId: this.ref.sessionId,
      source: this.source(native.type),
      type: "run.activity",
    });
  }

  private emitModelState(occurredAt: AgentTimestamp, suffix: string): void {
    if (this.selectedModel === undefined) return;
    this.deltaCoalescer.flush();
    this.stateRevision += 1;
    this.runtime?.publish({
      durability: "transient",
      eventId: agentEventId(`orbis:${this.ref.sessionId}:${suffix}:${this.stateRevision}`),
      occurredAt,
      payload: {
        patch: { model: this.selectedModel, updatedAt: occurredAt },
        revision: this.stateRevision,
      },
      sessionId: this.ref.sessionId,
      source: this.source("orbis/model-selection"),
      type: "session.state.changed",
    });
  }

  private source(nativeType: string): AgentSessionEvent["source"] {
    return {
      backendId: this.ref.backendId,
      driverId: this.ref.driverId,
      nativeType,
      ...(this.host.driverDescriptor.version === undefined
        ? {}
        : { version: this.host.driverDescriptor.version }),
    };
  }

  private emitChunkEvents(event: DshSessionEvent): void {
    const data = event.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      this.deltaCoalescer.flush();
      return;
    }
    const payload = data as Record<string, unknown>;
    const turn = payload.turn;
    const step = payload.step;
    const chunk = payload.chunk;
    if (
      !Number.isSafeInteger(turn) ||
      !Number.isSafeInteger(step) ||
      typeof chunk !== "object" ||
      chunk === null ||
      Array.isArray(chunk)
    ) {
      this.deltaCoalescer.flush();
      return;
    }
    const turnNumber = turn as number;
    const stepNumber = step as number;
    const chunkValue = chunk as Record<string, unknown>;
    const blockIndex =
      typeof chunkValue.index === "number" &&
      Number.isSafeInteger(chunkValue.index) &&
      chunkValue.index >= 0
        ? chunkValue.index
        : undefined;
    const messageId = `message-${turnNumber}-${stepNumber}`;
    switch (chunkValue.type) {
      case "block-start":
        this.deltaCoalescer.flush();
        return;
      case "text-delta":
      case "reasoning-delta": {
        if (blockIndex === undefined) {
          this.deltaCoalescer.flush();
          return;
        }
        const text = chunkValue.text;
        if (typeof text !== "string") {
          this.deltaCoalescer.flush();
          return;
        }
        this.emitDelta(
          event,
          "message-delta",
          agentEntryId(messageId),
          chunkValue.type === "text-delta" ? "text" : "thinking",
          text,
          blockIndex,
        );
        return;
      }
      case "tool-call-delta": {
        if (blockIndex === undefined) {
          this.deltaCoalescer.flush();
          return;
        }
        const callId = chunkValue.id;
        const delta = chunkValue.argumentsDelta;
        if (typeof callId !== "string" || !callId || typeof delta !== "string") {
          this.deltaCoalescer.flush();
          return;
        }
        const entryId = agentEntryId(`tool-${callId}`);
        const previous = this.overlayTools.get(String(entryId));
        const name = chunkValue.name;
        if (typeof name === "string" && name.length > 0) {
          this.overlayTools.set(String(entryId), { callId, name });
        }
        const tool = this.overlayTools.get(String(entryId));
        if (previous === undefined && tool !== undefined) {
          this.emitToolState(event, "tool-pending", {
            callId,
            entryId,
            name: tool.name,
            status: "pending",
          });
        }
        this.emitDelta(event, "tool-delta", entryId, "tool_input", delta, blockIndex);
        return;
      }
      default:
        this.deltaCoalescer.flush();
        return;
    }
  }
}
