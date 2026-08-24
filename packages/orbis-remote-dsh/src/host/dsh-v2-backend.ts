import {
  AgentBackendError,
  agentBackendId,
  agentDeliveryCursor,
  agentRunId,
  agentTimestamp,
  createAgentDriverDescriptor,
  type AgentJsonValue,
  type AgentQueuedInput,
  type AgentContentBlock,
  type AgentPromptContentBlock,
  type AgentPromptReferenceCompletionInput,
  type AgentPromptReferenceCompletionResult,
  type AgentDriverDescriptor,
  type AgentModelMetadata,
  type AgentSessionEntry,
  type AgentSessionEvent,
  type AgentSessionProjection,
  type AgentSessionRef,
  type AgentSessionStatePatch,
  type AgentSessionSubagentEntry,
  type AgentWorkspaceFolderDescriptor,
  type AgentWorkspaceFolderListing,
  type AgentWorkspaceRegisterResult,
} from "@orbisapp/orbis-agent-backend";
import type {
  RemoteAgentV2Backend,
  RemoteAgentV2ContentBlock,
  RemoteAgentV2Entry,
  RemoteAgentV2ModelSelection,
  RemoteAgentV2Overlay,
  RemoteAgentV2RunSummary,
  RemoteAgentV2Runtime,
  RemoteAgentV2SessionEvent,
  RemoteAgentV2SessionRecord,
  RemoteAgentV2SessionSnapshot,
  RemoteAgentV2SessionState,
  RemoteAgentV2SessionStatePatch,
  RemoteAgentV2SessionSummary,
} from "@orbisapp/remote-agent-protocol";

import { DshLocalBackend, type DshLocalSessionRuntime } from "../adapter";

const DSH_HOST_BACKEND_ID = agentBackendId("dsh-host");

export interface DshRemoteWorkspaceProvider {
  browse(input: {
    readonly folderRef?: string;
    readonly signal?: AbortSignal;
  }): Promise<AgentWorkspaceFolderListing>;
  create(input: {
    readonly folderRef: string;
    readonly name: string;
  }): Promise<AgentWorkspaceFolderDescriptor>;
  register(input: { readonly folderRef: string }): Promise<AgentWorkspaceRegisterResult>;
}

function runState(projection: AgentSessionProjection): RemoteAgentV2SessionState["runState"] {
  if (projection.state === "running") return "running";
  if (projection.state === "error") return "error";
  return "idle";
}

function runSummary(
  run: NonNullable<AgentSessionProjection["activeRun"]>,
): RemoteAgentV2RunSummary {
  const terminal = run.state === "cancelled" || run.state === "completed" || run.state === "failed";
  return {
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(terminal ? { outcome: run.state } : {}),
    runId: run.id,
    startedAt: run.startedAt,
  };
}

function v2Entry(
  entry: AgentSessionEntry,
  parentId: RemoteAgentV2Entry["parentId"],
): RemoteAgentV2Entry {
  const base = {
    ...(entry._meta === undefined ? {} : { _meta: entry._meta }),
    createdAt: entry.createdAt,
    cursor: agentDeliveryCursor(0),
    id: entry.id,
    parentId,
  };
  switch (entry.kind) {
    case "message":
      return {
        ...base,
        content: entry.content,
        kind: "message",
        role: entry.role,
        ...(entry.errorMessage === undefined ? {} : { errorMessage: entry.errorMessage }),
        ...(entry.model === undefined ? {} : { model: entry.model }),
        ...(entry.stopReason === undefined ? {} : { stopReason: entry.stopReason }),
        ...(entry.usage === undefined ? {} : { usage: entry.usage }),
      };
    case "tool":
      return {
        ...base,
        callId: entry.callId,
        ...(entry.content === undefined ? {} : { content: entry.content }),
        ...(entry.input === undefined ? {} : { input: entry.input }),
        ...(entry.output === undefined ? {} : { output: entry.output }),
        kind: "tool",
        name: entry.name,
        status: entry.status,
      };
    case "notice":
      return {
        ...base,
        code: entry.code,
        kind: "notice",
        level: entry.level,
        message: entry.message,
      };
    case "context":
      return {
        ...base,
        content: entry.content,
        kind: "context",
        ...(entry.label === undefined ? {} : { label: entry.label }),
        origin: entry.origin,
      };
  }
}

function v2Snapshot(
  ref: AgentSessionRef,
  projection: AgentSessionProjection,
  overlay?: RemoteAgentV2Overlay,
  stateRevision = projection.revision,
  context: {
    readonly cwd?: string | null;
    readonly pendingInputs?: readonly AgentQueuedInput[];
  } = {},
): RemoteAgentV2SessionSnapshot {
  let parentId: RemoteAgentV2Entry["parentId"] = null;
  const entries = projection.entries.map((entry) => {
    const mapped = v2Entry(entry, parentId);
    parentId = mapped.id;
    return mapped;
  });
  const state: RemoteAgentV2SessionState = {
    activeRun: projection.activeRun === undefined ? undefined : runSummary(projection.activeRun),
    configOptions: projection.configOptions ?? [],
    createdAt: projection.metadata.createdAt,
    cwd: context.cwd ?? null,
    lastRun: projection.lastRun === undefined ? undefined : runSummary(projection.lastRun),
    leafEntryId: entries.at(-1)?.id ?? null,
    mode: projection.mode ?? null,
    model: projection.metadata.model ?? null,
    pendingInputs: context.pendingInputs ?? [],
    pendingPermissions: projection.pendingPermissions ?? [],
    pendingQuestions: projection.pendingQuestions,
    ref,
    revision: stateRevision,
    runState: runState(projection),
    title: projection.metadata.title ?? null,
    updatedAt: projection.metadata.updatedAt,
    workspaceRef: projection.workspaceRef ?? null,
    workState: projection.workState,
  };
  return { ...(overlay === undefined ? {} : { overlay }), entries, state };
}

function source(
  ref: AgentSessionRef,
  native: AgentSessionEvent["source"],
): RemoteAgentV2SessionEvent["source"] {
  return {
    backendId: ref.backendId,
    driverId: ref.driverId,
    ...(native.nativeType === undefined ? {} : { nativeType: native.nativeType }),
    ...(native.version === undefined ? {} : { version: native.version }),
  };
}

function baseEvent(ref: AgentSessionRef, event: AgentSessionEvent) {
  return {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    sessionId: ref.sessionId,
    source: source(ref, event.source),
  };
}

function eventEntry(
  ref: AgentSessionRef,
  event: Extract<AgentSessionEvent, { type: "entry.appended" }>,
  parentId: RemoteAgentV2Entry["parentId"],
): RemoteAgentV2SessionEvent {
  return {
    ...baseEvent(ref, event),
    channel: "replayable",
    cursor: agentDeliveryCursor(0),
    entry: v2Entry(event.payload.entry, parentId),
    ...(event.payload.settlesEntryId === undefined
      ? {}
      : { settlesEntryId: event.payload.settlesEntryId }),
    type: "entry.appended",
  };
}

function transientDelta(
  ref: AgentSessionRef,
  event: Extract<AgentSessionEvent, { type: "entry.delta" }>,
): RemoteAgentV2SessionEvent {
  return {
    ...baseEvent(ref, event),
    blockIndex: event.payload.blockIndex,
    channel: "transient",
    chunkSeq: event.payload.chunkSeq,
    delta: event.payload.delta,
    entryId: event.payload.entryId,
    part: event.payload.part,
    type: "entry.delta",
  };
}

function transientToolState(
  ref: AgentSessionRef,
  event: Extract<AgentSessionEvent, { type: "tool.state.changed" }>,
): RemoteAgentV2SessionEvent {
  return {
    ...baseEvent(ref, event),
    channel: "transient",
    tool: event.payload.tool,
    type: "tool.state.changed",
  };
}

function statePatch(patch: AgentSessionStatePatch): RemoteAgentV2SessionStatePatch {
  return {
    ...(patch.activeRun === undefined
      ? {}
      : {
          activeRun:
            patch.activeRun === null
              ? null
              : { runId: patch.activeRun.id, startedAt: patch.activeRun.startedAt },
        }),
    ...(patch.lastRun === undefined
      ? {}
      : {
          lastRun:
            patch.lastRun === null
              ? null
              : {
                  ...(patch.lastRun.error === undefined ? {} : { error: patch.lastRun.error }),
                  ...(patch.lastRun.finishedAt === undefined
                    ? {}
                    : { finishedAt: patch.lastRun.finishedAt }),
                  ...(patch.lastRun.outcome === undefined
                    ? {}
                    : { outcome: patch.lastRun.outcome }),
                  runId: patch.lastRun.id,
                  startedAt: patch.lastRun.startedAt,
                },
        }),
    ...(patch.configOptions === undefined ? {} : { configOptions: patch.configOptions }),
    ...(patch.cwd === undefined ? {} : { cwd: patch.cwd }),
    ...(patch.leafEntryId === undefined ? {} : { leafEntryId: patch.leafEntryId }),
    ...(patch.mode === undefined ? {} : { mode: patch.mode }),
    ...(patch.model === undefined ? {} : { model: patch.model }),
    ...(patch.pendingInputs === undefined ? {} : { pendingInputs: patch.pendingInputs }),
    ...(patch.pendingPermissions === undefined
      ? {}
      : { pendingPermissions: patch.pendingPermissions }),
    ...(patch.pendingQuestions === undefined ? {} : { pendingQuestions: patch.pendingQuestions }),
    ...(patch.runState === undefined ? {} : { runState: patch.runState }),
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.updatedAt === undefined ? {} : { updatedAt: patch.updatedAt }),
    ...(patch.usageTotal === undefined ? {} : { usageTotal: patch.usageTotal }),
    ...(patch.workspaceRef === undefined ? {} : { workspaceRef: patch.workspaceRef }),
    ...(patch.workState === undefined ? {} : { workState: patch.workState }),
  };
}

class DshV2Runtime implements RemoteAgentV2Runtime {
  readonly ref: AgentSessionRef;
  private readonly listeners = new Set<(event: RemoteAgentV2SessionEvent) => void>();
  private readonly removeNative: () => void;
  private lastEntryId: RemoteAgentV2Entry["id"] | null;
  private overlay: RemoteAgentV2Overlay | undefined;
  private readonly toolInputBuffers = new Map<string, string>();
  /** Identities that have been durably settled; late deltas must not recreate them. */
  private readonly settledEntries = new Set<string>();
  private closed = false;

  constructor(
    private readonly backend: DshRemoteV2Backend,
    private readonly native: DshLocalSessionRuntime,
    ref: AgentSessionRef,
    projection: AgentSessionProjection,
    initialOverlay: RemoteAgentV2Overlay | undefined,
    private readonly setOverlay: (overlay: RemoteAgentV2Overlay | undefined) => void,
  ) {
    this.ref = ref;
    this.lastEntryId = projection.entries.at(-1)?.id ?? null;
    this.overlay =
      initialOverlay ??
      (projection.activeRun === undefined
        ? undefined
        : { runId: projection.activeRun.id, runningTools: [] });
    this.setOverlay(this.overlay);
    this.removeNative = native.subscribe((event) => {
      const mapped = this.mapEvent(event);
      if (mapped === undefined) return;
      for (const listener of this.listeners) {
        try {
          listener(mapped);
        } catch {
          // Runtime observers are passive.
        }
      }
    });
  }

  async cancel(input: {
    readonly runId?: ReturnType<typeof agentRunId>;
    readonly keepInbox?: boolean;
    readonly idempotencyKey?: string;
  }): Promise<{ readonly cancelled: boolean }> {
    this.assertOpen();
    return this.native.cancel({ keepInbox: input.keepInbox });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeNative();
    await this.native.close();
  }

  async prompt(input: {
    readonly content: readonly AgentPromptContentBlock[];
    readonly delivery?: "steer" | "follow_up";
    readonly idempotencyKey?: string;
  }): Promise<{
    readonly runId: ReturnType<typeof agentRunId>;
    readonly acceptedAt: ReturnType<typeof agentTimestamp>;
    readonly queued: boolean;
  }> {
    this.assertOpen();
    const receipt = await this.native.prompt({
      ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      content: input.content,
    });
    return {
      acceptedAt: receipt.acceptedAt,
      queued: input.delivery !== undefined,
      runId: receipt.runId,
    };
  }

  async respondPermission(input: {
    readonly requestId: string;
    readonly optionId: string;
    readonly idempotencyKey?: string;
  }): Promise<{ readonly accepted: boolean }> {
    this.assertOpen();
    return this.native.respondPermission({
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      optionId: input.optionId,
      requestId: input.requestId,
    });
  }

  async respondQuestion(input: {
    readonly requestId: string;
    readonly response: Parameters<DshLocalSessionRuntime["respondQuestion"]>[0]["response"];
    readonly idempotencyKey?: string;
  }): Promise<{ readonly accepted: boolean }> {
    this.assertOpen();
    return this.native.respondQuestion({
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      requestId: input.requestId,
      response: input.response,
    });
  }

  subscribe(listener: (event: RemoteAgentV2SessionEvent) => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private mapEvent(event: AgentSessionEvent): RemoteAgentV2SessionEvent | undefined {
    switch (event.type) {
      case "entry.appended": {
        const mapped = eventEntry(this.ref, event, this.lastEntryId);
        this.lastEntryId = event.payload.entry.id;
        if (event.payload.settlesEntryId !== undefined) {
          this.settledEntries.add(String(event.payload.settlesEntryId));
        }
        this.removeCommittedOverlay(
          event.payload.settlesEntryId,
          event.payload.entry.kind === "tool" ? event.payload.entry.callId : undefined,
        );
        return mapped;
      }
      case "entry.delta": {
        this.appendMessageOverlay(event);
        return transientDelta(this.ref, event);
      }
      case "tool.state.changed":
        this.updateToolState(event);
        return transientToolState(this.ref, event);
      case "session.state.changed": {
        const patch = statePatch(event.payload.patch);
        if (patch.pendingInputs !== undefined)
          this.backend.updatePendingInputs(this.ref.sessionId, patch.pendingInputs);
        if (patch.activeRun !== undefined && patch.activeRun !== null) {
          this.updateOverlay({ runId: patch.activeRun.runId, runningTools: [] });
        } else if (patch.activeRun === null || patch.lastRun !== undefined) {
          this.updateOverlay(undefined);
        }
        return {
          ...baseEvent(this.ref, event),
          channel: "state",
          patch,
          revision: this.backend.nextStateRevision(this.ref.sessionId),
          type: "session.state.changed",
        };
      }
      case "run.activity":
        return {
          ...baseEvent(this.ref, event),
          channel: "transient",
          detail: event.payload.detail,
          kind: event.payload.kind,
          runId: event.payload.runId,
          type: "run.activity",
        };
      case "presence.changed":
        return {
          ...baseEvent(this.ref, event),
          channel: "transient",
          devices: event.payload.devices,
          type: "presence.changed",
        };
      default:
        return undefined;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new AgentBackendError("closed", "The DSH v2 runtime is closed");
  }

  private updateOverlay(overlay: RemoteAgentV2Overlay | undefined): void {
    this.overlay = overlay;
    this.setOverlay(overlay);
  }

  private appendMessageOverlay(event: Extract<AgentSessionEvent, { type: "entry.delta" }>): void {
    if (this.settledEntries.has(String(event.payload.entryId))) return;
    if (event.payload.part === "tool_input") {
      this.updateToolInput(event);
      return;
    }
    if (event.payload.part === "tool_output") {
      this.appendToolOutput(event);
      return;
    }
    const current = this.overlay;
    if (current === undefined) return;
    const streaming = current.streaming ?? {
      blocks: [],
      entryId: event.payload.entryId,
      chunkSeq: 0,
    };
    const blocks = [...streaming.blocks];
    const type = event.payload.part === "thinking" ? "thinking" : "text";
    const index = blocks.findIndex((block) => block.blockIndex === event.payload.blockIndex);
    const previous = index === -1 ? undefined : blocks[index]?.content;
    if (previous !== undefined && previous.type !== type) return;
    if (previous?.type === type) {
      blocks[index] = {
        blockIndex: event.payload.blockIndex,
        content: { ...previous, text: `${previous.text}${event.payload.delta}` },
      };
    } else {
      blocks.push({
        blockIndex: event.payload.blockIndex,
        content: { text: event.payload.delta, type },
      });
      blocks.sort((left, right) => left.blockIndex - right.blockIndex);
    }
    this.updateOverlay({
      ...current,
      streaming: { ...streaming, blocks, chunkSeq: event.payload.chunkSeq },
    });
  }

  private appendToolOutput(event: Extract<AgentSessionEvent, { type: "entry.delta" }>): void {
    const current = this.overlay;
    if (current === undefined) return;
    const existing = current.runningTools.find((tool) => tool.entryId === event.payload.entryId);
    if (existing === undefined) return;
    const content = [
      ...(existing?.content ?? []),
      { text: event.payload.delta, type: "text" as const },
    ];
    this.updateOverlay({
      ...current,
      runningTools: [
        ...current.runningTools.filter((candidate) => candidate.entryId !== event.payload.entryId),
        { ...existing, chunkSeq: event.payload.chunkSeq, content },
      ],
    });
  }

  private updateToolInput(event: Extract<AgentSessionEvent, { type: "entry.delta" }>): void {
    const current = this.overlay;
    if (current === undefined) return;
    const existing = current.runningTools.find((tool) => tool.entryId === event.payload.entryId);
    if (existing === undefined) return;

    const key = String(existing.entryId);
    const buffered = `${this.toolInputBuffers.get(key) ?? ""}${event.payload.delta}`;
    this.toolInputBuffers.set(key, buffered);
    let input: AgentJsonValue | undefined;
    try {
      input = JSON.parse(buffered) as AgentJsonValue;
    } catch {
      input = undefined;
    }

    this.updateOverlay({
      ...current,
      runningTools: current.runningTools.map((tool) =>
        tool.entryId === existing.entryId
          ? {
              ...tool,
              ...(input === undefined ? {} : { input }),
              chunkSeq: event.payload.chunkSeq,
            }
          : tool,
      ),
    });
  }

  private updateToolState(event: Extract<AgentSessionEvent, { type: "tool.state.changed" }>): void {
    const current = this.overlay;
    if (current === undefined) return;
    const state = event.payload.tool;
    const existing = current.runningTools.find(
      (tool) => tool.entryId === state.entryId || tool.callId === state.callId,
    );
    const matches = (tool: RemoteAgentV2Overlay["runningTools"][number]) =>
      tool.entryId === state.entryId || tool.callId === state.callId;

    if (state.status === "success" || state.status === "error" || state.status === "cancelled") {
      this.settledEntries.add(String(state.entryId));
      this.toolInputBuffers.delete(String(state.entryId));
      const runningTools = current.runningTools.filter((tool) => !matches(tool));
      if (runningTools.length === current.runningTools.length) return;
      this.updateOverlay({ ...current, runningTools });
      return;
    }
    if (this.settledEntries.has(String(state.entryId))) return;

    const key = String(state.entryId);
    if (state.input !== undefined) this.toolInputBuffers.delete(key);
    const bufferedInput = this.parseBufferedToolInput(key);
    const input = state.input ?? existing?.input ?? bufferedInput;
    const content = state.content ?? existing?.content;
    const tool = {
      callId: state.callId,
      entryId: state.entryId,
      name: state.name,
      status: state.status,
      ...(input === undefined ? {} : { input }),
      ...(content === undefined ? {} : { content }),
      chunkSeq: existing?.chunkSeq ?? 0,
    };
    this.updateOverlay({
      ...current,
      runningTools: [...current.runningTools.filter((candidate) => !matches(candidate)), tool],
    });
  }

  private parseBufferedToolInput(key: string): AgentJsonValue | undefined {
    const buffered = this.toolInputBuffers.get(key);
    if (buffered === undefined) return undefined;
    try {
      return JSON.parse(buffered) as AgentJsonValue;
    } catch {
      return undefined;
    }
  }

  private removeCommittedOverlay(
    settlesEntryId: AgentSessionEntry["id"] | undefined,
    callId?: string,
  ): void {
    const current = this.overlay;
    if (current === undefined || settlesEntryId === undefined) return;
    const streaming = current.streaming?.entryId === settlesEntryId ? undefined : current.streaming;
    const runningTools = current.runningTools.filter(
      (tool) => tool.entryId !== settlesEntryId && (callId === undefined || tool.callId !== callId),
    );
    this.toolInputBuffers.delete(String(settlesEntryId));
    if (callId !== undefined) {
      for (const tool of current.runningTools) {
        if (tool.callId === callId) this.toolInputBuffers.delete(String(tool.entryId));
      }
    }
    if (streaming === current.streaming && runningTools.length === current.runningTools.length)
      return;
    if (streaming === undefined) {
      const { streaming: _streaming, ...withoutStreaming } = current;
      this.updateOverlay({ ...withoutStreaming, runningTools });
    } else {
      this.updateOverlay({ ...current, runningTools, streaming });
    }
  }
}

export class DshRemoteV2Backend implements RemoteAgentV2Backend {
  readonly hostId = DSH_HOST_BACKEND_ID;
  private readonly overlays = new Map<string, RemoteAgentV2Overlay>();
  private readonly pendingInputs = new Map<string, readonly AgentQueuedInput[]>();
  private readonly stateRevisions = new Map<string, number>();
  private readonly sessionCwds = new Map<string, string | null>();

  constructor(
    readonly native: DshLocalBackend,
    private readonly workspaces?: DshRemoteWorkspaceProvider,
  ) {}

  async close(): Promise<void> {
    await this.native.close();
  }

  async connectRuntime(ref: AgentSessionRef): Promise<RemoteAgentV2Runtime> {
    const nativeRuntime = await this.native.connectRuntime(ref);
    this.pendingInputs.set(ref.sessionId, nativeRuntime.pendingInputs());
    const projection = await this.native.readSession(ref);
    this.setStateRevision(ref.sessionId, await this.native.readStateRevision(ref));
    return new DshV2Runtime(
      this,
      nativeRuntime,
      ref,
      projection,
      this.overlays.get(ref.sessionId),
      (overlay) => {
        if (overlay === undefined) this.overlays.delete(ref.sessionId);
        else this.overlays.set(ref.sessionId, overlay);
      },
    );
  }

  async createSession(input: {
    readonly driverId: AgentSessionRef["driverId"];
    readonly model?: RemoteAgentV2ModelSelection;
    readonly mode?: string;
    readonly title?: string;
    readonly workspaceRef?: string;
    readonly nativeSessionId?: string;
  }): Promise<RemoteAgentV2SessionRecord> {
    if (input.mode !== undefined) {
      throw new AgentBackendError("unsupported", "DSH session mode is selected after creation");
    }
    const record = await this.native.createSession({
      driverId: input.driverId,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.nativeSessionId === undefined
        ? {}
        : { nativeSessionId: input.nativeSessionId as never }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.workspaceRef === undefined ? {} : { workspaceRef: input.workspaceRef }),
    });
    const projection = await this.native.readSession(record.ref);
    return {
      createdAt: record.createdAt,
      driverId: record.ref.driverId,
      ref: record.ref,
      runState: runState(projection),
      title: projection.metadata.title ?? null,
      updatedAt: record.updatedAt,
    };
  }

  async listDrivers(): Promise<readonly AgentDriverDescriptor[]> {
    const drivers = await this.native.listDrivers();
    if (this.workspaces === undefined) return drivers;
    return drivers.map((driver) =>
      createAgentDriverDescriptor({
        availability: driver.availability,
        capabilities: [...driver.capabilities, "workspace.open"],
        displayName: driver.displayName,
        id: driver.id,
        ...(driver.version === undefined ? {} : { version: driver.version }),
      }),
    );
  }

  async browseWorkspaceFolders(
    driverId: AgentSessionRef["driverId"],
    folderRef?: string,
    signal?: AbortSignal,
  ): Promise<AgentWorkspaceFolderListing> {
    this.assertDshDriver(driverId);
    if (this.workspaces === undefined) {
      throw new AgentBackendError("unsupported", "Server folder browsing is unavailable");
    }
    return this.workspaces.browse({ ...(folderRef === undefined ? {} : { folderRef }), signal });
  }

  async createWorkspaceFolder(
    driverId: AgentSessionRef["driverId"],
    parentFolderRef: string,
    name: string,
  ): Promise<AgentWorkspaceFolderDescriptor> {
    this.assertDshDriver(driverId);
    if (this.workspaces === undefined) {
      throw new AgentBackendError("unsupported", "Server folder creation is unavailable");
    }
    return this.workspaces.create({ folderRef: parentFolderRef, name });
  }

  async registerWorkspace(
    driverId: AgentSessionRef["driverId"],
    folderRef: string,
  ): Promise<AgentWorkspaceRegisterResult> {
    this.assertDshDriver(driverId);
    if (this.workspaces === undefined) {
      throw new AgentBackendError("unsupported", "Server workspace registration is unavailable");
    }
    return this.workspaces.register({ folderRef });
  }

  async listModels(driverId?: AgentSessionRef["driverId"]): Promise<readonly AgentModelMetadata[]> {
    return this.native.listModels({ driverId });
  }

  async listWorkspaces(driverId: AgentSessionRef["driverId"]) {
    return this.native.listWorkspaces({ driverId });
  }

  async updateSession(
    ref: AgentSessionRef,
    patch: Parameters<RemoteAgentV2Backend["updateSession"]>[1],
  ): Promise<void> {
    await this.native.updateSession(ref, { patch });
  }

  async readAttachment(ref: AgentSessionRef, attachmentId: string, signal?: AbortSignal) {
    return this.native.readAttachment(ref, attachmentId, signal);
  }

  async completePromptReferences(
    input: AgentPromptReferenceCompletionInput,
  ): Promise<AgentPromptReferenceCompletionResult | undefined> {
    return this.native.completePromptReferences(input);
  }

  async listSessions(input: {
    readonly driverId?: AgentSessionRef["driverId"];
  }): Promise<readonly RemoteAgentV2SessionSummary[]> {
    const sessions = await this.native.listSessions(input);
    return sessions.map((session) => ({
      driverId: session.ref.driverId,
      ref: session.ref,
      runState: session.runtimeStatus === "running" ? "running" : "idle",
      title: session.title ?? null,
      updatedAt: session.updatedAt,
    }));
  }

  async listSessionSubagents(
    ref: AgentSessionRef,
    signal?: AbortSignal,
  ): Promise<readonly AgentSessionSubagentEntry[]> {
    this.assertDshDriver(ref.driverId);
    return this.native.listSessionSubagents(ref, signal);
  }

  observeCatalog(listener: () => void): () => void {
    return this.native.observeCatalog(() => listener());
  }

  async readSession(ref: AgentSessionRef): Promise<RemoteAgentV2SessionSnapshot> {
    const projection = await this.native.readSession(ref);
    const stateRevision = await this.native.readStateRevision(ref);
    this.setStateRevision(ref.sessionId, stateRevision);
    const cwd = await this.cwdFor(ref);
    return v2Snapshot(ref, projection, this.overlays.get(ref.sessionId), stateRevision, {
      cwd,
      pendingInputs: this.pendingInputs.get(ref.sessionId),
    });
  }

  private assertDshDriver(driverId: AgentSessionRef["driverId"]): void {
    if (driverId !== this.native.driverDescriptor.id) {
      throw new AgentBackendError("not_found", "The DSH driver is unavailable");
    }
  }

  nextStateRevision(sessionId: AgentSessionRef["sessionId"]): number {
    const revision = (this.stateRevisions.get(sessionId) ?? 0) + 1;
    this.stateRevisions.set(sessionId, revision);
    return revision;
  }

  updatePendingInputs(
    sessionId: AgentSessionRef["sessionId"],
    pendingInputs: readonly AgentQueuedInput[],
  ): void {
    this.pendingInputs.set(sessionId, pendingInputs);
  }

  private setStateRevision(sessionId: AgentSessionRef["sessionId"], revision: number): void {
    this.stateRevisions.set(sessionId, Math.max(this.stateRevisions.get(sessionId) ?? 0, revision));
  }

  private async cwdFor(ref: AgentSessionRef): Promise<string | null> {
    const existing = this.sessionCwds.get(ref.sessionId);
    if (existing !== undefined) return existing;
    const inspection = await this.native.inspect(ref);
    const cwd = inspection.meta.cwd ?? null;
    this.sessionCwds.set(ref.sessionId, cwd);
    return cwd;
  }
}
