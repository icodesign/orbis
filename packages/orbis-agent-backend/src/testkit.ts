import type {
  AgentBackend,
  AgentBackendDescriptor,
  AgentCancelInput,
  AgentCancelResult,
  AgentHarnessDriver,
  AgentModelListInput,
  AgentModelMetadata,
  AgentWorkspaceDescriptor,
  AgentWorkspaceBrowseInput,
  AgentWorkspaceCreateFolderInput,
  AgentWorkspaceFolderDescriptor,
  AgentWorkspaceFolderListing,
  AgentWorkspaceListInput,
  AgentWorkspaceRegisterInput,
  AgentWorkspaceRegisterResult,
  AgentPromptInput,
  AgentPromptReceipt,
  AgentRuntimeStatus,
  AgentSessionCreateInput,
  AgentSessionListInput,
  AgentSessionRecord,
  AgentSessionRuntime,
  AgentSessionSummary,
  AgentSessionUpdateInput,
  AgentSessionUpdateResult,
} from "./backend";
import type { AgentDriverDescriptor } from "./capabilities";
import { AgentBackendError } from "./errors";
import type {
  AgentEntryAppendedEvent,
  AgentEntryDeltaEvent,
  AgentRunOutcome,
  AgentSessionEvent,
  AgentSessionEventListener,
  AgentSessionMetadata,
  AgentSessionStateChangedEvent,
} from "./events";
import {
  agentDeliveryCursor,
  agentEntryId,
  agentEventId,
  agentNativeSessionId,
  agentRunId,
  agentSessionId,
  agentTimestamp,
  createAgentSessionRef,
  isSameAgentSessionRef,
  nextAgentDeliveryCursor,
  type AgentDeliveryCursor,
  type AgentSessionRef,
  type AgentTimestamp,
} from "./identifiers";
import {
  applyAgentSessionEvent,
  createAgentSessionProjection,
  type AgentSessionProjection,
} from "./projection";

export interface FakeAgentBackendOptions {
  readonly createEntryId?: () => string;
  readonly createEventId?: () => string;
  readonly createRunId?: () => string;
  readonly createSessionId?: () => string;
  readonly descriptor: AgentBackendDescriptor;
  readonly drivers: readonly AgentDriverDescriptor[];
  readonly now?: () => AgentTimestamp;
}

interface FakeRuntimeHost {
  commit(runtime: FakeAgentSessionRuntime, event: AgentSessionEvent): void;
  nextCursor(ref: AgentSessionRef): AgentDeliveryCursor;
  nextEntryId(): string;
  nextEventId(): string;
  nextRunId(): string;
  now(): AgentTimestamp;
}

function counter(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function defaultNow(): AgentTimestamp {
  return agentTimestamp(new Date().toISOString());
}

function title(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new AgentBackendError("invalid_argument", "Session title is invalid");
  }
  return normalized;
}

/**
 * Deterministic in-memory backend for contract tests. It deliberately models
 * several active runtimes and never binds their lifetime to subscriptions.
 */
export class FakeAgentBackend implements AgentBackend, FakeRuntimeHost {
  readonly descriptor: AgentBackendDescriptor;

  private closed = false;
  private readonly createEntryId: () => string;
  private readonly createEventId: () => string;
  private readonly createRunId: () => string;
  private readonly createSessionId: () => string;
  private readonly driversById = new Map<string, FakeAgentHarnessDriver>();
  private readonly records = new Map<string, AgentSessionRecord>();
  private readonly projections = new Map<string, AgentSessionProjection>();
  private readonly runtimes = new Map<string, FakeAgentSessionRuntime>();
  private readonly clock: () => AgentTimestamp;

  constructor(options: FakeAgentBackendOptions) {
    this.descriptor = options.descriptor;
    this.createEntryId = options.createEntryId ?? counter("entry");
    this.createEventId = options.createEventId ?? counter("event");
    this.createRunId = options.createRunId ?? counter("run");
    this.createSessionId = options.createSessionId ?? counter("session");
    this.clock = options.now ?? defaultNow;

    for (const descriptor of options.drivers) {
      if (this.driversById.has(descriptor.id)) {
        throw new AgentBackendError("invalid_argument", "Fake driver ids must be unique");
      }
      this.driversById.set(descriptor.id, new FakeAgentHarnessDriver(this, descriptor));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.close()));
  }

  async browseWorkspaceFolders(
    _input: AgentWorkspaceBrowseInput,
  ): Promise<AgentWorkspaceFolderListing> {
    throw new AgentBackendError("unsupported", "The fake backend cannot browse folders");
  }

  async createWorkspaceFolder(
    _input: AgentWorkspaceCreateFolderInput,
  ): Promise<AgentWorkspaceFolderDescriptor> {
    throw new AgentBackendError("unsupported", "The fake backend cannot create folders");
  }

  async registerWorkspace(
    _input: AgentWorkspaceRegisterInput,
  ): Promise<AgentWorkspaceRegisterResult> {
    throw new AgentBackendError("unsupported", "The fake backend cannot register workspaces");
  }

  async connectRuntime(ref: AgentSessionRef): Promise<FakeAgentSessionRuntime> {
    this.assertOpen();
    this.assertDriverAvailable(ref.driverId);
    this.recordFor(ref);
    const existing = this.runtimes.get(ref.sessionId);
    if (existing && existing.getStatus() !== "closed") return existing;

    const projection = this.projectionFor(ref);
    const runtime = new FakeAgentSessionRuntime(
      this,
      ref,
      projection.activeRun?.id,
      projection.activeRun?.startedAt,
      projection.revision,
    );
    this.runtimes.set(ref.sessionId, runtime);
    return runtime;
  }

  async createSession(input: AgentSessionCreateInput): Promise<AgentSessionRecord> {
    this.assertOpen();
    const driver = this.driversById.get(input.driverId);
    if (!driver) {
      throw new AgentBackendError("unsupported", "The requested driver is unavailable", {
        details: { driverId: input.driverId },
      });
    }
    this.assertDriverAvailable(driver.descriptor.id);

    const sessionId = agentSessionId(this.createSessionId());
    if (this.records.has(sessionId)) {
      throw new AgentBackendError("conflict", "The generated session id already exists", {
        details: { sessionId },
      });
    }
    const nativeSessionId =
      input.nativeSessionId ?? agentNativeSessionId(`native:${input.driverId}:${sessionId}`);
    const now = this.now();
    const ref = createAgentSessionRef({
      backendId: this.descriptor.id,
      driverId: input.driverId,
      nativeSessionId,
      sessionId,
    });
    const metadata: AgentSessionMetadata = {
      createdAt: now,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.title === undefined ? {} : { title: title(input.title) }),
      updatedAt: now,
    };
    const record: AgentSessionRecord = { createdAt: now, ref, updatedAt: now };
    this.records.set(ref.sessionId, record);
    this.projections.set(ref.sessionId, createAgentSessionProjection(ref, metadata));
    return record;
  }

  getDriver(id: string): FakeAgentHarnessDriver {
    const driver = this.driversById.get(id);
    if (!driver) {
      throw new AgentBackendError("not_found", "The requested fake driver was not found", {
        details: { driverId: id },
      });
    }
    return driver;
  }

  async listDrivers(): Promise<readonly AgentDriverDescriptor[]> {
    this.assertOpen();
    return [...this.driversById.values()].map((driver) => driver.descriptor);
  }

  async listModels(_input: AgentModelListInput = {}): Promise<readonly AgentModelMetadata[]> {
    this.assertOpen();
    return [];
  }

  async listWorkspaces(
    _input: AgentWorkspaceListInput,
  ): Promise<readonly AgentWorkspaceDescriptor[]> {
    this.assertOpen();
    return [];
  }

  async listSessions(input: AgentSessionListInput = {}): Promise<readonly AgentSessionSummary[]> {
    this.assertOpen();
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit <= 0)) {
      throw new AgentBackendError("invalid_argument", "Session list limit is invalid");
    }
    const sessions = [...this.records.values()]
      .filter((record) => input.driverId === undefined || record.ref.driverId === input.driverId)
      .map((record) => this.summaryFor(record));
    return input.limit === undefined ? sessions : sessions.slice(0, input.limit);
  }

  async readSession(ref: AgentSessionRef): Promise<AgentSessionProjection> {
    this.assertOpen();
    this.recordFor(ref);
    const projection = this.projections.get(ref.sessionId);
    if (!projection) {
      throw new AgentBackendError("not_found", "The session projection was not found", {
        details: { sessionId: ref.sessionId },
      });
    }
    return projection;
  }

  async updateSession(
    ref: AgentSessionRef,
    _input: AgentSessionUpdateInput,
  ): Promise<AgentSessionUpdateResult> {
    this.assertOpen();
    this.recordFor(ref);
    throw new AgentBackendError("unsupported", "The fake backend does not support session updates");
  }

  commit(runtime: FakeAgentSessionRuntime, event: AgentSessionEvent): void {
    const projection = this.projectionFor(runtime.ref);
    const result = applyAgentSessionEvent(projection, event);
    switch (result.kind) {
      case "applied":
        this.projections.set(runtime.ref.sessionId, result.projection);
        this.touchRecord(runtime.ref, result.projection.metadata.updatedAt);
        runtime.publish(event);
        return;
      case "ignored":
        runtime.publish(event);
        return;
      case "gap":
        throw new AgentBackendError("cursor_gap", "A fake event created a delivery cursor gap", {
          details: {
            expectedCursor: result.expectedCursor,
            receivedCursor: result.receivedCursor,
          },
        });
      case "conflict":
        throw result.error;
    }
  }

  nextCursor(ref: AgentSessionRef): AgentDeliveryCursor {
    return nextAgentDeliveryCursor(this.projectionFor(ref).cursor);
  }

  nextEntryId(): string {
    return this.createEntryId();
  }

  nextEventId(): string {
    return this.createEventId();
  }

  nextRunId(): string {
    return this.createRunId();
  }

  now(): AgentTimestamp {
    return this.clock();
  }

  async closeDriver(driverId: string): Promise<void> {
    const driver = this.driversById.get(driverId);
    if (!driver) return;
    await Promise.all(
      [...this.runtimes.values()]
        .filter((runtime) => runtime.ref.driverId === driver.descriptor.id)
        .map((runtime) => runtime.close()),
    );
  }

  private assertOpen(): void {
    if (this.closed) throw new AgentBackendError("closed", "The fake backend is closed");
  }

  private assertDriverAvailable(driverId: string): void {
    const driver = this.driversById.get(driverId);
    if (!driver) {
      throw new AgentBackendError("not_found", "The requested fake driver was not found", {
        details: { driverId },
      });
    }
    if (!driver.descriptor.availability.available) {
      throw new AgentBackendError("unavailable", "The requested driver is unavailable", {
        details: { driverId, reason: driver.descriptor.availability.reason ?? "Unavailable" },
      });
    }
  }

  private projectionFor(ref: AgentSessionRef): AgentSessionProjection {
    this.recordFor(ref);
    const projection = this.projections.get(ref.sessionId);
    if (!projection) {
      throw new AgentBackendError("not_found", "The session projection was not found", {
        details: { sessionId: ref.sessionId },
      });
    }
    return projection;
  }

  private recordFor(ref: AgentSessionRef): AgentSessionRecord {
    const record = this.records.get(ref.sessionId);
    if (!record) {
      throw new AgentBackendError("not_found", "The session was not found", {
        details: { sessionId: ref.sessionId },
      });
    }
    if (!isSameAgentSessionRef(record.ref, ref)) {
      throw new AgentBackendError("conflict", "The session id was used with another locator", {
        details: { sessionId: ref.sessionId },
      });
    }
    return record;
  }

  private summaryFor(record: AgentSessionRecord): AgentSessionSummary {
    const projection = this.projectionFor(record.ref);
    const runtime = this.runtimes.get(record.ref.sessionId);
    const runtimeStatus =
      runtime?.getStatus() ?? (projection.state === "running" ? "disconnected" : "ready");
    return {
      ...record,
      runtimeStatus,
      ...(projection.metadata.title === undefined ? {} : { title: projection.metadata.title }),
    };
  }

  private touchRecord(ref: AgentSessionRef, updatedAt: AgentTimestamp): void {
    const record = this.recordFor(ref);
    this.records.set(ref.sessionId, { ...record, updatedAt });
  }
}

/** A driver facade that scopes fake backend operations to exactly one harness id. */
export class FakeAgentHarnessDriver implements AgentHarnessDriver {
  constructor(
    private readonly backend: FakeAgentBackend,
    readonly descriptor: AgentDriverDescriptor,
  ) {}

  async close(): Promise<void> {
    await this.backend.closeDriver(this.descriptor.id);
  }

  async connectRuntime(ref: AgentSessionRef): Promise<AgentSessionRuntime> {
    this.assertRef(ref);
    return this.backend.connectRuntime(ref);
  }

  async createSession(
    input: Omit<AgentSessionCreateInput, "driverId"> = {},
  ): Promise<AgentSessionRecord> {
    return this.backend.createSession({ ...input, driverId: this.descriptor.id });
  }

  async listSessions(
    input: Omit<AgentSessionListInput, "driverId"> = {},
  ): Promise<readonly AgentSessionSummary[]> {
    return this.backend.listSessions({ ...input, driverId: this.descriptor.id });
  }

  async listModels(): Promise<readonly AgentModelMetadata[]> {
    return this.backend.listModels({ driverId: this.descriptor.id });
  }

  async listWorkspaces(): Promise<readonly AgentWorkspaceDescriptor[]> {
    return this.backend.listWorkspaces({ driverId: this.descriptor.id });
  }

  async readSession(ref: AgentSessionRef): Promise<AgentSessionProjection> {
    this.assertRef(ref);
    return this.backend.readSession(ref);
  }

  async updateSession(
    ref: AgentSessionRef,
    input: AgentSessionUpdateInput,
  ): Promise<AgentSessionUpdateResult> {
    this.assertRef(ref);
    return this.backend.updateSession(ref, input);
  }

  private assertRef(ref: AgentSessionRef): void {
    if (ref.driverId !== this.descriptor.id) {
      throw new AgentBackendError("conflict", "The session belongs to another driver", {
        details: { driverId: ref.driverId },
      });
    }
  }
}

export class FakeAgentSessionRuntime implements AgentSessionRuntime {
  readonly ref: AgentSessionRef;

  private activeRunId?: ReturnType<typeof agentRunId>;
  private activeRunStartedAt?: AgentTimestamp;
  private stateRevision = 0;
  private readonly deltaSequence = new Map<string, number>();
  private readonly listeners = new Set<AgentSessionEventListener>();
  private status: AgentRuntimeStatus;

  constructor(
    private readonly host: FakeRuntimeHost,
    ref: AgentSessionRef,
    activeRunId?: ReturnType<typeof agentRunId>,
    activeRunStartedAt?: AgentTimestamp,
    stateRevision = 0,
  ) {
    this.ref = ref;
    this.activeRunId = activeRunId;
    this.activeRunStartedAt = activeRunId === undefined ? undefined : activeRunStartedAt;
    this.stateRevision = stateRevision;
    this.status = activeRunId === undefined ? "ready" : "running";
  }

  async cancel(_input: AgentCancelInput = {}): Promise<AgentCancelResult> {
    if (this.status !== "running") return { cancelled: false };
    await this.finish("cancelled");
    return { cancelled: true };
  }

  async close(): Promise<void> {
    if (this.status === "closed") return;
    this.status = "closed";
    this.activeRunId = undefined;
    this.activeRunStartedAt = undefined;
    this.listeners.clear();
  }

  async commitAssistantText(text: string): Promise<AgentEntryAppendedEvent> {
    this.assertOpen();
    if (!this.activeRunId) {
      throw new AgentBackendError("conflict", "A fake message requires an active run");
    }
    const occurredAt = this.host.now();
    const event: AgentEntryAppendedEvent = {
      cursor: this.host.nextCursor(this.ref),
      durability: "durable",
      eventId: agentEventId(this.host.nextEventId()),
      occurredAt,
      payload: {
        entry: {
          content: [{ text, type: "text" }],
          createdAt: occurredAt,
          cursor: agentDeliveryCursor(0),
          id: agentEntryId(this.host.nextEntryId()),
          kind: "message",
          parentId: null,
          role: "assistant",
        },
      },
      sessionId: this.ref.sessionId,
      source: { backendId: this.ref.backendId, driverId: this.ref.driverId },
      type: "entry.appended",
    };
    this.host.commit(this, event);
    return event;
  }

  async emitMessageDelta(text: string, messageId = "stream:1"): Promise<AgentEntryDeltaEvent> {
    this.assertOpen();
    const entryId = agentEntryId(messageId);
    const chunkSeq = (this.deltaSequence.get(String(entryId)) ?? 0) + 1;
    this.deltaSequence.set(String(entryId), chunkSeq);
    const event: AgentEntryDeltaEvent = {
      durability: "transient",
      eventId: agentEventId(this.host.nextEventId()),
      occurredAt: this.host.now(),
      payload: { blockIndex: 0, chunkSeq, delta: text, entryId, part: "text" },
      sessionId: this.ref.sessionId,
      source: { backendId: this.ref.backendId, driverId: this.ref.driverId },
      type: "entry.delta",
    };
    this.host.commit(this, event);
    return event;
  }

  async finish(
    outcome: AgentRunOutcome,
    error?: { readonly code: string; readonly message: string },
  ): Promise<AgentSessionStateChangedEvent> {
    this.assertOpen();
    const runId = this.activeRunId;
    if (!runId) throw new AgentBackendError("conflict", "There is no active fake run to finish");

    const finishedAt = this.host.now();
    const event: AgentSessionStateChangedEvent = {
      durability: "transient",
      eventId: agentEventId(this.host.nextEventId()),
      occurredAt: finishedAt,
      payload: {
        patch: {
          activeRun: null,
          lastRun: {
            ...(error === undefined ? {} : { error }),
            finishedAt,
            id: runId,
            outcome,
            startedAt: this.activeRunStartedAt ?? finishedAt,
          },
          runState: outcome === "failed" ? "error" : "idle",
        },
        revision: ++this.stateRevision,
      },
      sessionId: this.ref.sessionId,
      source: { backendId: this.ref.backendId, driverId: this.ref.driverId },
      type: "session.state.changed",
    };
    const previousStatus = this.status;
    this.activeRunId = undefined;
    this.activeRunStartedAt = undefined;
    this.status = outcome === "failed" ? "error" : "ready";
    try {
      this.host.commit(this, event);
    } catch (error) {
      this.activeRunId = runId;
      this.activeRunStartedAt = event.payload.patch.lastRun?.startedAt;
      this.status = previousStatus;
      throw error;
    }
    return event;
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  async prompt(input: AgentPromptInput): Promise<AgentPromptReceipt> {
    this.assertOpen();
    if (!input.text.trim()) {
      throw new AgentBackendError("invalid_argument", "A prompt must not be empty");
    }
    if (this.status === "running") {
      throw new AgentBackendError("conflict", "The fake runtime already has an active run");
    }

    const runId = agentRunId(this.host.nextRunId());
    const acceptedAt = this.host.now();
    const event: AgentSessionStateChangedEvent = {
      durability: "transient",
      eventId: agentEventId(this.host.nextEventId()),
      occurredAt: acceptedAt,
      payload: {
        patch: { activeRun: { id: runId, startedAt: acceptedAt }, runState: "running" },
        revision: ++this.stateRevision,
      },
      sessionId: this.ref.sessionId,
      source: { backendId: this.ref.backendId, driverId: this.ref.driverId },
      type: "session.state.changed",
    };
    const previousStatus = this.status;
    this.activeRunId = runId;
    this.activeRunStartedAt = acceptedAt;
    this.status = "running";
    try {
      this.host.commit(this, event);
    } catch (error) {
      this.activeRunId = undefined;
      this.status = previousStatus;
      throw error;
    }
    return { acceptedAt, runId };
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Runtime subscribers are passive and cannot reject a committed event.
      }
    }
  }

  private assertOpen(): void {
    if (this.status === "closed") {
      throw new AgentBackendError("closed", "The fake runtime is closed");
    }
  }
}
