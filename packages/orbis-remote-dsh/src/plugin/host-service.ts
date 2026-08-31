import { randomBytes, randomUUID } from "node:crypto";
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from "node:os";

import { ORBIS_REMOTE_AGENT_V2_METHOD_LIST } from "@orbisapp/remote-agent-protocol";
import {
  createPairingSecret,
  generateDeviceIdentity,
  hostEndpointSchema,
  ORBIS_E2EE_PROTOCOL_VERSION,
  ORBIS_E2EE_SUITE,
  ORBIS_REMOTE_SCOPE_VALUES,
  ORBIS_REMOTE_SCOPES,
  resolveRemoteScopes,
  serializePairingInvitation,
  serializedDeviceIdentitySchema,
  type HostEndpoint,
  type HostEndpointManifest,
  type JsonValue,
  type OrbisRemoteHostConnection,
  type RemoteHost,
  type RemoteHostPeer,
  type RemoteHostPeerError,
  type RemoteHostRequestHandler,
  type RemoteHostResolvedPeer,
  type RemoteScopeMode,
  type SecureHelloEnvelope,
  type SecureRandom,
  type SerializedDeviceIdentity,
} from "@orbisapp/transport";

import { ORBIS_DSH_DRIVER_VERSION, ORBIS_DSH_HARNESS_ID } from "./constants";
import { OrbisDirectHostListener } from "./direct-listener";
import {
  ORBIS_DSH_NOOP_LOGGER,
  orbisDshErrorFields,
  type OrbisDshLogFields,
  type OrbisDshLogger,
} from "./file-logger";
import { withOrbisRemoteRequestDiagnostics } from "./request-diagnostics-context";
import { type OrbisDshHostState, type OrbisDshPeer, OrbisDshStateStore } from "./state-store";

export const ORBIS_DSH_IDENTITY_CREDENTIAL = "ORBIS_DSH_HOST_IDENTITY_V1";
export const ORBIS_DSH_DIRECT_PORT = 47000;

const PAIRING_LIFETIME_MS = 10 * 60_000;
const ENDPOINT_MONITOR_INTERVAL_MS = 2_000;
const MAX_HOST_ENDPOINTS = 16;
const SUPPORTED_PAIRING_SCOPES = new Set<string>(ORBIS_REMOTE_SCOPE_VALUES);

export interface OrbisDshCredentials {
  resolve(reference: string): Promise<{ readonly value: string } | undefined>;
  set(reference: string, value: string): Promise<void>;
}

export interface OrbisDshConfigurationInput {
  readonly directPort: number;
  readonly hostName: string;
}

export interface OrbisDshDiscoveredAddress {
  readonly kind: "lan" | "tailnet";
  readonly address: string;
}

type PendingPairingPhase = "awaiting-device" | "connecting" | "failed";
type HostConnectionState = "connected" | "connecting" | "disconnected";

interface PendingPairing {
  readonly kind: HostEndpoint["kind"];
  readonly pairingId: string;
  readonly expiresAt: string;
  readonly secret: string;
  readonly invitation: string;
  readonly scopeMode: RemoteScopeMode;
  readonly scopes: readonly string[];
  readonly controller: AbortController;
  phase: PendingPairingPhase;
  error?: string;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

export type OrbisDshPairingScopePolicy =
  | { readonly mode: "all" }
  | { readonly mode: "custom"; readonly scopes: readonly string[] };

function normalizePairingScopePolicy(policy: OrbisDshPairingScopePolicy): {
  readonly mode: RemoteScopeMode;
  readonly scopes: readonly string[];
} {
  if (policy.mode === "all") {
    return { mode: "all", scopes: ORBIS_REMOTE_SCOPE_VALUES };
  }
  const scopes = policy.scopes.map((scope) => scope.trim());
  if (
    scopes.length === 0 ||
    scopes.length > SUPPORTED_PAIRING_SCOPES.size ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !SUPPORTED_PAIRING_SCOPES.has(scope)) ||
    !scopes.includes(ORBIS_REMOTE_SCOPES.connect)
  ) {
    throw new Error(
      "Custom Orbis permissions must be unique supported scopes including host:connect",
    );
  }
  return { mode: "custom", scopes };
}

interface ConfiguredHostState {
  readonly state: OrbisDshHostState;
  readonly hostName: string;
  readonly directPort: number;
  readonly endpoints: readonly HostEndpoint[];
  readonly endpointRevision: number;
}

/** The v2 agent host remains independent of pairing and listener ownership. */
export type OrbisDshAgentHostConnection = Pick<
  OrbisRemoteHostConnection,
  "onClose" | "peers" | "sendEvent"
>;

export interface OrbisDshAgentHost {
  readonly requestHandler: RemoteHostRequestHandler;
  attach(connection: OrbisDshAgentHostConnection): () => void;
  close(): Promise<void>;
}

export interface OrbisDshAgentHostFactory {
  create(input: {
    readonly hostId: string;
    readonly hostKeyId: string;
  }): OrbisDshAgentHost | Promise<OrbisDshAgentHost>;
}

export interface OrbisDshStatus {
  readonly configuration: {
    readonly hostId: string;
    readonly directPort: number;
    readonly hostName?: string;
    readonly suggestedHostName: string;
    readonly autoDirectEndpoints: readonly HostEndpoint[];
    readonly endpoints: readonly HostEndpoint[];
    readonly endpointRevision: number;
    readonly ready: boolean;
  };
  readonly connection: {
    readonly state: HostConnectionState;
    readonly error?: string;
  };
  readonly pairing?: {
    readonly pairingId: string;
    readonly transport: HostEndpoint["kind"];
    readonly expiresAt: string;
    readonly phase: PendingPairingPhase;
    readonly invitation: string;
    readonly error?: string;
  };
  readonly devices: readonly (OrbisDshPeer & {
    readonly connected: boolean;
    readonly error?: string;
  })[];
}

function nodeSecureRandom(length: number): Promise<Uint8Array> {
  return Promise.resolve(new Uint8Array(randomBytes(length)));
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.slice(0, 512);
  }
  return fallback;
}

function validHostName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 256) {
    throw new Error("Host name must contain between 1 and 256 characters");
  }
  return name;
}

function directPortValue(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65_535) {
    throw new Error("Direct port must be an integer from 1024 through 65535");
  }
  return value;
}

function ipv4Parts(address: string): readonly [number, number, number, number] | undefined {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined;
  }
  return parts as [number, number, number, number];
}

function isLanAddress(address: string): boolean {
  const parts = ipv4Parts(address);
  if (parts === undefined) return false;
  const [first, second] = parts;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isTailnetAddress(address: string): boolean {
  const parts = ipv4Parts(address);
  return parts !== undefined && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/**
 * Discovers only private IPv4 routes that are safe to advertise as plain
 * WebSockets. Public addresses are intentionally not advertised.
 */
export function discoverOrbisDirectAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[] | undefined> = networkInterfaces(),
): readonly OrbisDshDiscoveredAddress[] {
  const discovered = new Map<string, OrbisDshDiscoveredAddress>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (String(entry.family) !== "IPv4" || entry.internal) continue;
      const kind = isTailnetAddress(entry.address)
        ? "tailnet"
        : isLanAddress(entry.address)
          ? "lan"
          : undefined;
      if (kind === undefined) continue;
      discovered.set(`${kind}:${entry.address}`, { kind, address: entry.address });
    }
  }
  return [...discovered.values()].sort((left, right) => {
    const kindOrder = left.kind === right.kind ? 0 : left.kind === "lan" ? -1 : 1;
    return kindOrder || left.address.localeCompare(right.address);
  });
}

function directWebSocketUrl(address: string, port: number): string {
  return `ws://${address}:${port}/orbis`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestLogFields(
  method: string,
  params: JsonValue,
  context: Parameters<RemoteHostRequestHandler>[2],
): OrbisDshLogFields {
  const serialized = JSON.stringify(params);
  const fields: Record<string, boolean | number | string | null> = {
    method,
    paramsBytes: Buffer.byteLength(serialized, "utf8"),
    paramsKeys: isRecord(params) ? Object.keys(params).sort().join(",") : "",
    peerDeviceId: context.peer.descriptor.deviceId,
    peerKeyId: context.peer.keyId,
    peerMode: context.peer.mode,
    requestId: context.requestId,
  };
  if (!isRecord(params)) return fields;
  const ref = params.ref;
  if (isRecord(ref)) {
    if (typeof ref.backendId === "string") fields.backendId = ref.backendId;
    if (typeof ref.driverId === "string") fields.driverId = ref.driverId;
    if (typeof ref.sessionId === "string") fields.sessionId = ref.sessionId;
  }
  const idempotencyKey = params.idempotencyKey;
  if (typeof idempotencyKey === "string") {
    fields.idempotencyKeyBytes = Buffer.byteLength(idempotencyKey, "utf8");
  }
  return fields;
}

/** Owns one host identity and its local-network listener. */
export class OrbisDshHostService {
  private mutationTail: Promise<void> = Promise.resolve();
  private agentHost?: OrbisDshAgentHost;
  private agentHostKeyId?: string;
  private connection?: OrbisDirectHostListener;
  private connectionDisposers: Array<() => void> = [];
  private connectionState: HostConnectionState = "disconnected";
  private connectionError?: string;
  private readonly deviceErrors = new Map<string, string>();
  private pending?: PendingPairing;
  private readonly discoverDirectAddresses: () => readonly OrbisDshDiscoveredAddress[];
  private endpointRevisionValue = 0;
  private endpointSignature?: string;
  private endpointMonitorTimer?: ReturnType<typeof setInterval>;
  private endpointMonitorConnection?: OrbisDirectHostListener;
  private endpointMonitorState?: OrbisDshHostState;
  private endpointMonitorIdentity?: SerializedDeviceIdentity;
  private endpointMonitorSignature?: string;

  constructor(
    readonly stateStore: OrbisDshStateStore,
    readonly credentials: OrbisDshCredentials,
    readonly agentHostFactory: OrbisDshAgentHostFactory,
    private readonly random: SecureRandom = nodeSecureRandom,
    private readonly createId: () => string = randomUUID,
    private readonly logger: OrbisDshLogger = ORBIS_DSH_NOOP_LOGGER,
    discoverDirectAddresses: () => readonly OrbisDshDiscoveredAddress[] = discoverOrbisDirectAddresses,
  ) {
    this.discoverDirectAddresses = discoverDirectAddresses;
  }

  async start(): Promise<void> {
    await this.logger.start();
    try {
      await this.stateStore.load();
      this.logger.info("server.started");
    } catch (error) {
      this.logger.error("server.start_failed", orbisDshErrorFields(error));
      throw error;
    }
  }

  async status(): Promise<OrbisDshStatus> {
    const state = await this.stateStore.load();
    const directPort = directPortValue(state.directPort ?? ORBIS_DSH_DIRECT_PORT);
    const autoDirectEndpoints = this.discoveredDirectEndpoints(directPort, MAX_HOST_ENDPOINTS);
    const configured = this.configurationFromState(state, false);
    const connectedKeys = new Set((this.connection?.peers ?? []).map((peer) => peer.keyId));
    return {
      configuration: {
        hostId: state.hostId,
        directPort,
        ...(state.hostName === undefined ? {} : { hostName: state.hostName }),
        suggestedHostName: hostname(),
        autoDirectEndpoints,
        endpoints: configured?.endpoints ?? [],
        endpointRevision: configured?.endpointRevision ?? state.endpointRevision,
        ready: configured !== undefined,
      },
      connection: {
        state: this.connectionState,
        ...(this.connectionError === undefined ? {} : { error: this.connectionError }),
      },
      ...(this.pending === undefined ? {} : { pairing: this.pairingStatus(this.pending) }),
      devices: state.peers
        .map((peer) => {
          const error = this.deviceErrors.get(peer.keyId);
          return {
            ...peer,
            connected: connectedKeys.has(peer.keyId),
            ...(error === undefined ? {} : { error }),
          };
        })
        .sort((left, right) => right.pairedAt.localeCompare(left.pairedAt)),
    };
  }

  configure(input: OrbisDshConfigurationInput): Promise<OrbisDshHostState> {
    return this.exclusive(async () => {
      const current = await this.stateStore.load();
      const hostName = validHostName(input.hostName);
      const port = directPortValue(input.directPort);
      if (this.discoveredDirectEndpoints(port, MAX_HOST_ENDPOINTS).length === 0) {
        throw new Error("Connect this computer to a local network or Tailscale, then try again");
      }
      const changed = current.hostName !== hostName || current.directPort !== port;
      if (changed && this.pending !== undefined) {
        throw new Error("Cancel the active pairing before changing the Orbis host configuration");
      }
      if (changed) await this.disconnectLocked();
      const next = await this.stateStore.update((state) => ({
        version: 2,
        hostId: state.hostId,
        hostName,
        directPort: port,
        endpointRevision: changed ? state.endpointRevision + 1 : state.endpointRevision,
        peers: state.peers,
      }));
      this.logger.info("config.update.succeeded", {
        changed,
        endpointCount: this.configurationFromState(next, true)?.endpoints.length ?? 0,
        hostId: next.hostId,
      });
      return next;
    });
  }

  connect(): Promise<void> {
    return this.exclusive(async () => await this.connectLocked());
  }

  async connectIfConfigured(): Promise<void> {
    if (this.configurationFromState(await this.stateStore.load(), false) === undefined) {
      this.logger.debug("transport.connect.skipped", { reason: "unconfigured" });
      return;
    }
    try {
      await this.connect();
    } catch (error) {
      this.connectionError ??= errorMessage(error, "Orbis could not start on this network");
      this.logger.error("transport.connect.startup_failed", orbisDshErrorFields(error));
    }
  }

  disconnect(): Promise<void> {
    return this.exclusive(async () => await this.disconnectLocked());
  }

  startPairing(
    scopePolicy: OrbisDshPairingScopePolicy = { mode: "all" },
  ): Promise<NonNullable<OrbisDshStatus["pairing"]>> {
    return this.exclusive(async () => {
      if (this.pending !== undefined) {
        throw new Error("A pairing is already active; cancel it before starting another");
      }
      const configured = await this.configuredState();
      const identity = await this.identity();
      await this.connectLocked();
      const pairingId = this.createId();
      const secret = await createPairingSecret(this.random);
      const permissions = normalizePairingScopePolicy(scopePolicy);
      const expiresAt = new Date(Date.now() + PAIRING_LIFETIME_MS).toISOString();
      const endpoint = configured.endpoints[0];
      if (endpoint === undefined) throw new Error("Orbis is not available on this network");
      const invitation = serializePairingInvitation({
        version: ORBIS_E2EE_PROTOCOL_VERSION,
        endpoint,
        pairingId,
        pairingSecret: secret,
        hostId: configured.state.hostId,
        hostName: configured.hostName,
        hostPublicKey: identity.publicKey,
        hostKeyId: identity.keyId,
        scopeMode: permissions.mode,
        requestedScopes: permissions.scopes,
        expiresAt,
        suite: ORBIS_E2EE_SUITE,
      });
      const pending: PendingPairing = {
        kind: endpoint.kind,
        pairingId,
        expiresAt,
        secret,
        invitation,
        scopeMode: permissions.mode,
        scopes: permissions.scopes,
        controller: new AbortController(),
        phase: "awaiting-device",
      };
      this.setPending(pending);
      this.logger.info("pairing.started", { pairingId, transport: endpoint.kind });
      return this.pairingStatus(pending);
    });
  }

  cancelPairing(): Promise<void> {
    return this.exclusive(async () => {
      if (this.pending !== undefined) this.clearPending(this.pending);
    });
  }

  revokeDevice(keyId: string): Promise<void> {
    return this.exclusive(async () => {
      if (keyId.length === 0 || keyId.length > 512) throw new Error("Device key is invalid");
      await this.stateStore.update((current) => {
        const peers = current.peers.filter((peer) => peer.keyId !== keyId);
        if (peers.length === current.peers.length) {
          throw new Error("The paired device no longer exists");
        }
        return { ...current, peers };
      });
      this.deviceErrors.delete(keyId);
      for (const peer of this.connection?.peers ?? []) {
        if (peer.keyId === keyId) this.connection?.disconnectPeer(peer.handshakeId);
      }
      this.logger.info("peer.revoked", { keyId });
    });
  }

  async dispose(): Promise<void> {
    this.logger.info("server.stopping");
    try {
      await this.exclusive(async () => {
        if (this.pending !== undefined) this.clearPending(this.pending);
        const agentHost = this.agentHost;
        this.agentHost = undefined;
        this.agentHostKeyId = undefined;
        try {
          await this.disconnectLocked();
        } finally {
          await agentHost?.close();
        }
      });
    } finally {
      await this.logger.close();
    }
  }

  private async connectLocked(): Promise<void> {
    if (this.connection !== undefined) return;
    const configured = await this.configuredState();
    this.connectionState = "connecting";
    this.connectionError = undefined;
    let listener: OrbisDirectHostListener | undefined;
    try {
      const identity = await this.identity();
      const agentHost = await this.agentHostFor(configured.state.hostId, identity.keyId);
      const requestHandler = this.loggedRequestHandler(agentHost.requestHandler);
      const host = this.hostDescriptor(configured, identity);
      const endpointManifest = () => this.endpointManifestForState(configured.state, identity);
      listener = await OrbisDirectHostListener.listen({
        listenHost: "0.0.0.0",
        port: configured.directPort,
        host,
        identity,
        random: this.random,
        capabilities: { methods: [...ORBIS_REMOTE_AGENT_V2_METHOD_LIST] },
        endpointManifest,
        resolvePeer: (frame) => this.resolvePeer(frame),
        commitPairing: (peer) => this.commitPairing(peer),
        requestHandler,
        onConnection: (accepted) => {
          agentHost.attach(accepted);
        },
        createId: this.createId,
      });
      this.connection = listener;
      this.startEndpointMonitor(listener, configured.state, identity);
      this.connectionDisposers = [
        listener.onClose(() =>
          this.releaseConnection(listener!, false, "Orbis stopped unexpectedly"),
        ),
        listener.onPeer((peer) => {
          this.deviceErrors.delete(peer.keyId);
          void this.noteConnected(peer);
          this.logger.info("peer.connected", {
            deviceId: peer.descriptor.deviceId,
            keyId: peer.keyId,
            mode: peer.mode,
          });
        }),
        listener.onPeerError((event) => {
          this.routePeerError(event);
          this.logger.error("peer.error", {
            ...(event.handshakeId === undefined ? {} : { handshakeId: event.handshakeId }),
            ...(event.keyId === undefined ? {} : { keyId: event.keyId }),
            ...(event.mode === undefined ? {} : { mode: event.mode }),
            ...(event.pairingId === undefined ? {} : { pairingId: event.pairingId }),
            ...orbisDshErrorFields(event.error),
          });
        }),
      ];
      this.connectionState = "connected";
      this.connectionError = undefined;
      this.logger.info("transport.connect.succeeded", {
        hostId: configured.state.hostId,
        endpointCount: configured.endpoints.length,
      });
    } catch (error) {
      await listener?.close().catch(() => undefined);
      this.connectionState = "disconnected";
      this.connectionError = errorMessage(error, "Orbis could not start on this network");
      this.logger.error("transport.connect.failed", orbisDshErrorFields(error));
      throw error;
    }
  }

  private async disconnectLocked(): Promise<void> {
    const connection = this.connection;
    if (connection === undefined) {
      this.stopEndpointMonitor();
      this.deviceErrors.clear();
      this.connectionState = "disconnected";
      return;
    }
    this.releaseConnection(connection, true);
    await connection.close();
  }

  private releaseConnection(
    connection: OrbisDirectHostListener,
    expected: boolean,
    unexpectedMessage = "The Orbis host connection closed",
  ): void {
    if (this.connection !== connection) return;
    this.stopEndpointMonitor();
    this.connection = undefined;
    this.deviceErrors.clear();
    for (const dispose of this.connectionDisposers.splice(0)) dispose();
    this.connectionState = "disconnected";
    if (!expected) this.connectionError = unexpectedMessage;
    this.logger.info("transport.closed", { expected, message: unexpectedMessage });
  }

  private startEndpointMonitor(
    connection: OrbisDirectHostListener,
    state: OrbisDshHostState,
    identity: SerializedDeviceIdentity,
  ): void {
    this.stopEndpointMonitor();
    this.endpointMonitorConnection = connection;
    this.endpointMonitorState = state;
    this.endpointMonitorIdentity = identity;
    this.endpointMonitorSignature = JSON.stringify(this.endpointManifestForState(state, identity));
    this.endpointMonitorTimer = setInterval(() => {
      void this.refreshEndpointManifest().catch((error) => {
        this.logger.error("transport.endpoint_refresh_failed", orbisDshErrorFields(error));
      });
    }, ENDPOINT_MONITOR_INTERVAL_MS);
    this.endpointMonitorTimer.unref?.();
  }

  private stopEndpointMonitor(): void {
    if (this.endpointMonitorTimer !== undefined) clearInterval(this.endpointMonitorTimer);
    this.endpointMonitorTimer = undefined;
    this.endpointMonitorConnection = undefined;
    this.endpointMonitorState = undefined;
    this.endpointMonitorIdentity = undefined;
    this.endpointMonitorSignature = undefined;
  }

  private async refreshEndpointManifest(): Promise<void> {
    const connection = this.endpointMonitorConnection;
    const state = this.endpointMonitorState;
    const identity = this.endpointMonitorIdentity;
    if (connection === undefined || state === undefined || identity === undefined) return;
    if (this.connection !== connection) return;
    const manifest = this.endpointManifestForState(state, identity);
    const signature = JSON.stringify(manifest);
    if (signature === this.endpointMonitorSignature) return;
    await connection.broadcastEndpointManifest(manifest);
    this.endpointMonitorSignature = signature;
    this.logger.info("transport.endpoint_refreshed", {
      endpointCount: manifest.endpoints.length,
      endpointRevision: manifest.revision,
    });
  }

  private async noteConnected(peer: RemoteHostPeer): Promise<void> {
    await this.exclusive(async () => {
      await this.stateStore.update((state) => ({
        ...state,
        peers: state.peers.map((stored) =>
          stored.keyId === peer.keyId
            ? {
                ...stored,
                ...(peer.descriptor.deviceName === undefined
                  ? {}
                  : { deviceName: peer.descriptor.deviceName }),
                lastConnectedAt: nowIso(),
              }
            : stored,
        ),
      }));
    }).catch((error) => {
      this.connectionError = errorMessage(error, "Could not update paired device state");
    });
  }

  private routePeerError(event: RemoteHostPeerError): void {
    const message = errorMessage(event.error, "The Orbis peer connection failed");
    if (event.mode === "pairing") {
      const pending = this.pending;
      if (pending !== undefined && pending.pairingId === event.pairingId) {
        this.failPending(pending, message);
      }
      return;
    }
    if (event.mode !== "authenticated" || event.keyId === undefined) return;
    void this.noteDeviceError(event.keyId, message);
  }

  private async noteDeviceError(keyId: string, message: string): Promise<void> {
    try {
      const state = await this.stateStore.load();
      if (this.connection === undefined || !state.peers.some((peer) => peer.keyId === keyId))
        return;
      this.deviceErrors.set(keyId, message);
    } catch (error) {
      this.logger.error("peer.error_state_failed", orbisDshErrorFields(error));
    }
  }

  private async resolvePeer(frame: SecureHelloEnvelope): Promise<RemoteHostResolvedPeer> {
    if (frame.mode === "pairing") {
      const pending = this.pending;
      if (
        pending === undefined ||
        frame.pairingId !== pending.pairingId ||
        Date.parse(pending.expiresAt) <= Date.now() ||
        !frame.senderPublicKey
      ) {
        throw new Error("The pairing invitation is unavailable or expired");
      }
      pending.phase = "connecting";
      return {
        publicKey: frame.senderPublicKey,
        pairingSecret: pending.secret,
        scopes: [...pending.scopes],
      };
    }

    const peer = (await this.stateStore.load()).peers.find(
      (candidate) => candidate.keyId === frame.senderKeyId,
    );
    if (peer === undefined) throw new Error("The Orbis client is not paired with this host");
    return {
      publicKey: peer.publicKey,
      scopes: resolveRemoteScopes(peer.scopeMode, peer.scopes),
    };
  }

  private commitPairing(peer: RemoteHostPeer): Promise<void> {
    return this.exclusive(async () => {
      const pending = this.pending;
      if (
        pending === undefined ||
        peer.mode !== "pairing" ||
        peer.pairingId !== pending.pairingId
      ) {
        throw new Error("The pairing commit does not match the active invitation");
      }
      await this.stateStore.update((state) => ({
        ...state,
        peers: [
          ...state.peers.filter((candidate) => candidate.keyId !== peer.keyId),
          {
            keyId: peer.keyId,
            publicKey: peer.publicKey,
            deviceId: peer.descriptor.deviceId,
            ...(peer.descriptor.deviceName === undefined
              ? {}
              : { deviceName: peer.descriptor.deviceName }),
            version: peer.descriptor.version,
            scopeMode: pending.scopeMode,
            scopes: [...peer.scopes],
            pairedAt: nowIso(),
            lastConnectedAt: nowIso(),
          },
        ],
      }));
      this.logger.info("pairing.committed", {
        deviceId: peer.descriptor.deviceId,
        keyId: peer.keyId,
        pairingId: peer.pairingId ?? null,
      });
      this.clearPending(pending);
    });
  }

  private hostDescriptor(
    configured: ConfiguredHostState,
    identity: SerializedDeviceIdentity,
  ): RemoteHost {
    return {
      id: configured.state.hostId,
      name: configured.hostName,
      platform: process.platform + "-" + process.arch,
      status: "online",
      publicKeyFingerprint: identity.keyId,
      harnesses: [
        {
          id: ORBIS_DSH_HARNESS_ID,
          version: ORBIS_DSH_DRIVER_VERSION,
          capabilities: [...ORBIS_REMOTE_AGENT_V2_METHOD_LIST],
        },
      ],
    };
  }

  private endpointManifest(
    configured: ConfiguredHostState,
    identity: SerializedDeviceIdentity,
  ): HostEndpointManifest {
    return {
      hostId: configured.state.hostId,
      hostKeyId: identity.keyId,
      revision: configured.endpointRevision,
      endpoints: [...configured.endpoints],
    };
  }

  private endpointManifestForState(
    state: OrbisDshHostState,
    identity: SerializedDeviceIdentity,
  ): HostEndpointManifest {
    const configured = this.configurationFromState(state, true);
    if (configured === undefined) throw new Error("The Orbis host is not configured");
    return this.endpointManifest(configured, identity);
  }

  private pairingStatus(pending: PendingPairing): NonNullable<OrbisDshStatus["pairing"]> {
    return {
      pairingId: pending.pairingId,
      transport: pending.kind,
      expiresAt: pending.expiresAt,
      phase: pending.phase,
      invitation: pending.invitation,
      ...(pending.error === undefined ? {} : { error: pending.error }),
    };
  }

  private setPending(pending: PendingPairing): void {
    this.pending = pending;
    const delay = Math.max(0, Date.parse(pending.expiresAt) - Date.now());
    pending.expiryTimer = setTimeout(() => {
      void this.exclusive(async () => {
        if (this.pending !== pending || pending.controller.signal.aborted) return;
        this.failPending(pending, "The pairing invitation expired");
      }).catch(() => undefined);
    }, delay);
  }

  private failPending(pending: PendingPairing, message: string): void {
    if (this.pending !== pending || pending.phase === "failed") return;
    pending.phase = "failed";
    pending.error = message;
    pending.controller.abort();
  }

  private clearPending(pending: PendingPairing): void {
    if (this.pending === pending) this.pending = undefined;
    if (pending.expiryTimer !== undefined) clearTimeout(pending.expiryTimer);
    pending.controller.abort();
  }

  private discoveredDirectEndpoints(port: number, limit: number): readonly HostEndpoint[] {
    return this.discoverDirectAddresses()
      .slice(0, Math.max(0, limit))
      .map(({ kind, address }) =>
        hostEndpointSchema.parse({ kind, url: directWebSocketUrl(address, port) }),
      );
  }

  private endpointRevisionFor(
    state: OrbisDshHostState,
    endpoints: readonly HostEndpoint[],
  ): number {
    const signature = JSON.stringify(endpoints);
    this.endpointRevisionValue = Math.max(this.endpointRevisionValue, state.endpointRevision);
    if (this.endpointSignature === undefined) {
      this.endpointSignature = signature;
    } else if (this.endpointSignature !== signature) {
      this.endpointSignature = signature;
      this.endpointRevisionValue += 1;
    }
    return this.endpointRevisionValue;
  }

  private configurationFromState(
    state: OrbisDshHostState,
    requireConfigured: boolean,
  ): ConfiguredHostState | undefined {
    if (state.hostName === undefined) {
      if (requireConfigured) throw new Error("Configure the Orbis host name first");
      return undefined;
    }
    const port = directPortValue(state.directPort ?? ORBIS_DSH_DIRECT_PORT);
    const endpoints = this.discoveredDirectEndpoints(port, MAX_HOST_ENDPOINTS);
    if (endpoints.length === 0) {
      if (requireConfigured) {
        throw new Error("Connect this computer to a local network or Tailscale, then try again");
      }
      return undefined;
    }
    return {
      state,
      hostName: validHostName(state.hostName),
      directPort: port,
      endpoints,
      endpointRevision: this.endpointRevisionFor(state, endpoints),
    };
  }

  private async configuredState(): Promise<ConfiguredHostState> {
    return this.configurationFromState(await this.stateStore.load(), true)!;
  }

  private async identity(): Promise<SerializedDeviceIdentity> {
    const stored = await this.credentials.resolve(ORBIS_DSH_IDENTITY_CREDENTIAL);
    if (stored !== undefined) {
      try {
        return serializedDeviceIdentitySchema.parse(JSON.parse(stored.value));
      } catch {
        throw new Error(
          "The stored Orbis host identity is corrupt and cannot be rotated automatically",
        );
      }
    }
    const identity = await generateDeviceIdentity(this.random);
    await this.credentials.set(ORBIS_DSH_IDENTITY_CREDENTIAL, JSON.stringify(identity));
    return identity;
  }

  private async agentHostFor(hostId: string, hostKeyId: string): Promise<OrbisDshAgentHost> {
    const existing = this.agentHost;
    if (existing !== undefined) {
      if (this.agentHostKeyId !== hostKeyId) {
        throw new Error(
          "The Orbis host identity changed while its remote DSH runtime is still active",
        );
      }
      return existing;
    }
    const created = await this.agentHostFactory.create({ hostId, hostKeyId });
    if (
      !created ||
      typeof created.attach !== "function" ||
      typeof created.close !== "function" ||
      typeof created.requestHandler !== "function"
    ) {
      throw new Error("The Orbis DSH agent host factory returned an invalid v2 host");
    }
    this.agentHost = created;
    this.agentHostKeyId = hostKeyId;
    return created;
  }

  private loggedRequestHandler(handler: RemoteHostRequestHandler): RemoteHostRequestHandler {
    return async (method, params, context) => {
      const fields = requestLogFields(method, params, context);
      const startedAt = Date.now();
      this.logger.debug("remote.request.started", fields);
      try {
        const result = await withOrbisRemoteRequestDiagnostics(
          { method, requestId: context.requestId },
          () => handler(method, params, context),
        );
        this.logger.debug("remote.request.succeeded", {
          ...fields,
          durationMs: Math.max(0, Date.now() - startedAt),
        });
        return result;
      } catch (error) {
        this.logger.error("remote.request.failed", {
          ...fields,
          durationMs: Math.max(0, Date.now() - startedAt),
          ...orbisDshErrorFields(error),
        });
        throw error;
      }
    };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutationTail.then(operation, operation);
    this.mutationTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
