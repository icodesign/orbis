import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { remoteScopeModeSchema, type RemoteScopeMode } from "@orbisapp/transport";
import { hasSharedFileMode } from "@orbisapp/remote-agent-node-store";
import { z } from "zod";

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

const validDateString = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const hostIdSchema = z.string().min(1).max(256);

const orbisDshPeerSchema = z
  .object({
    keyId: z.string().min(1).max(512),
    publicKey: z.string().min(1).max(16_384),
    deviceId: z.string().min(1).max(256),
    deviceName: z.string().min(1).max(256).optional(),
    version: z.string().min(1).max(128),
    scopeMode: z.preprocess((value) => value ?? "all", remoteScopeModeSchema),
    scopes: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(64)
      .refine((scopes) => new Set(scopes).size === scopes.length, {
        message: "Orbis host state peer scopes must be unique",
        path: ["scopes"],
      }),
    pairedAt: validDateString.max(128),
    lastConnectedAt: validDateString.max(128).optional(),
  })
  .transform(
    (peer): OrbisDshPeer => ({
      keyId: peer.keyId,
      publicKey: peer.publicKey,
      deviceId: peer.deviceId,
      ...(peer.deviceName === undefined ? {} : { deviceName: peer.deviceName }),
      version: peer.version,
      scopeMode: peer.scopeMode,
      scopes: peer.scopes,
      pairedAt: peer.pairedAt,
      ...(peer.lastConnectedAt === undefined ? {} : { lastConnectedAt: peer.lastConnectedAt }),
    }),
  );

const orbisDshHostStateSchema = z
  .object({
    version: z.literal(2),
    hostId: hostIdSchema,
    hostName: z.string().min(1).max(256).optional(),
    directPort: z.number().int().min(1024).max(65_535).optional(),
    endpointRevision: z.number().int().nonnegative(),
    peers: z
      .array(orbisDshPeerSchema)
      .max(256)
      .refine((peers) => new Set(peers.map((peer) => peer.keyId)).size === peers.length, {
        message: "Orbis host state contains duplicate peer keys",
        path: ["peers"],
      }),
  })
  .transform(
    (state): OrbisDshHostState => ({
      version: 2,
      hostId: state.hostId,
      ...(state.hostName === undefined ? {} : { hostName: state.hostName }),
      ...(state.directPort === undefined ? {} : { directPort: state.directPort }),
      endpointRevision: state.endpointRevision,
      peers: state.peers,
    }),
  );

function parseState(value: unknown): OrbisDshHostState {
  const result = orbisDshHostStateSchema.safeParse(value);
  if (!result.success) throw new Error("Orbis host state is unsupported or corrupt");
  return result.data;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function defaultState(createHostId: () => string): OrbisDshHostState {
  return {
    version: 2,
    hostId: hostIdSchema.parse(createHostId()),
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
      if (hasSharedFileMode(metadata.mode)) {
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
