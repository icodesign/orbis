import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import {
  AgentBackendError,
  agentBackendId,
  agentDeliveryCursor,
  agentSessionLocatorKey,
  createAgentSessionRef,
  isSameAgentSessionRef,
  type AgentSessionRef,
} from "@orbisapp/orbis-agent-backend";
import type { AgentJsonValue } from "@orbisapp/orbis-agent-backend";
import {
  type RemoteAgentV2HostStore,
  type RemoteAgentV2IdempotencyClaim,
  type RemoteAgentV2StoredEntryIndex,
  type RemoteAgentV2StoredSessionIndex,
} from "@orbisapp/remote-agent-protocol";
import { z } from "zod";

import { hasSharedFileMode } from "./file-permissions";

const STORE_VERSION = 2 as const;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const refSchema = z
  .object({
    backendId: z.string().min(1).max(256),
    driverId: z.string().min(1).max(256),
    nativeSessionId: z.string().min(1).max(256),
    sessionId: z.string().min(1).max(256),
  })
  .strict();
const entryIndexSchema = z
  .object({
    cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    entryId: z.string().min(1).max(512),
  })
  .strict();
const sessionSchema = z.object({ ref: refSchema, entries: z.array(entryIndexSchema) }).strict();
const idempotencySchema = z.discriminatedUnion("kind", [
  z
    .object({
      createdAt: z.number().int().nonnegative(),
      key: z.string().min(1).max(8_192),
      kind: z.literal("pending"),
    })
    .strict(),
  z
    .object({
      createdAt: z.number().int().nonnegative(),
      key: z.string().min(1).max(8_192),
      kind: z.literal("accepted"),
      result: jsonValueSchema,
    })
    .strict(),
]);
const stateSchema = z
  .object({
    hostId: z.string().min(1).max(256),
    hostKeyId: z.string().min(1).max(256),
    hostRevision: z.string().min(1).max(512),
    idempotency: z.array(idempotencySchema),
    sessions: z.array(sessionSchema),
    version: z.literal(STORE_VERSION),
  })
  .strict();

type StoredState = {
  readonly hostId: string;
  readonly hostKeyId: string;
  readonly hostRevision: string;
  readonly idempotency: PersistedIdempotency[];
  readonly sessions: PersistedSession[];
  readonly version: typeof STORE_VERSION;
};

interface PersistedSession extends RemoteAgentV2StoredSessionIndex {
  readonly ref: AgentSessionRef;
}

type PersistedIdempotency =
  | { readonly createdAt: number; readonly key: string; readonly kind: "pending" }
  | {
      readonly createdAt: number;
      readonly key: string;
      readonly kind: "accepted";
      readonly result: AgentJsonValue;
    };

export interface NodeFileRemoteAgentV2HostStoreOptions {
  readonly hostId: string;
  readonly hostKeyId: string;
  /** Bounds retained write admissions; this is not a transcript retention setting. */
  readonly idempotencyTtlMs?: number;
  readonly now?: () => number;
  readonly path: string;
  readonly maxFileBytes?: number;
}

function stateError(): AgentBackendError {
  return new AgentBackendError("protocol", "The v2 remote host state is invalid");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeRef(value: unknown): AgentSessionRef {
  const ref = refSchema.parse(value);
  return createAgentSessionRef(ref);
}

function normalizeEntries(value: unknown): RemoteAgentV2StoredEntryIndex[] {
  const entries = z
    .array(entryIndexSchema)
    .parse(value)
    .map((entry) => ({
      cursor: agentDeliveryCursor(entry.cursor),
      entryId: entry.entryId,
    }));
  let previous = 0;
  for (const entry of entries) {
    if (entry.cursor <= previous) throw stateError();
    previous = entry.cursor;
  }
  return entries;
}

function normalizeSession(value: unknown): PersistedSession {
  const session = sessionSchema.parse(value);
  return { entries: normalizeEntries(session.entries), ref: normalizeRef(session.ref) };
}

function normalizeState(value: unknown): StoredState {
  try {
    const state = stateSchema.parse(value);
    const sessions = state.sessions.map(normalizeSession);
    const sessionKeys = sessions.map((session) => agentSessionLocatorKey(session.ref));
    if (new Set(sessionKeys).size !== sessionKeys.length) throw stateError();
    const idempotency = state.idempotency.map(
      (item): PersistedIdempotency =>
        item.kind === "accepted"
          ? {
              createdAt: item.createdAt,
              key: item.key,
              kind: item.kind,
              result: item.result as AgentJsonValue,
            }
          : { createdAt: item.createdAt, key: item.key, kind: item.kind },
    );
    if (new Set(idempotency.map((item) => item.key)).size !== idempotency.length)
      throw stateError();
    return {
      hostId: agentBackendId(state.hostId),
      hostKeyId: agentBackendId(state.hostKeyId),
      hostRevision: state.hostRevision,
      idempotency,
      sessions,
      version: STORE_VERSION,
    };
  } catch (error) {
    if (error instanceof AgentBackendError) throw error;
    throw stateError();
  }
}

function initialState(hostId: string, hostKeyId: string): StoredState {
  return {
    hostId,
    hostKeyId,
    hostRevision: "1",
    idempotency: [],
    sessions: [],
    version: STORE_VERSION,
  };
}

function revision(value: string): string {
  const current = Number(value);
  if (!Number.isSafeInteger(current) || current < 1 || current >= Number.MAX_SAFE_INTEGER) {
    throw new AgentBackendError("protocol", "The v2 host revision is exhausted");
  }
  return String(current + 1);
}

function hostId(value: string): string {
  try {
    return agentBackendId(value);
  } catch {
    throw new AgentBackendError("invalid_argument", "The v2 host id is invalid");
  }
}

function publicIndex(value: PersistedSession): RemoteAgentV2StoredSessionIndex {
  return { entries: clone(value.entries), ref: clone(value.ref) };
}

/** Atomic Node file store for the v2 index/admission tables only. */
export class NodeFileRemoteAgentV2HostStore implements RemoteAgentV2HostStore {
  private readonly idempotencyTtlMs: number;
  private readonly maxFileBytes: number;
  private readonly now: () => number;
  private stateValue: StoredState | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: NodeFileRemoteAgentV2HostStoreOptions) {
    if (!options.path.trim())
      throw new AgentBackendError("invalid_argument", "The v2 state path is invalid");
    hostId(options.hostId);
    hostId(options.hostKeyId);
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    if (!Number.isSafeInteger(this.idempotencyTtlMs) || this.idempotencyTtlMs < 1_000) {
      throw new AgentBackendError("invalid_argument", "The v2 idempotency TTL is invalid");
    }
    this.now = options.now ?? Date.now;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1_024) {
      throw new AgentBackendError("invalid_argument", "The v2 state file limit is invalid");
    }
  }

  bumpHostRevision(): Promise<string> {
    return this.serialize(async () => {
      const state = await this.load();
      const next = revision(state.hostRevision);
      await this.commit({ ...state, hostRevision: next });
      return next;
    });
  }

  claimIdempotency(key: string): Promise<RemoteAgentV2IdempotencyClaim> {
    return this.serialize(async () => {
      if (!key || key.length > 8_192)
        throw new AgentBackendError("invalid_argument", "The idempotency key is invalid");
      const state = await this.load();
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0)
        throw new AgentBackendError("protocol", "The v2 idempotency clock is invalid");
      const active = state.idempotency.filter(
        (item) => now - item.createdAt < this.idempotencyTtlMs,
      );
      if (active.length !== state.idempotency.length) {
        await this.commit({ ...state, idempotency: active });
      }
      const existing = active.find((item) => item.key === key);
      if (existing?.kind === "accepted")
        return { kind: "accepted", result: clone(existing.result) };
      if (existing?.kind === "pending") return { kind: "pending" };
      await this.commit({
        ...state,
        idempotency: [...active, { createdAt: now, key, kind: "pending" }],
      });
      return { kind: "claimed" };
    });
  }

  completeIdempotency(key: string, result: AgentJsonValue): Promise<void> {
    return this.serialize(async () => {
      const state = await this.load();
      const index = state.idempotency.findIndex((item) => item.key === key);
      if (index < 0 || state.idempotency[index]?.kind !== "pending") {
        throw new AgentBackendError("conflict", "The v2 idempotency admission was not reserved");
      }
      const next = [...state.idempotency];
      next[index] = {
        createdAt: state.idempotency[index].createdAt,
        key,
        kind: "accepted",
        result: jsonValueSchema.parse(result) as AgentJsonValue,
      };
      await this.commit({ ...state, idempotency: next });
    });
  }

  initializeSession(
    ref: AgentSessionRef,
    entries: readonly RemoteAgentV2StoredEntryIndex[],
  ): Promise<RemoteAgentV2StoredSessionIndex> {
    return this.serialize(async () => {
      const state = await this.load();
      const existing = this.findSession(state, ref);
      if (existing !== undefined) return publicIndex(existing);
      const created: PersistedSession = {
        entries: normalizeEntries(entries),
        ref: normalizeRef(ref),
      };
      await this.commit({ ...state, sessions: [...state.sessions, created] });
      return publicIndex(created);
    });
  }

  readHostRevision(): Promise<string> {
    return this.serialize(async () => (await this.load()).hostRevision);
  }

  readSessionIndex(ref: AgentSessionRef): Promise<RemoteAgentV2StoredSessionIndex | undefined> {
    return this.serialize(async () => {
      const session = this.findSession(await this.load(), ref);
      return session === undefined ? undefined : publicIndex(session);
    });
  }

  replaceSessionIndex(
    ref: AgentSessionRef,
    entries: readonly RemoteAgentV2StoredEntryIndex[],
  ): Promise<RemoteAgentV2StoredSessionIndex> {
    return this.serialize(async () => {
      const state = await this.load();
      const existing = this.findSession(state, ref);
      const next: PersistedSession = { entries: normalizeEntries(entries), ref: normalizeRef(ref) };
      if (existing === undefined) {
        await this.commit({ ...state, sessions: [...state.sessions, next] });
        return publicIndex(next);
      }
      const sessions = [...state.sessions];
      const index = sessions.findIndex(
        (candidate) => agentSessionLocatorKey(candidate.ref) === agentSessionLocatorKey(ref),
      );
      sessions[index] = next;
      await this.commit({ ...state, sessions });
      return publicIndex(next);
    });
  }

  private findSession(state: StoredState, ref: AgentSessionRef): PersistedSession | undefined {
    const session = state.sessions.find(
      (candidate) => agentSessionLocatorKey(candidate.ref) === agentSessionLocatorKey(ref),
    );
    if (session !== undefined && !isSameAgentSessionRef(session.ref, ref)) {
      throw new AgentBackendError("conflict", "The v2 session locator has another identity");
    }
    return session;
  }

  private async load(): Promise<StoredState> {
    if (this.stateValue !== undefined) return this.stateValue;
    try {
      const metadata = await stat(this.options.path);
      if (
        !metadata.isFile() ||
        metadata.size > this.maxFileBytes ||
        hasSharedFileMode(metadata.mode)
      )
        throw stateError();
      const parsed = normalizeState(JSON.parse(await readFile(this.options.path, "utf8")));
      if (
        parsed.hostId !== hostId(this.options.hostId) ||
        parsed.hostKeyId !== hostId(this.options.hostKeyId)
      )
        throw stateError();
      this.stateValue = parsed;
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof AgentBackendError) throw error;
        throw new AgentBackendError("unavailable", "The v2 host state could not be read", {
          retryable: true,
        });
      }
      const created = initialState(hostId(this.options.hostId), hostId(this.options.hostKeyId));
      await this.write(created);
      this.stateValue = created;
      return created;
    }
  }

  private async commit(next: StoredState): Promise<void> {
    await this.write(next);
    this.stateValue = next;
  }

  private async write(state: StoredState): Promise<void> {
    const payload = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(payload, "utf8") > this.maxFileBytes)
      throw new AgentBackendError("unavailable", "The v2 host state exceeds its file limit");
    const directory = dirname(this.options.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${this.options.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(payload, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.options.path);
      await chmod(this.options.path, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof AgentBackendError) throw error;
      throw new AgentBackendError("unavailable", "The v2 host state could not be persisted", {
        retryable: true,
      });
    }
  }

  private serialize<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const task = this.tail.then(operation);
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
