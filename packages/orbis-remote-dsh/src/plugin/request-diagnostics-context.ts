import { AsyncLocalStorage } from "node:async_hooks";

export interface OrbisRemoteRequestDiagnosticsContext {
  readonly method: string;
  readonly requestId: string;
}

const remoteRequestDiagnostics = new AsyncLocalStorage<OrbisRemoteRequestDiagnosticsContext>();

/** Keeps server-internal DSH failures correlated with the encrypted Remote request that caused them. */
export function withOrbisRemoteRequestDiagnostics<TResult>(
  context: OrbisRemoteRequestDiagnosticsContext,
  operation: () => TResult,
): TResult {
  return remoteRequestDiagnostics.run(context, operation);
}

export function currentOrbisRemoteRequestDiagnostics():
  | OrbisRemoteRequestDiagnosticsContext
  | undefined {
  return remoteRequestDiagnostics.getStore();
}
