import { OrbisTransportError } from "./errors";
import type { RemoteHostRequestContext, RemoteHostRequestHandler } from "./host-websocket";
import type { JsonValue, TransportEvent } from "./protocol";

export interface RemoteHarnessDefinition {
  harnessId: string;
  methods: readonly string[];
  /** Required peer scopes keyed by every owned method. */
  methodScopes: Readonly<Record<string, readonly string[]>>;
  /** Required peer scopes for every event emitted by this harness. */
  eventScopes: readonly string[];
  handleRequest: RemoteHostRequestHandler;
}

export interface RemoteHarnessSession {
  readonly harnessId: string;
  emit(event: TransportEvent): Promise<void>;
  close(): Promise<void>;
}

export interface RemoteHarnessConnector {
  open(definition: RemoteHarnessDefinition): Promise<RemoteHarnessSession>;
}

export interface RemoteHarnessEventBroadcaster {
  broadcastEvent(event: TransportEvent, requiredScopes: readonly string[]): Promise<void>;
}

interface RegisteredHarness {
  definition: RemoteHarnessDefinition;
  methods: Set<string>;
}

function validateName(value: string, label: string): string {
  if (value.length === 0 || value.length > 256) {
    throw new OrbisTransportError("invalid_argument", `${label} is invalid`);
  }
  return value;
}

/**
 * Harness-neutral method router used by a host runtime before it opens its relay socket. Pi and DSH
 * register independent leases; the router is passed directly as the host connection request handler.
 */
export class OrbisRemoteHarnessRouter implements RemoteHarnessConnector {
  private readonly harnesses = new Map<string, RegisteredHarness>();
  private readonly methodOwners = new Map<string, string>();
  private broadcaster?: RemoteHarnessEventBroadcaster;

  readonly handleRequest: RemoteHostRequestHandler = async (
    method: string,
    params: JsonValue,
    context: RemoteHostRequestContext,
  ) => {
    const harnessId = this.methodOwners.get(method);
    const harness = harnessId ? this.harnesses.get(harnessId) : undefined;
    if (!harness) {
      throw new OrbisTransportError("remote_request", "Remote harness method is unavailable", {
        serverCode: "method_not_found",
      });
    }
    const requiredScopes = harness.definition.methodScopes[method];
    if (!requiredScopes || requiredScopes.some((scope) => !context.peer.scopes.includes(scope))) {
      throw new OrbisTransportError("authentication", "The paired client is not authorized", {
        serverCode: "forbidden",
      });
    }
    return harness.definition.handleRequest(method, params, context);
  };

  attachBroadcaster(broadcaster: RemoteHarnessEventBroadcaster): () => void {
    if (this.broadcaster && this.broadcaster !== broadcaster) {
      throw new OrbisTransportError(
        "invalid_argument",
        "The harness router already has an event broadcaster",
      );
    }
    this.broadcaster = broadcaster;
    return () => {
      if (this.broadcaster === broadcaster) {
        this.broadcaster = undefined;
      }
    };
  }

  async open(definition: RemoteHarnessDefinition): Promise<RemoteHarnessSession> {
    const harnessId = validateName(definition.harnessId, "Harness id");
    if (this.harnesses.has(harnessId)) {
      throw new OrbisTransportError("invalid_argument", "The harness is already registered");
    }
    const methods = new Set(definition.methods.map((method) => validateName(method, "Method")));
    if (methods.size === 0 || methods.size !== definition.methods.length) {
      throw new OrbisTransportError(
        "invalid_argument",
        "Harness methods must be non-empty and unique",
      );
    }
    for (const method of methods) {
      const scopes = definition.methodScopes[method];
      if (
        !scopes ||
        scopes.length === 0 ||
        new Set(scopes).size !== scopes.length ||
        scopes.some((scope) => scope.length === 0 || scope.length > 128)
      ) {
        throw new OrbisTransportError(
          "invalid_argument",
          "Every harness method must declare unique required scopes",
        );
      }
    }
    const declaredMethods = Object.keys(definition.methodScopes);
    if (
      declaredMethods.length !== methods.size ||
      declaredMethods.some((method) => !methods.has(method))
    ) {
      throw new OrbisTransportError(
        "invalid_argument",
        "Harness method scopes must exactly match the owned methods",
      );
    }
    if (
      definition.eventScopes.length === 0 ||
      new Set(definition.eventScopes).size !== definition.eventScopes.length ||
      definition.eventScopes.some((scope) => scope.length === 0 || scope.length > 128)
    ) {
      throw new OrbisTransportError(
        "invalid_argument",
        "Harness event scopes must be non-empty and unique",
      );
    }
    for (const method of methods) {
      if (this.methodOwners.has(method)) {
        throw new OrbisTransportError(
          "invalid_argument",
          `Remote method '${method}' is already registered`,
        );
      }
    }

    const registered = { definition, methods };
    this.harnesses.set(harnessId, registered);
    for (const method of methods) {
      this.methodOwners.set(method, harnessId);
    }
    let closed = false;

    return {
      harnessId,
      emit: async (event) => {
        if (closed) {
          throw new OrbisTransportError("closed", "The remote harness session is closed");
        }
        if (event.source.harness !== harnessId) {
          throw new OrbisTransportError(
            "invalid_argument",
            "Transport event source does not match the registered harness",
          );
        }
        if (!this.broadcaster) {
          throw new OrbisTransportError("closed", "The remote event broadcaster is unavailable");
        }
        await this.broadcaster.broadcastEvent(event, definition.eventScopes);
      },
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        if (this.harnesses.get(harnessId) === registered) {
          this.harnesses.delete(harnessId);
          for (const method of methods) {
            if (this.methodOwners.get(method) === harnessId) {
              this.methodOwners.delete(method);
            }
          }
        }
      },
    };
  }
}
