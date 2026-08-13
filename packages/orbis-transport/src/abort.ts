import { OrbisTransportError } from "./errors";

export interface AbortScope {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  dispose(): void;
}

export function createAbortScope(signal: AbortSignal | undefined, timeoutMs?: number): AbortScope {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new OrbisTransportError("invalid_argument", "timeoutMs must be a positive number");
  }

  const controller = new AbortController();
  let timeoutTriggered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const forwardAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(signal?.reason);
    }
  };

  if (signal?.aborted) {
    forwardAbort();
  } else {
    signal?.addEventListener("abort", forwardAbort, { once: true });
  }

  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        timeoutTriggered = true;
        controller.abort();
      }
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose() {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", forwardAbort);
    },
  };
}

export function abortError(scope: Pick<AbortScope, "timedOut">) {
  if (scope.timedOut()) {
    return new OrbisTransportError("timeout", "The transport operation timed out", {
      retryable: true,
    });
  }

  return new OrbisTransportError("aborted", "The transport operation was cancelled");
}

export function throwIfAborted(scope: Pick<AbortScope, "signal" | "timedOut">): void {
  if (scope.signal.aborted) {
    throw abortError(scope);
  }
}

export function raceWithAbort<T>(operation: Promise<T>, scope: AbortScope): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => scope.signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(abortError(scope));
    };

    operation.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(scope.signal.aborted ? abortError(scope) : error);
      },
    );

    if (scope.signal.aborted) {
      onAbort();
    } else {
      scope.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
