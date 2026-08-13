import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import type { DirectoryPickerBrowseCapability } from "@deepseek-ai/dsh-host-directory-picker";
import type { Workspace, WorkspaceRegistry } from "@deepseek-ai/dsh-workspace";
import {
  AgentBackendError,
  isAgentBackendError,
  type AgentWorkspaceFolderDescriptor,
  type AgentWorkspaceFolderListing,
  type AgentWorkspaceRegisterResult,
} from "@orbisapp/orbis-agent-backend";
import type { DshRemoteWorkspaceProvider } from "../host";

const TOKEN_PREFIX = "folder.v1";
const MAX_TOKEN_BYTES = 4_096;

interface RootRecord {
  readonly displayName: string;
  readonly path: string;
  readonly root: number;
}

interface FolderPayload {
  readonly root: number;
  readonly segments: readonly string[];
}

export interface CreateDshWorkspaceFolderProviderOptions {
  readonly browser: DirectoryPickerBrowseCapability;
  readonly roots?: readonly string[];
  readonly workspace: Pick<WorkspaceRegistry, "create" | "resolveByPath">;
}

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function workspaceResult(workspace: Workspace, created: boolean): AgentWorkspaceRegisterResult {
  const displayName = workspace.title.trim();
  const ref = String(workspace.id).trim();
  if (!displayName || !ref) {
    throw new AgentBackendError("protocol", "DSH returned invalid workspace metadata");
  }
  return { created, workspace: { displayName, ref } };
}

class DshWorkspaceFolderProvider implements DshRemoteWorkspaceProvider {
  private registrationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly browser: DirectoryPickerBrowseCapability,
    private readonly roots: readonly RootRecord[],
    private readonly secret: Uint8Array,
    private readonly workspace: Pick<WorkspaceRegistry, "create" | "resolveByPath">,
  ) {}

  async browse(input: {
    readonly folderRef?: string;
    readonly signal?: AbortSignal;
  }): Promise<AgentWorkspaceFolderListing> {
    if (input.signal?.aborted)
      throw new AgentBackendError("unavailable", "Folder browsing was cancelled");
    if (input.folderRef === undefined) {
      return {
        breadcrumbs: [],
        current: null,
        entries: this.roots.map((root) => this.descriptor(root, [], root.displayName, false)),
        truncated: false,
      };
    }

    const resolved = await this.resolveFolder(input.folderRef);
    let listing;
    try {
      listing = await this.browser.list(resolved.path, input.signal);
    } catch {
      throw new AgentBackendError("unavailable", "The server folder could not be listed", {
        retryable: true,
      });
    }
    const entries = (
      await Promise.all(
        listing.entries.map(async (entry): Promise<AgentWorkspaceFolderDescriptor | null> => {
          try {
            const canonical = await realpath(entry.path);
            if (!contained(resolved.root.path, canonical)) return null;
            const segments = this.relativeSegments(resolved.root.path, canonical);
            return this.descriptor(resolved.root, segments, entry.name, entry.hidden);
          } catch {
            return null;
          }
        }),
      )
    ).filter((entry): entry is AgentWorkspaceFolderDescriptor => entry !== null);

    return {
      breadcrumbs: this.breadcrumbs(resolved.root, resolved.segments),
      current: this.descriptor(
        resolved.root,
        resolved.segments,
        resolved.segments.at(-1) ?? resolved.root.displayName,
        false,
      ),
      entries,
      truncated: listing.truncated,
    };
  }

  register(input: { readonly folderRef: string }): Promise<AgentWorkspaceRegisterResult> {
    const operation = this.registrationTail.then(async () => {
      try {
        const resolved = await this.resolveFolder(input.folderRef);
        const existing = await this.workspace.resolveByPath(resolved.path);
        if (existing !== undefined) return workspaceResult(existing, false);
        return workspaceResult(await this.workspace.create(resolved.path), true);
      } catch (error) {
        if (isAgentBackendError(error)) throw error;
        throw new AgentBackendError("unavailable", "The server workspace could not be registered", {
          retryable: true,
        });
      }
    });
    this.registrationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private breadcrumbs(
    root: RootRecord,
    segments: readonly string[],
  ): readonly AgentWorkspaceFolderDescriptor[] {
    const result: AgentWorkspaceFolderDescriptor[] = [
      this.descriptor(root, [], root.displayName, false),
    ];
    for (let index = 0; index < segments.length; index += 1) {
      result.push(this.descriptor(root, segments.slice(0, index + 1), segments[index]!, false));
    }
    return result;
  }

  private descriptor(
    root: RootRecord,
    segments: readonly string[],
    displayName: string,
    hidden: boolean,
  ): AgentWorkspaceFolderDescriptor {
    return {
      displayName: displayName || root.displayName,
      hidden,
      ref: this.sign({ root: root.root, segments }),
      selectable: true,
    };
  }

  private relativeSegments(root: string, path: string): readonly string[] {
    const value = relative(root, path);
    if (!value) return [];
    return value.split(sep);
  }

  private async resolveFolder(folderRef: string): Promise<{
    readonly path: string;
    readonly root: RootRecord;
    readonly segments: readonly string[];
  }> {
    const payload = this.verify(folderRef);
    const root = this.roots[payload.root];
    if (root === undefined)
      throw new AgentBackendError("invalid_argument", "Folder reference is invalid");
    const candidate = await realpath(resolve(root.path, ...payload.segments)).catch(
      () => undefined,
    );
    if (candidate === undefined || !contained(root.path, candidate)) {
      throw new AgentBackendError("not_found", "The server folder is unavailable");
    }
    const metadata = await stat(candidate).catch(() => undefined);
    if (!metadata?.isDirectory())
      throw new AgentBackendError("not_found", "The server folder is unavailable");
    return { path: candidate, root, segments: this.relativeSegments(root.path, candidate) };
  }

  private sign(payload: FolderPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.secret).update(body).digest("base64url");
    return `${TOKEN_PREFIX}.${body}.${signature}`;
  }

  private verify(token: string): FolderPayload {
    if (!token || Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
      throw new AgentBackendError("invalid_argument", "Folder reference is invalid");
    }
    const [prefix, version, body, signature, ...extra] = token.split(".");
    if (`${prefix}.${version}` !== TOKEN_PREFIX || !body || !signature || extra.length > 0) {
      throw new AgentBackendError("invalid_argument", "Folder reference is invalid");
    }
    const expected = createHmac("sha256", this.secret).update(body).digest();
    const actual = Buffer.from(signature, "base64url");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new AgentBackendError("invalid_argument", "Folder reference is invalid");
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw new AgentBackendError("invalid_argument", "Folder reference is invalid");
    }
    if (
      typeof value !== "object" ||
      value === null ||
      !("root" in value) ||
      !Number.isSafeInteger(value.root) ||
      !("segments" in value) ||
      !Array.isArray(value.segments) ||
      value.segments.some(
        (segment) =>
          typeof segment !== "string" ||
          !segment ||
          segment === "." ||
          segment === ".." ||
          segment.includes("/") ||
          segment.includes("\\"),
      )
    ) {
      throw new AgentBackendError("invalid_argument", "Folder reference is invalid");
    }
    return value as unknown as FolderPayload;
  }
}

export async function createDshWorkspaceFolderProvider(
  options: CreateDshWorkspaceFolderProviderOptions,
): Promise<DshRemoteWorkspaceProvider> {
  const configuredRoots: readonly { readonly displayName?: string; readonly path: string }[] =
    options.roots?.length
      ? options.roots.map((path) => ({ path }))
      : [{ displayName: "Home", path: (await options.browser.list()).path }];
  const roots: RootRecord[] = [];
  const seen = new Set<string>();
  for (const configured of configuredRoots) {
    const path = await realpath(resolve(configured.path));
    const metadata = await stat(path);
    if (!metadata.isDirectory()) throw new Error("Every workspaceRoots entry must be a directory");
    if (seen.has(path)) throw new Error("workspaceRoots must not contain duplicate directories");
    seen.add(path);
    roots.push({
      displayName: (configured.displayName ?? basename(path)) || path,
      path,
      root: roots.length,
    });
  }
  return new DshWorkspaceFolderProvider(options.browser, roots, randomBytes(32), options.workspace);
}
