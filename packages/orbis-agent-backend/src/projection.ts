import { AgentBackendError } from "./errors";
import type {
  AgentJsonValue,
  AgentPermissionRequest,
  AgentQueuedInput,
  AgentDurableSessionEvent,
  AgentPublicError,
  AgentSessionEntry,
  AgentSessionEvent,
  AgentSessionMetadata,
  AgentSessionStateChangedEvent,
  AgentUsage,
} from "./events";
import {
  agentDeliveryCursor,
  nextAgentDeliveryCursor,
  type AgentDeliveryCursor,
  type AgentEventId,
  type AgentRunId,
  type AgentSessionRef,
  type AgentTimestamp,
} from "./identifiers";

export type AgentProjectionState = "error" | "idle" | "running";
export type AgentRunState = "cancelled" | "completed" | "failed" | "running";

export interface AgentRunSummary {
  readonly error?: AgentPublicError;
  readonly finishedAt?: AgentTimestamp;
  readonly id: AgentRunId;
  readonly startedAt: AgentTimestamp;
  readonly state: AgentRunState;
}

export interface AgentAppliedDurableEvent {
  readonly cursor: AgentDeliveryCursor;
  readonly eventId: AgentEventId;
}

/**
 * Durable, harness-neutral read model. The remote cache will persist this
 * projection alongside its event journal and committed delivery cursor.
 */
export interface AgentSessionProjection {
  readonly activeRun?: AgentRunSummary;
  readonly configOptions?: Readonly<Record<string, AgentJsonValue>>;
  readonly cursor: AgentDeliveryCursor;
  readonly cwd?: string | null;
  readonly entries: readonly AgentSessionEntry[];
  /** Current native branch leaf when the backend exposes a durable tree. */
  readonly leafEntryId?: AgentSessionEntry["id"] | null;
  /**
   * Keeps immediate replay idempotent without making the projection grow with
   * the transcript. A persistent remote cache owns its full event journal.
   */
  readonly lastAppliedDurableEvent?: AgentAppliedDurableEvent;
  readonly lastRun?: AgentRunSummary;
  readonly mode?: string | null;
  readonly metadata: AgentSessionMetadata;
  readonly pendingInputs?: readonly AgentQueuedInput[];
  readonly pendingPermissions?: readonly AgentPermissionRequest[];
  readonly ref: AgentSessionRef;
  readonly revision: number;
  readonly state: AgentProjectionState;
  readonly usageTotal?: AgentUsage;
  readonly workspaceRef?: string | null;
}

export type AgentProjectionApplyResult =
  | {
      readonly kind: "applied";
      readonly projection: AgentSessionProjection;
    }
  | {
      readonly kind: "ignored";
      readonly projection: AgentSessionProjection;
      readonly reason: "duplicate" | "transient";
    }
  | {
      readonly expectedCursor: AgentDeliveryCursor;
      readonly kind: "gap";
      readonly projection: AgentSessionProjection;
      readonly receivedCursor: AgentDeliveryCursor;
    }
  | {
      readonly error: AgentBackendError;
      readonly kind: "conflict";
      readonly projection: AgentSessionProjection;
    };

export function createAgentSessionProjection(
  ref: AgentSessionRef,
  metadata: AgentSessionMetadata,
): AgentSessionProjection {
  return {
    cursor: agentDeliveryCursor(0),
    entries: [],
    metadata,
    ref,
    revision: 0,
    state: "idle",
  };
}

function conflict(
  projection: AgentSessionProjection,
  code: "conflict" | "cursor_conflict" | "protocol",
  message: string,
  details?: Readonly<Record<string, number | string>>,
): AgentProjectionApplyResult {
  return {
    error: new AgentBackendError(code, message, details === undefined ? {} : { details }),
    kind: "conflict",
    projection,
  };
}

function sourceMatches(projection: AgentSessionProjection, event: AgentSessionEvent): boolean {
  return (
    projection.ref.sessionId === event.sessionId &&
    projection.ref.backendId === event.source.backendId &&
    projection.ref.driverId === event.source.driverId
  );
}

function sameDurableEvent(
  projection: AgentSessionProjection,
  event: AgentDurableSessionEvent,
): "conflict" | "duplicate" | undefined {
  const applied = projection.lastAppliedDurableEvent;
  if (!applied || applied.eventId !== event.eventId) return undefined;
  return applied.cursor === event.cursor ? "duplicate" : "conflict";
}

function nextProjection(
  projection: AgentSessionProjection,
  event: AgentDurableSessionEvent,
  changes: Omit<Partial<AgentSessionProjection>, "cursor" | "lastAppliedDurableEvent" | "revision">,
): AgentSessionProjection {
  const metadata = changes.metadata ?? projection.metadata;
  return {
    ...projection,
    ...changes,
    cursor: event.cursor,
    lastAppliedDurableEvent: { cursor: event.cursor, eventId: event.eventId },
    metadata: { ...metadata, updatedAt: event.occurredAt },
    // Transcript growth is replayable data, not mutable session state.
    revision: projection.revision,
  };
}

function projectionStateForRunState(
  runState: AgentSessionStateChangedEvent["payload"]["patch"]["runState"],
): AgentProjectionState | undefined {
  if (runState === undefined) return undefined;
  return runState === "error" ? "error" : runState === "running" ? "running" : "idle";
}

function applyStateChanged(
  projection: AgentSessionProjection,
  event: AgentSessionStateChangedEvent,
): AgentProjectionApplyResult {
  const revision = event.payload.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    return conflict(projection, "protocol", "A state event revision is invalid");
  }
  if (revision <= projection.revision) {
    return { kind: "ignored", projection, reason: "duplicate" };
  }
  if (revision > projection.revision + 1) {
    return conflict(projection, "protocol", "A state event revision was skipped", {
      expectedRevision: projection.revision + 1,
      receivedRevision: revision,
    });
  }
  const patch = event.payload.patch;
  const activeRun =
    patch.activeRun === undefined
      ? projection.activeRun
      : patch.activeRun === null
        ? undefined
        : {
            id: patch.activeRun.id,
            startedAt: patch.activeRun.startedAt,
            state: "running" as const,
          };
  const lastRun =
    patch.lastRun === undefined
      ? projection.lastRun
      : patch.lastRun === null
        ? undefined
        : {
            ...(patch.lastRun.error === undefined ? {} : { error: patch.lastRun.error }),
            ...(patch.lastRun.finishedAt === undefined
              ? {}
              : { finishedAt: patch.lastRun.finishedAt }),
            id: patch.lastRun.id,
            startedAt: patch.lastRun.startedAt,
            state: patch.lastRun.outcome ?? "completed",
          };
  const runState = projectionStateForRunState(patch.runState);
  return {
    kind: "applied",
    projection: {
      ...projection,
      ...(patch.activeRun === undefined ? {} : { activeRun }),
      ...(patch.configOptions === undefined ? {} : { configOptions: patch.configOptions }),
      ...(patch.cwd === undefined ? {} : { cwd: patch.cwd }),
      ...(patch.lastRun === undefined ? {} : { lastRun }),
      ...(patch.leafEntryId === undefined ? {} : { leafEntryId: patch.leafEntryId }),
      ...(patch.mode === undefined ? {} : { mode: patch.mode }),
      metadata: {
        ...projection.metadata,
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.title === undefined ? {} : { title: patch.title }),
        updatedAt: patch.updatedAt ?? event.occurredAt,
      },
      ...(patch.pendingInputs === undefined ? {} : { pendingInputs: patch.pendingInputs }),
      ...(patch.pendingPermissions === undefined
        ? {}
        : { pendingPermissions: patch.pendingPermissions }),
      revision,
      ...(runState === undefined ? {} : { state: runState }),
      ...(patch.usageTotal === undefined
        ? {}
        : { usageTotal: patch.usageTotal === null ? undefined : patch.usageTotal }),
      ...(patch.workspaceRef === undefined ? {} : { workspaceRef: patch.workspaceRef }),
    },
  };
}

function applyDurableEvent(
  projection: AgentSessionProjection,
  event: AgentDurableSessionEvent,
): AgentProjectionApplyResult {
  switch (event.type) {
    case "entry.appended": {
      const existing = projection.entries.find((entry) => entry.id === event.payload.entry.id);
      if (existing) {
        return conflict(projection, "conflict", "A durable entry id was reused", {
          entryId: event.payload.entry.id,
        });
      }
      // Appending to the selected branch advances its leaf without changing
      // session-state revision. Entries from another branch stay in inventory
      // but must not change the branch currently rendered by the client.
      const leafEntryId =
        projection.leafEntryId !== undefined &&
        event.payload.entry.parentId === projection.leafEntryId
          ? event.payload.entry.id
          : undefined;
      return {
        kind: "applied",
        projection: nextProjection(projection, event, {
          entries: [...projection.entries, event.payload.entry],
          ...(leafEntryId === undefined ? {} : { leafEntryId }),
        }),
      };
    }
  }
}

/**
 * Applies exactly one event. Durable events must be contiguous in delivery
 * cursor order; transient events intentionally leave the durable projection
 * and cursor untouched.
 */
export function applyAgentSessionEvent(
  projection: AgentSessionProjection,
  event: AgentSessionEvent,
): AgentProjectionApplyResult {
  if (!sourceMatches(projection, event)) {
    return conflict(
      projection,
      "protocol",
      "The event does not belong to this session projection",
      {
        eventSessionId: event.sessionId,
        projectionSessionId: projection.ref.sessionId,
      },
    );
  }

  if (event.type === "session.state.changed") return applyStateChanged(projection, event);

  if (event.durability === "transient") {
    return { kind: "ignored", projection, reason: "transient" };
  }

  const prior = sameDurableEvent(projection, event);
  if (prior === "duplicate") {
    return { kind: "ignored", projection, reason: "duplicate" };
  }
  if (prior === "conflict") {
    return conflict(
      projection,
      "cursor_conflict",
      "A durable event id was reused with another cursor",
      {
        cursor: event.cursor,
        eventId: event.eventId,
      },
    );
  }

  const expectedCursor = nextAgentDeliveryCursor(projection.cursor);
  if (event.cursor > expectedCursor) {
    return {
      expectedCursor,
      kind: "gap",
      projection,
      receivedCursor: event.cursor,
    };
  }
  if (event.cursor < expectedCursor) {
    return conflict(
      projection,
      "cursor_conflict",
      "A stale durable cursor was not a known duplicate",
      {
        expectedCursor,
        receivedCursor: event.cursor,
      },
    );
  }

  return applyDurableEvent(projection, event);
}
