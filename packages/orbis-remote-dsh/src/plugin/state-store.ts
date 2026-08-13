import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { remoteScopeModeSchema, type RemoteScopeMode } from "@orbisapp/transport";

export interface OrbisDshPeer {
  readonly keyId: string;
  readonly publicKey: string;
  readonly deviceId: string;
  readonly deviceName?: string;
  readonly version: string;
  readonly scopeMode: RemoteScopeMode;
  readonly scopes: readonly string[];
  readonly pairedAt: string;
  readonly lastConnectedAt?: string;
}

export interface OrbisDshHostState {
  readonly version: 2;
  readonly hostId: string;
  readonly hostName?: string;
  readonly directPort?: number;
  readonly endpointRevision: number;
  readonly peers: readonly OrbisDshPeer[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, maximum = 16_384): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error("Orbis host state " + label + " is invalid");
  }
  return value;
}

function optionalString(value: unknown, label: string, maximum = 16_384): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label, maximum);
}

function optionalPort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1024 || value > 65_535) {
    throw new Error("Orbis host state directPort is invalid");
  }
  return value;
}

function endpointRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Orbis host state endpointRevision is invalid");
  }
  return value;
}

function parsePeer(value: unknown): OrbisDshPeer {
  if (!isRecord(value)) throw new Error("Orbis host state peer is invalid");
  const scopes = value.scopes;
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.length > 64 ||
    scopes.some((scope) => typeof scope !== "string" || scope.length === 0 || scope.length > 128) ||
    new Set(scopes).size !== scopes.length
  ) {
    throw new Error("Orbis host state peer scopes are invalid");
  }
  const pairedAt = requiredString(value.pairedAt, "peer pairedAt", 128);
  if (Number.isNaN(Date.parse(pairedAt))) {
    throw new Error("Orbis host state peer pairedAt is invalid");
  }
  const lastConnectedAt = optionalString(value.lastConnectedAt, "peer lastConnectedAt", 128);
  if (lastConnectedAt !== undefined && Number.isNaN(Date.parse(lastConnectedAt))) {
    throw new Error("Orbis host state peer lastConnectedAt is invalid");
  }
  const deviceName = optionalString(value.deviceName, "peer deviceName", 256);
  const scopeMode = remoteScopeModeSchema.parse(value.scopeMode ?? "all");
  return {
    keyId: requiredString(value.keyId, "peer keyId", 512),
    publicKey: requiredString(value.publicKey, "peer publicKey"),
    deviceId: requiredString(value.deviceId, "peer deviceId", 256),
    ...(deviceName === undefined ? {} : { deviceName }),
    version: requiredString(value.version, "peer version", 128),
    scopeMode,
    scopes: [...scopes],
    pairedAt,
    ...(lastConnectedAt === undefined ? {} : { lastConnectedAt }),
  };
}

function parseState(value: unknown): OrbisDshHostState {
  if (!isRecord(value) || value.version !== 2) {
    throw new Error("Orbis host state is unsupported or corrupt");
  }
  if (!Array.isArray(value.peers) || value.peers.length > 256) {
    throw new Error("Orbis host state peers are invalid");
  }
  const peers = value.peers.map(parsePeer);
  if (new Set(peers.map((peer) => peer.keyId)).size !== peers.length) {
    throw new Error("Orbis host state contains duplicate peer keys");
  }
  return {
    version: 2,
    hostId: requiredString(value.hostId, "hostId", 256),
    ...(value.hostName === undefined
      ? {}
      : { hostName: optionalString(value.hostName, "hostName", 256) }),
    ...(value.directPort === undefined ? {} : { directPort: optionalPort(value.directPort) }),
    endpointRevision: endpointRevision(value.endpointRevision),
    peers,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function defaultState(createHostId: () => string): OrbisDshHostState {
  return {
    version: 2,
    hostId: requiredString(createHostId(), "generated hostId", 256),
    endpointRevision: 0,
    peers: [],
  };
}

/** Durable non-secret host configuration and paired client keys. */
export class OrbisDshStateStore {
  private stateValue?: OrbisDshHostState;

  constructor(
    readonly path: string,
    private readonly createHostId: () => string = randomUUID,
  ) {}

  async load(): Promise<OrbisDshHostState> {
    if (this.stateValue !== undefined) return clone(this.stateValue);
    try {
      const metadata = await stat(this.path);
      if ((metadata.mode & 0o077) !== 0) {
        throw new Error("Orbis host state " + this.path + " must not be readable by other users");
      }
      this.stateValue = parseState(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.stateValue = defaultState(this.createHostId);
      await this.write(this.stateValue);
    }
    return clone(this.stateValue);
  }

  async update(
    mutate: (current: OrbisDshHostState) => OrbisDshHostState,
  ): Promise<OrbisDshHostState> {
    const current = await this.load();
    const next = parseState(mutate(clone(current)));
    await this.write(next);
    this.stateValue = next;
    return clone(next);
  }

  private async write(state: OrbisDshHostState): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = this.path + "." + process.pid + "." + randomUUID() + ".tmp";
    const payload = JSON.stringify(state, undefined, 2) + "\n";
    try {
      await writeFile(temporaryPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }
}
