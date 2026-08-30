import type { AgentSessionEvent } from "@orbisapp/orbis-agent-backend";

type AgentDeltaEvent = Extract<AgentSessionEvent, { readonly type: "entry.delta" }>;

/** A DSH delta before the adapter assigns its public chunk sequence. */
export type DshDeltaInput = Omit<AgentDeltaEvent, "durability" | "payload" | "type"> & {
  readonly payload: Omit<AgentDeltaEvent["payload"], "chunkSeq">;
};

export interface DshDeltaScheduler {
  clearTimeout(handle: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
}

/** The fixed batching window for one contiguous DSH delta stream. */
export const DSH_DELTA_COALESCE_WINDOW_MS = 50;

const defaultScheduler: DshDeltaScheduler = {
  clearTimeout(handle): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  setTimeout(callback, delayMs): unknown {
    return setTimeout(callback, delayMs);
  },
};

interface PendingDelta {
  readonly first: DshDeltaInput;
  readonly chunks: string[];
  latest: DshDeltaInput;
}

export interface DshDeltaCoalescerOptions {
  readonly emit: (delta: DshDeltaInput) => void;
  readonly scheduler?: DshDeltaScheduler;
}

/**
 * Coalesces only one contiguous stream of equivalent DSH deltas.
 *
 * The adapter owns chunk-sequence allocation. Keeping that operation in the
 * flush callback means skipped micro-deltas never create public sequence gaps.
 */
export class DshDeltaCoalescer {
  private closed = false;
  private pending: PendingDelta | undefined;
  private timerHandle: unknown;
  private timerToken: object | undefined;

  private readonly emit: (delta: DshDeltaInput) => void;
  private readonly scheduler: DshDeltaScheduler;

  constructor(options: DshDeltaCoalescerOptions) {
    this.emit = options.emit;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  push(delta: DshDeltaInput): void {
    if (this.closed) return;

    const pending = this.pending;
    if (pending === undefined) {
      this.pending = { chunks: [delta.payload.delta], first: delta, latest: delta };
      this.scheduleWindowFlush();
      return;
    }

    if (sameDeltaKey(pending.latest, delta)) {
      pending.chunks.push(delta.payload.delta);
      pending.latest = delta;
      return;
    }

    this.flush();
    this.pending = { chunks: [delta.payload.delta], first: delta, latest: delta };
    this.scheduleWindowFlush();
  }

  flush(): void {
    if (this.closed) return;
    this.clearWindowFlush();
    this.flushPending();
  }

  close(): void {
    if (this.closed) return;
    this.clearWindowFlush();
    this.closed = true;
    this.flushPending();
  }

  private flushPending(): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    this.emit({
      ...pending.first,
      occurredAt: pending.latest.occurredAt,
      eventId: pending.latest.eventId,
      payload: { ...pending.first.payload, delta: pending.chunks.join("") },
      source: pending.latest.source,
    });
  }

  private scheduleWindowFlush(): void {
    const token = {};
    this.timerToken = token;
    const handle = this.scheduler.setTimeout(() => {
      if (this.closed || this.timerToken !== token) return;
      this.timerToken = undefined;
      this.timerHandle = undefined;
      this.flushPending();
    }, DSH_DELTA_COALESCE_WINDOW_MS);
    if (this.timerToken === token) {
      this.timerHandle = handle;
    } else if (handle !== undefined) {
      // A deterministic scheduler may invoke a callback synchronously.
      this.scheduler.clearTimeout(handle);
    }
  }

  private clearWindowFlush(): void {
    const handle = this.timerHandle;
    this.timerHandle = undefined;
    this.timerToken = undefined;
    if (handle !== undefined) this.scheduler.clearTimeout(handle);
  }
}

function sameDeltaKey(left: DshDeltaInput, right: DshDeltaInput): boolean {
  return (
    left.payload.entryId === right.payload.entryId &&
    left.payload.part === right.payload.part &&
    left.payload.blockIndex === right.payload.blockIndex
  );
}
