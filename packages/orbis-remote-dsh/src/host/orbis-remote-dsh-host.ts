import {
  AgentBackendError,
  type AgentBackendError as AgentBackendErrorValue,
} from "@orbis/orbis-agent-backend";
import {
  NodeFileRemoteAgentV2HostStore,
  type NodeFileRemoteAgentV2HostStoreOptions,
} from "@orbis/remote-agent-node-store";
import {
  OrbisRemoteAgentV2Host,
  OrbisRemoteAgentV2HostTransport,
  createRemoteAgentV2HostRequestHandler,
} from "@orbis/remote-agent-protocol";
import type { OrbisRemoteHostConnection, RemoteHostRequestHandler } from "@orbis/transport";

import { DshLocalBackend, type DshLocalBackendOptions } from "../adapter";
import { DshRemoteV2Backend, type DshRemoteWorkspaceProvider } from "./dsh-v2-backend";

/** The authenticated connection surface consumed by the remote DSH host owner. */
export type OrbisRemoteDshHostConnection = Pick<
  OrbisRemoteHostConnection,
  "onClose" | "peers" | "sendEvent"
>;

export interface OrbisRemoteDshHostStateOptions extends Omit<
  NodeFileRemoteAgentV2HostStoreOptions,
  "hostId" | "hostKeyId"
> {}

/** DSH's real Cordis services and opaque value constructors are injected at the bundle boundary. */
export interface OrbisRemoteDshHostDshOptions extends Omit<DshLocalBackendOptions, "backend"> {}

export interface OrbisRemoteDshHostOptions {
  /** Stable product host id. Clients see this exact placement as `remote:<hostId>`. */
  readonly hostId: string;
  /** Static host public-key fingerprint; node delivery state rejects silent identity rotation. */
  readonly hostKeyId: string;
  readonly dsh: OrbisRemoteDshHostDshOptions;
  readonly onError?: (error: AgentBackendErrorValue) => void;
  /** Node-owned v2 cursor/index replica; DSH's native transcript is not copied into this file. */
  readonly state: OrbisRemoteDshHostStateOptions;
  readonly workspaceProvider?: DshRemoteWorkspaceProvider;
}

function once(operation: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    operation();
  };
}

/**
 * Concrete Node host composition for DSH's `sessionPersistence` catalog and
 * Cordis agent registry. The host retains only cursor indexes and idempotency
 * admissions for encrypted client replay; it never substitutes that derived
 * state for DSH's transcript authority.
 */
export class OrbisRemoteDshHost {
  readonly agentHost: OrbisRemoteAgentV2Host;
  readonly nativeBackend: DshLocalBackend;
  readonly requestHandler: RemoteHostRequestHandler;

  private closed = false;
  private readonly detachments = new Set<() => void>();
  private readonly transport = new OrbisRemoteAgentV2HostTransport();

  constructor(options: OrbisRemoteDshHostOptions) {
    const store = new NodeFileRemoteAgentV2HostStore({
      ...options.state,
      hostId: options.hostId,
      hostKeyId: options.hostKeyId,
    });
    this.nativeBackend = new DshLocalBackend({
      ...options.dsh,
      backend: { displayName: "DSH host runtime", id: "dsh-host" },
    });
    this.agentHost = new OrbisRemoteAgentV2Host({
      backend: new DshRemoteV2Backend(this.nativeBackend, options.workspaceProvider),
      backendId: `remote:${options.hostId}`,
      onError: options.onError,
      store,
      transport: this.transport,
    });
    this.requestHandler = createRemoteAgentV2HostRequestHandler(this.agentHost);
  }

  /**
   * Attaches one already authenticated connection. Detaching it only removes
   * transport delivery; it never stops DSH.
   */
  attach(connection: OrbisRemoteDshHostConnection): () => void {
    this.assertOpen();
    const detachTransport = this.transport.attach(connection);
    let detachClose: (() => void) | undefined;
    const detach = once(() => {
      detachClose?.();
      detachTransport();
      this.detachments.delete(detach);
    });
    detachClose = connection.onClose(detach);
    this.detachments.add(detach);
    return detach;
  }

  /** Explicit process shutdown is the only path that closes owned DSH controllers. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const detach of [...this.detachments]) detach();
    try {
      await this.agentHost.close();
    } finally {
      await this.nativeBackend.close();
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new AgentBackendError("closed", "The remote DSH host is closed");
  }
}
