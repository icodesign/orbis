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
  type AgentBackend,
  type AgentBackendDescriptor,
  type AgentCancelInput,
  type AgentCancelResult,
  type AgentDriverDescriptor,
  type AgentDriverCapability,
  type AgentHarnessDriver,
  type AgentModelListInput,
  type AgentModelMetadata,
  type AgentQueuedInput,
  type AgentModelSelection,
  type AgentWorkspaceDescriptor,
  type AgentWorkspaceBrowseInput,
  type AgentWorkspaceFolderListing,
  type AgentWorkspaceRegisterInput,
  type AgentWorkspaceRegisterResult,
  type AgentPromptInput,
  type AgentPromptReceipt,
  type AgentRuntimeStatus,
  type AgentSessionCreateInput,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type AgentSessionProjection,
  type AgentSessionRecord,
  type AgentSessionRef,
  type AgentSessionRuntime,
  type AgentSessionSummary,
  type AgentSessionStatePatch,
  type AgentSessionUpdateInput,
  type AgentSessionUpdateResult,
  type AgentTimestamp,
} from "@orbisapp/orbis-agent-backend";

import {
  DshSessionEntryProjector,
  dshEventIdentity,
  dshContentBlocks,
  dshTimestamp,
  metadataPatchForDshEvent,
  nextDshRunId,
  readDshSessionProjection,
  runFinishForDshEvent,
  runStartForDshEvent,
  titleForDshEvent,
} from "./dsh-projection";
import type {
  DshAgent,
  DshAgentHandle,
  DshAgentInboxEvent,
  DshAgentOptions,
  DshApiResponse,
  DshContext,
  DshModelTarget,
  DshSession,
  DshSessionCatalogEntry,
  DshSessionEvent,
  DshSessionInspection,
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
    readonly content: readonly [{ readonly text: string; readonly type: "text" }];
    readonly source: { readonly kind: "user" };
  }) => DshUserMessage;
  /** Allows the composing host to provide a deterministic session-id source. */
  readonly createSessionId?: () => string;
  /** Defaults to the DSH product name. */
  readonly driver?: {
    readonly displayName?: string;
    readonly version?: string;
  };
  /** Defaults applied by DSH whenever a new/reopened agent is acquired. */
  readonly agentOptions?: DshAgentOptions;
  readonly now?: () => AgentTimestamp;
  readonly onError?: (error: AgentBackendError) => void;
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

  createUserMessage(text: string): DshUserMessage;
  detachController(controller: DshLocalSessionController): void;
  inspect(ref: AgentSessionRef): Promise<DshSessionInspection>;
  isCurrentAgent(agent: DshAgent): boolean;
  now(): AgentTimestamp;
  readCurrentModel(ref: AgentSessionRef): Promise<AgentModelSelection | undefined>;
  report(error: AgentBackendError): void;
  selectCurrentModel(
    ref: AgentSessionRef,
    selection: AgentModelSelection,
  ): Promise<AgentModelSelection>;
}

type DshInboxTarget = "next-step" | "next-turn";

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
  if (value.thinkingLevel !== undefined) {
    throw new AgentBackendError("unsupported", "DSH thinking selection is unavailable");
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
      event.type === "agent/inbox/spliced"
    ) {
      revision += 1;
    }
  }
  return revision;
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

function agentOptionsFor(
  defaults: DshAgentOptions | undefined,
  model: AgentModelSelection | undefined,
): DshAgentOptions | undefined {
  if (model === undefined) return defaults;
  return { ...defaults, model: model.modelId, provider: model.provider };
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

/**
 * A harness-neutral local DSH backend over DSH's durable session-persistence
 * catalog. The adapter never treats its active-agent map as history authority.
 */
export class DshLocalBackend implements AgentBackend, DshLocalControllerHost {
  readonly descriptor: AgentBackendDescriptor;
  readonly driverDescriptor: AgentDriverDescriptor;

  private closed = false;
  private readonly controllers = new Map<string, DshLocalSessionController>();
  private readonly opening = new Map<string, Promise<DshLocalSessionController>>();
  private readonly sessionWorkspaceRefs = new Map<string, string>();
  private readonly removeEventListener: () => void;
  private readonly removeInboxEventListeners: readonly (() => void)[];
  private readonly catalogListeners = new Set<DshLocalCatalogListener>();
  private readonly driver: DshLocalHarnessDriver;
  private readonly clock: () => AgentTimestamp;
  private rpcSequence = 0;

  constructor(private readonly options: DshLocalBackendOptions) {
    this.assertOptions(options);
    this.descriptor = createAgentBackendDescriptor({
      displayName: options.backend?.displayName ?? "This device",
      id: options.backend?.id ?? "local",
      kind: "local",
    });
    const capabilities: AgentDriverCapability[] = [
      ...DSH_LOCAL_CAPABILITIES,
      ...(options.context.apiProxy === undefined ? [] : (["model.select"] as const)),
    ];
    this.driverDescriptor = createAgentDriverDescriptor({
      capabilities,
      displayName: options.driver?.displayName ?? "DeepSeek Harness",
      id: DSH_LOCAL_DRIVER_ID,
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
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
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
      let handle: DshAgentHandle | undefined;
      try {
        handle = await this.options.context.agents.create({
          agentOptions: agentOptionsFor(this.options.agentOptions, model),
          meta: { cwd: workspace.path },
          sessionId: this.options.toSessionId(nativeSessionId),
        });
        if (!sameNativeSession(handle.agent.session, nativeSessionId)) {
          throw new AgentBackendError("protocol", "DSH created a session with an unexpected id");
        }
        await workspace.attachSession(this.options.toSessionId(nativeSessionId));
        this.sessionWorkspaceRefs.set(nativeSessionId, workspaceRef);
        const controller = this.installController(ref, handle.agent, handle);
        if (model === undefined) await controller.refreshModelSelection();
        else await controller.initializeModelSelection(model);
        const projection = await this.inspectProjection(ref);
        return {
          createdAt: projection.metadata.createdAt,
          ref: controller.ref,
          updatedAt: projection.metadata.updatedAt,
        };
      } catch (error) {
        await handle?.dispose().catch(() => undefined);
        throw error;
      }
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
    const apiProxy = this.options.context.apiProxy;
    if (apiProxy === undefined) return [];
    return this.withPublicErrors(async () => {
      const value = this.apiValue(
        await apiProxy.llm.models({ payload: {}, rpcId: this.nextRpcId() }),
        "The DSH model catalog is unavailable",
      );
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
      const summaries = [...records.values()];
      summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return input.limit === undefined ? summaries : summaries.slice(0, input.limit);
    });
  }

  async readSession(ref: AgentSessionRef): Promise<AgentSessionProjection> {
    this.assertOpen();
    this.assertDshRef(ref);
    return this.withPublicErrors(async () => {
      const projection = await this.inspectProjection(ref);
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
      return { ...decorated, workspaceRef: await this.workspaceRefFor(ref) };
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
    if (keys.length !== 1 || input.patch.model === undefined) {
      throw new AgentBackendError("unsupported", "DSH only supports session model updates");
    }
    if (input.patch.model === null) {
      throw new AgentBackendError("unsupported", "A DSH session model cannot be cleared");
    }
    const model = optionalModel(input.patch.model)!;
    if (
      input.expectedRevision !== undefined &&
      (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    ) {
      throw new AgentBackendError("invalid_argument", "Expected session revision is invalid");
    }
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

  createUserMessage(text: string): DshUserMessage {
    return this.options.createUserMessage({
      content: [{ text, type: "text" }],
      source: { kind: "user" },
    });
  }

  isCurrentAgent(agent: DshAgent): boolean {
    return this.options.context.agents.get(agent.id) === agent;
  }

  now(): AgentTimestamp {
    return this.clock();
  }

  async readCurrentModel(ref: AgentSessionRef): Promise<AgentModelSelection | undefined> {
    const apiProxy = this.options.context.apiProxy;
    if (apiProxy === undefined) return undefined;
    const value = this.apiValue(
      await apiProxy.sessions.models({
        payload: { sessionId: this.options.toSessionId(ref.nativeSessionId) },
        rpcId: this.nextRpcId(),
      }),
      "The DSH session model is unavailable",
    );
    return modelSelectionFromTarget(value.current);
  }

  async selectCurrentModel(
    ref: AgentSessionRef,
    selection: AgentModelSelection,
  ): Promise<AgentModelSelection> {
    const apiProxy = this.options.context.apiProxy;
    if (apiProxy === undefined) {
      throw new AgentBackendError("unsupported", "DSH session model selection is unavailable");
    }
    const value = this.apiValue(
      await apiProxy.sessions.selectModel({
        payload: {
          model: selection.modelId,
          provider: selection.provider,
          ...(selection.thinkingLevel === undefined
            ? {}
            : { reasoningEffort: selection.thinkingLevel }),
          sessionId: this.options.toSessionId(ref.nativeSessionId),
        },
        rpcId: this.nextRpcId(),
      }),
      "The DSH session model could not be changed",
    );
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
      typeof options.context?.agents?.create !== "function" ||
      typeof options.context?.agents?.resume !== "function" ||
      typeof options.context?.agents?.get !== "function" ||
      typeof options.context?.sessionPersistence?.inspect !== "function" ||
      typeof options.context?.sessionPersistence?.list !== "function" ||
      typeof options.context?.workspace?.get !== "function"
    ) {
      throw new AgentBackendError(
        "invalid_argument",
        "The DSH context does not provide its session persistence and agent lifecycle services",
      );
    }
    const apiProxy = options.context.apiProxy;
    if (
      apiProxy !== undefined &&
      (typeof apiProxy.llm?.models !== "function" ||
        typeof apiProxy.sessions?.models !== "function" ||
        typeof apiProxy.sessions?.selectModel !== "function")
    ) {
      throw new AgentBackendError("invalid_argument", "The DSH API proxy model service is invalid");
    }
  }

  private apiValue<T>(response: DshApiResponse<T>, unavailableMessage: string): T {
    if (response.result.ok) return response.result.value;
    const error = response.result.error;
    switch (error.code) {
      case "agent-busy":
        throw new AgentBackendError("conflict", unavailableMessage);
      case "model-unavailable":
        throw new AgentBackendError("invalid_argument", "The requested DSH model is unavailable");
      case "session-not-found":
        throw new AgentBackendError("not_found", "The requested DSH session was not found");
      default:
        throw publicUnavailable(unavailableMessage);
    }
  }

  private nextRpcId(): string {
    this.rpcSequence += 1;
    return `orbis-dsh-${this.rpcSequence}`;
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
    await this.inspect(ref);
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
    const handle = await this.options.context.agents.resume({
      agentOptions: this.options.agentOptions,
      resumeSessionId: nativeId,
    });
    if (!sameNativeSession(handle.agent.session, ref.nativeSessionId)) {
      await handle.dispose().catch(() => undefined);
      throw new AgentBackendError("protocol", "DSH resumed a session with an unexpected id");
    }
    if (this.closed) {
      await handle.dispose().catch(() => undefined);
      throw new AgentBackendError("closed", "The local DSH backend is closed");
    }
    const controller = this.installController(ref, handle.agent, handle);
    await controller.refreshModelSelection();
    return controller;
  }

  private installController(
    ref: AgentSessionRef,
    agent: DshAgent,
    ownedHandle?: DshAgentHandle,
  ): DshLocalSessionController {
    const key = agentSessionLocatorKey(ref);
    const existing = this.controllers.get(key);
    if (existing !== undefined) {
      if (!existing.isCurrent() || !isSameAgentSessionRef(existing.ref, ref)) {
        throw new AgentBackendError("conflict", "The DSH session controller is conflicted");
      }
      if (ownedHandle !== undefined) {
        void ownedHandle.dispose().catch(() => undefined);
      }
      return existing;
    }
    const controller = new DshLocalSessionController(this, ref, agent, ownedHandle);
    this.controllers.set(key, controller);
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
      throw publicUnavailable();
    }
  }
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

  async listModels(): Promise<readonly AgentModelMetadata[]> {
    return this.backend.listModels({ driverId: this.descriptor.id });
  }

  async listWorkspaces(): Promise<readonly AgentWorkspaceDescriptor[]> {
    return this.backend.listWorkspaces({ driverId: this.descriptor.id });
  }

  async readSession(ref: AgentSessionRef): Promise<AgentSessionProjection> {
    return this.backend.readSession(ref);
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

  constructor(
    private readonly controller: DshLocalSessionController,
    ref: AgentSessionRef,
  ) {
    this.ref = ref;
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

  pendingInputs(): readonly AgentQueuedInput[] {
    return this.controller.pendingInputs();
  }

  overlayTool(entryId: string): { readonly callId: string; readonly name: string } | undefined {
    return this.controller.overlayTool(entryId);
  }

  async prompt(input: AgentPromptInput): Promise<AgentPromptReceipt> {
    this.assertOpen();
    return this.controller.prompt(this, input);
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  markClosed(): void {
    this.closed = true;
    this.listeners.clear();
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
  }

  private assertOpen(): void {
    if (this.closed) throw new AgentBackendError("closed", "The DSH session runtime is closed");
  }
}

/** Owns one DSH agent acquisition and survives runtime-façade/page switches. */
class DshLocalSessionController {
  readonly ref: AgentSessionRef;

  private cursor = agentDeliveryCursor(0);
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
  private readonly pendingInboxIds: Record<DshInboxTarget, string[]> = {
    "next-step": [],
    "next-turn": [],
  };
  private readonly pendingInputTimes = new Map<string, AgentTimestamp>();
  private readonly overlayTools = new Map<
    string,
    { readonly callId: string; readonly name: string }
  >();

  constructor(
    private readonly host: DshLocalControllerHost,
    ref: AgentSessionRef,
    private readonly agent: DshAgent,
    private readonly ownedHandle?: DshAgentHandle,
  ) {
    this.ref = ref;
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
    } catch {
      throw publicUnavailable("The DSH run could not be cancelled");
    }
    return { cancelled: true };
  }

  disconnect(runtime: DshLocalSessionRuntime): void {
    if (runtime !== this.runtime) {
      runtime.markClosed();
      return;
    }
    runtime.markClosed();
    this.runtime = undefined;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.runtime?.markClosed();
    this.runtime = undefined;
    try {
      await this.ownedHandle?.dispose();
    } finally {
      this.host.detachController(this);
    }
  }

  decorateProjection(projection: AgentSessionProjection): AgentSessionProjection {
    if (!this.modelInitialized || this.selectedModel === undefined) return projection;
    return {
      ...projection,
      metadata: {
        ...projection.metadata,
        model: this.selectedModel,
        updatedAt: this.modelSelectedAt ?? projection.metadata.updatedAt,
      },
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

  overlayTool(entryId: string): { readonly callId: string; readonly name: string } | undefined {
    return this.overlayTools.get(entryId);
  }

  async prompt(
    runtime: DshLocalSessionRuntime,
    input: AgentPromptInput,
  ): Promise<AgentPromptReceipt> {
    this.assertAttached(runtime);
    const text = input.text.trim();
    if (!text) throw new AgentBackendError("invalid_argument", "Prompt text is required");
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

    const message = this.createUserMessage(text);
    const runId = running
      ? (activeRunId(inspection) ?? nextDshRunId(inspection.events))
      : nextDshRunId(inspection.events);
    try {
      if (input.delivery === "steer") this.agent.steer(message);
      else this.agent.followup(message);
    } catch {
      throw publicUnavailable("The DSH run could not accept the prompt");
    }
    return { acceptedAt: this.host.now(), runId };
  }

  receive(event: DshSessionEvent): void {
    if (this.disposed) return;
    try {
      this.recordInboxSplice(event);
      const started = runStartForDshEvent(event);
      if (started !== undefined) {
        this.activeRunStartedAt = started.startedAt;
        this.emitState(event, "run-start", { activeRun: started, runState: "running" });
      }

      const metadata = metadataPatchForDshEvent(event);
      if (metadata !== undefined) {
        // An explicit null clears the title; an absent key leaves it alone.
        if (metadata.title !== undefined) this.title = metadata.title ?? undefined;
        this.emitState(event, "metadata", metadata);
      }

      const entry = this.projector.project(event);
      if (entry !== undefined) {
        this.emitDurable(event, entry);
      }

      if (event.type === "assistant/chunk") this.emitChunkEvents(event);

      const finished = runFinishForDshEvent(event);
      if (finished !== undefined) {
        const startedAt = this.activeRunStartedAt ?? finished.finishedAt;
        this.activeRunStartedAt = undefined;
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

  private createUserMessage(text: string): DshUserMessage {
    return this.host.createUserMessage(text);
  }

  private emitDurable(
    native: DshSessionEvent,
    entry: AgentSessionProjection["entries"][number],
  ): void {
    this.cursor = nextAgentDeliveryCursor(this.cursor);
    this.runtime?.publish({
      cursor: this.cursor,
      durability: "durable",
      eventId: agentEventId(dshEventIdentity(native, "entry")),
      occurredAt: dshTimestamp(native.time),
      payload: { entry },
      sessionId: this.ref.sessionId,
      source: this.source(native.type),
      type: "entry.appended",
    });
  }

  private emitDelta(
    native: DshSessionEvent,
    suffix: string,
    entryId: ReturnType<typeof agentEntryId>,
    part: "text" | "thinking" | "tool_output",
    delta: string,
    blockIndex: number,
  ): void {
    const key = String(entryId);
    const chunkSeq = (this.deltaSequence.get(key) ?? 0) + 1;
    this.deltaSequence.set(key, chunkSeq);
    this.runtime?.publish({
      durability: "transient",
      eventId: agentEventId(dshEventIdentity(native, suffix)),
      occurredAt: dshTimestamp(native.time),
      payload: { blockIndex, chunkSeq, delta, entryId, part },
      sessionId: this.ref.sessionId,
      source: this.source(native.type),
      type: "entry.delta",
    });
  }

  private emitState(native: DshSessionEvent, suffix: string, patch: AgentSessionStatePatch): void {
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

  private emitModelState(occurredAt: AgentTimestamp, suffix: string): void {
    if (this.selectedModel === undefined) return;
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
    if (typeof data !== "object" || data === null || Array.isArray(data)) return;
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
        return;
      case "text-delta":
      case "reasoning-delta": {
        if (blockIndex === undefined) return;
        const text = chunkValue.text;
        if (typeof text !== "string") return;
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
        if (blockIndex === undefined) return;
        const callId = chunkValue.id;
        const delta = chunkValue.argumentsDelta;
        if (typeof callId !== "string" || !callId || typeof delta !== "string") return;
        const entryId = agentEntryId(`tool-${callId}`);
        const name = chunkValue.name;
        if (typeof name === "string" && name.length > 0) {
          this.overlayTools.set(String(entryId), { callId, name });
        }
        this.emitDelta(event, "tool-delta", entryId, "tool_output", delta, blockIndex);
        return;
      }
      default:
        return;
    }
  }
}
