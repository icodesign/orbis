import {
  BlockAssembler,
  expandAssistantStream,
  type AssistantStreamRecord,
} from "@deepseek-ai/dsh-llm";
import {
  AgentBackendError,
  agentDeliveryCursor,
  agentEntryId,
  agentRunId,
  agentTimestamp,
  createAgentSessionProjection,
  validateAgentWorkState,
  type AgentContentBlock,
  type AgentContextEntry,
  type AgentContextOrigin,
  type AgentEntryScope,
  type AgentJsonValue,
  type AgentMessageEntry,
  type AgentModelSelection,
  type AgentWorkState,
  type AgentPublicError,
  type AgentRunOutcome,
  type AgentRunSummary,
  type AgentSessionEntry,
  type AgentSessionMetadata,
  type AgentSessionMetadataPatch,
  type AgentSessionProjection,
  type AgentSessionRef,
  type AgentTimestamp,
  type AgentToolEntry,
  type AgentUsage,
} from "@orbisapp/orbis-agent-backend";

import type {
  DshSessionEvent,
  DshSessionInspection,
  DshSessionProjectionValues,
  DshModelTarget,
} from "./dsh-types";

type JsonRecord = Readonly<Record<string, unknown>>;

interface DshToolCall {
  readonly input?: AgentJsonValue;
  readonly name: string;
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentBackendError("protocol", `DSH ${label} is invalid`);
  }
  return value as JsonRecord;
}

function requiredString(value: JsonRecord, key: string, label: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new AgentBackendError("protocol", `DSH ${label} is invalid`);
  }
  return candidate;
}

function optionalString(value: JsonRecord, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function imageReference(value: JsonRecord): AgentContentBlock {
  const attachment = record(value.attachment, "image attachment");
  const attachmentId = requiredString(attachment, "attachmentId", "image attachment id");
  const mediaType = requiredString(attachment, "mediaType", "image attachment media type");
  const bytes = attachment.bytes;
  const width = attachment.width;
  const height = attachment.height;
  if (
    !Number.isSafeInteger(bytes) ||
    (bytes as number) < 1 ||
    !Number.isSafeInteger(width) ||
    (width as number) < 1 ||
    !Number.isSafeInteger(height) ||
    (height as number) < 1
  ) {
    throw new AgentBackendError("protocol", "DSH image attachment metadata is invalid");
  }
  const name = optionalString(attachment, "name");
  return {
    attachmentId,
    bytes: bytes as number,
    height: height as number,
    mimeType: mediaType,
    ...(name === undefined ? {} : { name }),
    type: "image_reference",
    width: width as number,
  };
}

export function dshTimestamp(value: number, label = "event timestamp"): AgentTimestamp {
  if (!Number.isFinite(value)) {
    throw new AgentBackendError("protocol", `DSH ${label} is invalid`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AgentBackendError("protocol", `DSH ${label} is invalid`);
  }
  return agentTimestamp(date.toISOString());
}

export function dshRunId(turn: number): ReturnType<typeof agentRunId> {
  if (!Number.isSafeInteger(turn) || turn < 1) {
    throw new AgentBackendError("protocol", "DSH turn number is invalid");
  }
  return agentRunId(`turn-${turn}`);
}

function dshEntryId(event: DshSessionEvent): ReturnType<typeof agentEntryId> {
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
    throw new AgentBackendError("protocol", "DSH event sequence is invalid");
  }
  if (event.type === "assistant/message") {
    const data = record(event.data, "assistant message");
    const turn =
      typeof data.turn === "number" && Number.isSafeInteger(data.turn) ? data.turn : undefined;
    const step =
      typeof data.step === "number" && Number.isSafeInteger(data.step) ? data.step : undefined;
    if (turn !== undefined && step !== undefined) {
      return agentEntryId(`message-${turn}-${step}`);
    }
  }
  if (event.type === "tool/result") {
    const data = record(event.data, "tool result");
    const message = record(data.message, "tool result message");
    const source = record(message.source, "tool result source");
    const callId = optionalString(source, "callId");
    if (callId !== undefined) return agentEntryId(`tool-${callId}`);
  }
  return agentEntryId(`event-${event.seq}`);
}

export function dshEventIdentity(event: DshSessionEvent, suffix: string): string {
  if (!Number.isSafeInteger(event.seq) || event.seq < 0 || !suffix) {
    throw new AgentBackendError("protocol", "DSH event identity is invalid");
  }
  return `event-${event.seq}-${suffix}`;
}

export function dshJson(value: unknown): AgentJsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const result: AgentJsonValue[] = [];
    for (const item of value) {
      const mapped = dshJson(item);
      if (mapped === undefined) return undefined;
      result.push(mapped);
    }
    return result;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const result: Record<string, AgentJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const mapped = dshJson(item);
    if (mapped === undefined) return undefined;
    result[key] = mapped;
  }
  return result;
}

function contentBlocks(value: unknown, toolCalls: Map<string, DshToolCall>): AgentContentBlock[] {
  if (!Array.isArray(value)) {
    throw new AgentBackendError("protocol", "DSH message content is invalid");
  }
  const blocks: AgentContentBlock[] = [];
  for (const rawBlock of value) {
    const block = record(rawBlock, "message content block");
    const type = requiredString(block, "type", "message content block type");
    switch (type) {
      case "text":
      case "reasoning": {
        // DSH keeps empty blocks so `replayState.blocks` stays index-aligned; a
        // reasoning block can carry only a provider signature. Neither has a
        // canonical presentation.
        const text = block.text;
        if (typeof text !== "string") {
          throw new AgentBackendError("protocol", `DSH ${type} block is invalid`);
        }
        if (text.length > 0) blocks.push({ text, type: type === "text" ? "text" : "thinking" });
        break;
      }
      case "image":
        blocks.push(imageReference(block));
        break;
      case "tool-call": {
        const callId = requiredString(block, "id", "tool call id");
        const name = requiredString(block, "name", "tool call name");
        const argumentsValue = requiredString(block, "arguments", "tool call arguments");
        const input = parseToolArguments(argumentsValue);
        toolCalls.set(callId, { ...(input === undefined ? {} : { input }), name });
        blocks.push({
          callId,
          ...(input === undefined ? {} : { input }),
          name,
          type: "tool_call",
        });
        break;
      }
      case "resource": {
        const uri = optionalString(block, "uri");
        const name = optionalString(block, "name");
        if (uri !== undefined && name !== undefined) blocks.push({ name, type: "resource", uri });
        break;
      }
      default:
        // DSH's content block table is merge-extensible. A future block must
        // gain a canonical product representation before it is exposed here.
        break;
    }
  }
  return blocks;
}

export function dshContentBlocks(value: unknown): readonly AgentContentBlock[] {
  return contentBlocks(value, new Map<string, DshToolCall>());
}

function parseToolArguments(value: string): AgentJsonValue | undefined {
  try {
    return dshJson(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function toolResultContentBlocks(value: unknown): readonly AgentContentBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: AgentContentBlock[] = [];
  for (const rawBlock of value) {
    if (typeof rawBlock !== "object" || rawBlock === null || Array.isArray(rawBlock)) continue;
    const block = rawBlock as JsonRecord;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ text: block.text, type: "text" });
    } else if (block.type === "reasoning" && typeof block.text === "string") {
      blocks.push({ text: block.text, type: "thinking" });
    } else if (block.type === "image") {
      blocks.push(imageReference(block));
    } else if (
      block.type === "resource" &&
      typeof block.name === "string" &&
      typeof block.uri === "string"
    ) {
      blocks.push({ name: block.name, type: "resource", uri: block.uri });
    }
  }
  return blocks;
}

/**
 * The distinct `field` values of an array-valued source member as one name, in
 * first-seen order; `undefined` when the member names nothing readable.
 */
function producerName(source: JsonRecord, member: string, field: string): string | undefined {
  const list = source[member];
  if (!Array.isArray(list)) return undefined;
  const names: string[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const value = optionalString(item as JsonRecord, field);
    if (value !== undefined && !names.includes(value)) names.push(value);
  }
  return names.length === 0 ? undefined : names.join(", ");
}

/** The message's durable `source` record, or `undefined` when it carries none readable. */
function messageSource(message: JsonRecord): JsonRecord | undefined {
  const value = message.source;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/**
 * The role and producer name presented for one producer-supplied context.
 *
 * DSH's source map is merge-extensible, so there is no exhaustive union to
 * switch on. An unknown producer names itself with its own `kind`, which is what
 * keeps a resumed or foreign log identifiable without shipping a new adapter.
 */
function contextProvenance(source: JsonRecord | undefined): {
  readonly label?: string;
  readonly origin: AgentContextOrigin;
} {
  const kind = source === undefined ? undefined : optionalString(source, "kind");
  if (source === undefined || kind === undefined) return { origin: "inject" };
  switch (kind) {
    // The one source that carries another session's material; its references
    // name the sessions it was read from.
    case "session-reference":
      return { label: producerName(source, "references", "label") ?? kind, origin: "recall" };
    // Workspace instructions name the files they reconciled, which identifies
    // the producer far better than the plugin that assembled them.
    case "workspace-instructions":
      return { label: producerName(source, "changes", "path") ?? kind, origin: "inject" };
    default:
      return { label: kind, origin: "inject" };
  }
}

function projectUserMessage(
  event: DshSessionEvent,
  toolCalls: Map<string, DshToolCall>,
): AgentContextEntry | AgentMessageEntry | undefined {
  const message = record(event.data, "user message");
  if (message.role !== "user") {
    throw new AgentBackendError("protocol", "DSH user message has an invalid role");
  }
  const content = contentBlocks(message.content, toolCalls);
  if (content.length === 0) return undefined;
  const base = {
    content,
    createdAt: dshTimestamp(event.time),
    cursor: agentDeliveryCursor(0),
    id: dshEntryId(event),
    parentId: null,
  } as const;
  const source = messageSource(message);
  if (source !== undefined && optionalString(source, "kind") === "user") {
    return { ...base, kind: "message", role: "user" };
  }
  const provenance = contextProvenance(source);
  // The durable source verbatim, keyed by the driver that wrote it. The canonical
  // fields above are what any client can render; a client that wants this
  // driver's own fidelity -- the reconciled file list, the catalog entries, the
  // snapshot sections -- reads them from here, and falls back to the canonical
  // presentation when the record is absent or shaped differently than it expects.
  const meta = source === undefined ? undefined : dshJson({ dsh: source });
  return {
    ...base,
    ...(meta === undefined ? {} : { _meta: meta }),
    kind: "context",
    ...(provenance.label === undefined ? {} : { label: provenance.label }),
    origin: provenance.origin,
  };
}

/** Dynamic tool changes are model context; retain the native blocks for driver-aware clients. */
function projectDeveloperMessage(event: DshSessionEvent): AgentContextEntry {
  const data = record(event.data, "developer message");
  const message = record(data.message, "developer message payload");
  if (message.role !== "developer" || !Array.isArray(message.content)) {
    throw new AgentBackendError("protocol", "DSH developer message is invalid");
  }
  const content = message.content.map((raw): AgentContentBlock => {
    const block = record(raw, "developer content block");
    if (block.type !== "tool-addition" && block.type !== "tool-removal") {
      throw new AgentBackendError("protocol", "DSH developer tool change is invalid");
    }
    const name = requiredString(block, "toolName", "developer tool name");
    return {
      type: "text",
      text: `${block.type === "tool-addition" ? "Added" : "Removed"} tool: ${name}`,
    };
  });
  const source = messageSource(message);
  const meta = dshJson({
    ...(source === undefined ? {} : { dsh: source }),
    dshDeveloper: data,
  });
  return {
    content,
    createdAt: dshTimestamp(event.time),
    cursor: agentDeliveryCursor(0),
    id: dshEntryId(event),
    kind: "context",
    label: "Tools",
    origin: "inject",
    parentId: null,
    ...(meta === undefined ? {} : { _meta: meta }),
  };
}

function projectAssistantMessage(
  event: DshSessionEvent,
  toolCalls: Map<string, DshToolCall>,
): AgentMessageEntry | undefined {
  const data = record(event.data, "assistant message");
  const message = record(data.message, "assistant message payload");
  if (message.role !== "assistant") {
    throw new AgentBackendError("protocol", "DSH assistant message has an invalid role");
  }
  const content = contentBlocks(message.content, toolCalls);
  const source =
    message.source === undefined ? undefined : record(message.source, "assistant message source");
  const provider = source === undefined ? undefined : optionalString(source, "provider");
  const modelId = source === undefined ? undefined : optionalString(source, "model");
  const usage = usageFromDsh(data.usage);
  // DSH 0.1.1 marks an assistant message that was interrupted before a
  // terminal turn event with its native interrupted flag. Keep that
  // vocabulary inside the adapter and expose only the canonical protocol
  // stop reason.
  const stopReason: AgentMessageEntry["stopReason"] =
    data.interrupted === true ? "aborted" : undefined;
  // DSH permits an empty assistant message to carry usage at a max-token
  // boundary. Preserve that accounting as a contentless canonical entry so a
  // run-level presentation can include it without inventing provider totals.
  return {
    content,
    createdAt: dshTimestamp(event.time),
    cursor: agentDeliveryCursor(0),
    id: dshEntryId(event),
    kind: "message",
    ...(modelId === undefined || provider === undefined ? {} : { model: { modelId, provider } }),
    parentId: null,
    role: "assistant",
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function usageFromDsh(value: unknown): AgentUsage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const inputTokens = (value as JsonRecord).inputTokens;
  const outputTokens = (value as JsonRecord).outputTokens;
  if (
    typeof inputTokens !== "number" ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  ) {
    return undefined;
  }
  const optionalNumber = (key: string): number | undefined => {
    const candidate = (value as JsonRecord)[key];
    return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : undefined;
  };
  const cacheReadTokens = optionalNumber("cacheReadTokens");
  const cacheWriteTokens = optionalNumber("cacheWriteTokens");
  return {
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    inputTokens,
    outputTokens,
  };
}

function rememberToolCall(event: DshSessionEvent, toolCalls: Map<string, DshToolCall>): void {
  const data = record(event.data, "tool call");
  const callId = requiredString(data, "callId", "tool call id");
  const name = requiredString(data, "name", "tool call name");
  const argumentsValue = requiredString(data, "arguments", "tool call arguments");
  const input = parseToolArguments(argumentsValue);
  toolCalls.set(callId, { ...(input === undefined ? {} : { input }), name });
}

function projectToolResult(
  event: DshSessionEvent,
  toolCalls: Map<string, DshToolCall>,
): AgentToolEntry {
  const data = record(event.data, "tool result");
  const message = record(data.message, "tool result message");
  const source = record(message.source, "tool result source");
  const callId = requiredString(source, "callId", "tool result call id");
  if (message.role !== "tool" || message.toolCallId !== callId || source.kind !== "tool") {
    throw new AgentBackendError("protocol", "DSH tool result is not paired with its call");
  }
  if (!Array.isArray(message.content)) {
    throw new AgentBackendError("protocol", "DSH tool result content is invalid");
  }
  const call = toolCalls.get(callId);
  const output = dshJson(message.content);
  const contentBlocks = toolResultContentBlocks(message.content);
  const isError = message.isError === true;
  return {
    callId,
    ...(call?.input === undefined ? {} : { input: call.input }),
    content: contentBlocks,
    createdAt: dshTimestamp(event.time),
    cursor: agentDeliveryCursor(0),
    id: dshEntryId(event),
    kind: "tool",
    name: call?.name ?? "unknown-tool",
    parentId: null,
    ...(output === undefined ? {} : { output }),
    status: isError ? "error" : "success",
  };
}

function lifecycleNumber(event: DshSessionEvent, key: "step" | "turn", label: string): number {
  const value = record(event.data, label)[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AgentBackendError("protocol", `DSH ${label} ${key} is invalid`);
  }
  return value as number;
}

function projectSystemMessage(event: DshSessionEvent): AgentMessageEntry {
  const data = record(record(event.data, "system event").message, "system message");
  if (data.role !== "system") throw new AgentBackendError("protocol", "Invalid DSH system role");
  return {
    content: contentBlocks(data.content, new Map()),
    createdAt: dshTimestamp(event.time),
    cursor: agentDeliveryCursor(0),
    id: dshEntryId(event),
    kind: "message",
    parentId: null,
    role: "system",
  };
}

/** Failed attempts are durable too; use DSH's canonical safe-prefix assembly. */
function projectAssistantAttempt(event: DshSessionEvent): AgentMessageEntry {
  const data = record(event.data, "assistant attempt");
  if (!Array.isArray(data.stream))
    throw new AgentBackendError("protocol", "Invalid DSH attempt stream");
  const assembler = new BlockAssembler();
  for (const { chunk } of expandAssistantStream(data.stream as AssistantStreamRecord[]))
    assembler.push(chunk);
  const usage = usageFromDsh(assembler.usage);
  return {
    content: contentBlocks(assembler.interruptedBlocks(), new Map()),
    createdAt: dshTimestamp(event.time),
    cursor: agentDeliveryCursor(0),
    id: dshEntryId(event),
    kind: "message",
    parentId: null,
    role: "assistant",
    stopReason: assembler.finish.kind === "aborted" ? "aborted" : "error",
    ...(usage === undefined ? {} : { usage }),
  };
}

/** Stateful only to retain call metadata from DSH's append-only event log. */
export class DshSessionEntryProjector {
  private readonly toolCalls = new Map<string, DshToolCall>();
  private activeRunId: AgentEntryScope["runId"] | undefined;
  private activeStepId: string | undefined;

  project(event: DshSessionEvent): AgentSessionEntry | undefined {
    if (event.type === "turn/start") {
      this.activeRunId = dshRunId(lifecycleNumber(event, "turn", "turn start"));
      this.activeStepId = undefined;
    } else if (event.type === "step/start") {
      this.activeStepId = String(lifecycleNumber(event, "step", "step start"));
    }

    let entry: AgentSessionEntry | undefined;
    switch (event.type) {
      case "user/message":
        entry = projectUserMessage(event, this.toolCalls);
        break;
      case "assistant/message":
        entry = projectAssistantMessage(event, this.toolCalls);
        break;
      case "tool/call":
        rememberToolCall(event, this.toolCalls);
        break;
      case "tool/result":
        entry = projectToolResult(event, this.toolCalls);
        break;
      case "system/message":
        entry = projectSystemMessage(event);
        break;
      case "developer/message":
        entry = projectDeveloperMessage(event);
        break;
      case "assistant/attempt":
        entry = projectAssistantAttempt(event);
        break;
    }

    const scope =
      this.activeRunId === undefined
        ? undefined
        : {
            runId: this.activeRunId,
            ...(this.activeStepId === undefined ? {} : { stepId: this.activeStepId }),
          };
    const scopedEntry =
      entry === undefined || scope === undefined ? entry : { ...entry, scope: { ...scope } };

    if (event.type === "step/end") this.activeStepId = undefined;
    if (event.type === "turn/end") {
      this.activeRunId = undefined;
      this.activeStepId = undefined;
    }
    return scopedEntry;
  }
}

export function modelSelectionFromTarget(target: DshModelTarget): AgentModelSelection {
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

function modelFromRequestHeader(event: DshSessionEvent): AgentModelSelection | undefined {
  if (event.type !== "request/header") return undefined;
  const data = record(event.data, "request header");
  const header = record(data.header, "request header payload");
  const config = record(header.config, "request model configuration");
  const provider = optionalString(config, "provider");
  const modelId = optionalString(config, "model");
  if (provider === undefined || modelId === undefined) return undefined;
  const thinkingLevel = optionalString(config, "reasoningEffort");
  return { modelId, provider, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) };
}

/** The title carried by one event, so a live owner can fold it incrementally. */
export function titleForDshEvent(event: DshSessionEvent): string | undefined {
  if (event.type !== "session/title") return undefined;
  return optionalString(record(event.data, "session title"), "title");
}

export function metadataPatchForDshEvent(
  event: DshSessionEvent,
): AgentSessionMetadataPatch | undefined {
  const model = modelFromRequestHeader(event);
  if (model !== undefined) return { model };
  const title = titleForDshEvent(event);
  return title === undefined ? undefined : { title };
}

function metadataForInspection(inspection: DshSessionInspection): AgentSessionMetadata {
  if (!Number.isFinite(inspection.meta.createdAt)) {
    throw new AgentBackendError("protocol", "DSH session creation timestamp is invalid");
  }
  const target = inspection.projections.modelSelection?.next;
  const model = target == null ? undefined : modelSelectionFromTarget(target);
  let title: string | undefined;
  for (const event of inspection.events) {
    title = titleForDshEvent(event) ?? title;
  }
  const updatedAt = inspection.events.at(-1)?.time ?? inspection.meta.createdAt;
  return {
    createdAt: dshTimestamp(inspection.meta.createdAt, "session creation timestamp"),
    ...(model === undefined ? {} : { model }),
    ...(title === undefined ? {} : { title }),
    updatedAt: dshTimestamp(updatedAt),
  };
}

export interface DshNativeProjectionState {
  readonly mode: "plan" | null;
  readonly workState: AgentWorkState;
}

function protocolStateError(message: string, cause?: unknown): AgentBackendError {
  if (cause instanceof AgentBackendError && cause.code === "protocol") return cause;
  return new AgentBackendError("protocol", message);
}

/** Converts native wire values; DSH owns all log folding and domain validation. */
export function dshProjectionState(values: DshSessionProjectionValues): DshNativeProjectionState {
  try {
    let goal: unknown = null;
    if (values.goal !== undefined && values.goal !== null) {
      const projection = record(values.goal, "goal projection");
      const nativeGoal = record(projection.goal, "goal projection snapshot");
      goal = {
        ...nativeGoal,
        createdAt: dshTimestamp(projection.createdAt as number, "goal created timestamp"),
        updatedAt: dshTimestamp(projection.updatedAt as number, "goal updated timestamp"),
        roundsStarted: projection.roundsStarted,
      };
    }
    return {
      mode: values.plan?.active === true ? "plan" : null,
      workState: validateAgentWorkState({ goal, todos: values.todos ?? [] }),
    };
  } catch (error) {
    throw protocolStateError("DSH work-state projection is invalid", error);
  }
}

function turnNumber(event: DshSessionEvent, label: string): number {
  const turn = record(event.data, label).turn;
  if (!Number.isSafeInteger(turn) || (turn as number) < 1) {
    throw new AgentBackendError("protocol", `DSH ${label} turn is invalid`);
  }
  return turn as number;
}

function outcomeForTurnEnd(event: DshSessionEvent): {
  readonly error?: AgentPublicError;
  readonly outcome: AgentRunOutcome;
} {
  const reason = record(record(event.data, "turn end").reason, "turn end reason");
  switch (reason.kind) {
    case "aborted":
      return { outcome: "cancelled" };
    case "error": {
      const failure = record(reason.error, "turn failure");
      const code = optionalString(failure, "code") ?? "dsh.run_failed";
      const message = optionalString(failure, "message") ?? "The DSH run failed.";
      return { error: { code, message }, outcome: "failed" };
    }
    case "interrupted":
      return {
        error: { code: "dsh.interrupted", message: "The DSH run was interrupted." },
        outcome: "failed",
      };
    case "blocked":
    case "forked":
    case "completed":
    case "max-tokens":
      return { outcome: "completed" };
    default:
      return {
        error: { code: "dsh.unknown_outcome", message: "The DSH run ended unexpectedly." },
        outcome: "failed",
      };
  }
}

export function runStartForDshEvent(
  event: DshSessionEvent,
): { readonly id: ReturnType<typeof agentRunId>; readonly startedAt: AgentTimestamp } | undefined {
  if (event.type !== "turn/start") return undefined;
  return { id: dshRunId(turnNumber(event, "turn start")), startedAt: dshTimestamp(event.time) };
}

export function runFinishForDshEvent(event: DshSessionEvent):
  | {
      readonly error?: AgentPublicError;
      readonly finishedAt: AgentTimestamp;
      readonly outcome: AgentRunOutcome;
      readonly runId: ReturnType<typeof agentRunId>;
    }
  | undefined {
  if (event.type !== "turn/end") return undefined;
  const { error, outcome } = outcomeForTurnEnd(event);
  return {
    ...(error === undefined ? {} : { error }),
    finishedAt: dshTimestamp(event.time),
    outcome,
    runId: dshRunId(turnNumber(event, "turn end")),
  };
}

export function nextDshRunId(events: readonly DshSessionEvent[]): ReturnType<typeof agentRunId> {
  let lastTurn = 0;
  for (const event of events) {
    if (event.type === "turn/start") lastTurn = turnNumber(event, "turn start");
  }
  return dshRunId(lastTurn + 1);
}

function runStateForInspection(events: readonly DshSessionEvent[]): {
  readonly activeRun?: AgentRunSummary;
  readonly lastRun?: AgentRunSummary;
  readonly state: AgentSessionProjection["state"];
} {
  let activeRun: AgentRunSummary | undefined;
  let lastRun: AgentRunSummary | undefined;
  for (const event of events) {
    const started = runStartForDshEvent(event);
    if (started !== undefined) {
      if (activeRun !== undefined) {
        throw new AgentBackendError("protocol", "DSH session has overlapping turns");
      }
      activeRun = { ...started, state: "running" };
      continue;
    }
    const finished = runFinishForDshEvent(event);
    if (finished === undefined) continue;
    if (activeRun === undefined || activeRun.id !== finished.runId) {
      throw new AgentBackendError("protocol", "DSH session has an unmatched turn end");
    }
    lastRun = {
      ...(finished.error === undefined ? {} : { error: finished.error }),
      finishedAt: finished.finishedAt,
      id: activeRun.id,
      startedAt: activeRun.startedAt,
      state: finished.outcome,
    };
    activeRun = undefined;
  }
  return {
    ...(activeRun === undefined ? {} : { activeRun }),
    ...(lastRun === undefined ? {} : { lastRun }),
    state: activeRun === undefined ? (lastRun?.state === "failed" ? "error" : "idle") : "running",
  };
}

/** Materializes DSH's canonical append-only log into the product projection. */
export function readDshSessionProjection(
  ref: AgentSessionRef,
  inspection: DshSessionInspection,
): AgentSessionProjection {
  const projector = new DshSessionEntryProjector();
  const snapshot = createAgentSessionProjection(ref, metadataForInspection(inspection));
  const run = runStateForInspection(inspection.events);
  const state = dshProjectionState(inspection.projections);
  return {
    ...snapshot,
    ...(run.activeRun === undefined ? {} : { activeRun: run.activeRun }),
    entries: inspection.events.flatMap((event) => {
      const entry = projector.project(event);
      return entry === undefined ? [] : [entry];
    }),
    ...(run.lastRun === undefined ? {} : { lastRun: run.lastRun }),
    mode: state.mode,
    revision: inspection.events.length,
    state: run.state,
    workState: state.workState,
  };
}
