import { mkdtemp, mkdir, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type {
  DirectoryListing,
  DirectoryPickerBrowseCapability,
} from "@deepseek-ai/dsh-host-directory-picker";
import type { Workspace } from "@deepseek-ai/dsh-workspace";
import { afterEach, expect, test } from "vitest";

import { createDshWorkspaceFolderProvider } from "./workspace-folder-provider";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "orbis-folder-provider-"));
  fixtures.push(parent);
  const root = join(parent, "allowed");
  const child = join(root, "project");
  await mkdir(child, { recursive: true });
  const browser: DirectoryPickerBrowseCapability = {
    kind: "browse",
    createDirectory: async (path, name) => {
      const created = join(path, name);
      await mkdir(created);
      return created;
    },
    list: async (path): Promise<DirectoryListing> => {
      const current = await realpath(path ?? root);
      return {
        crumbs: [],
        entries: (await readdir(current, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .map((entry) => ({
            hidden: entry.name.startsWith("."),
            name: entry.name,
            path: join(current, entry.name),
          })),
        home: parent,
        path: current,
        truncated: false,
      };
    },
  };
  const workspace = {
    create: async (path: string) =>
      ({ id: "workspace-a", path, title: basename(path) }) as Workspace,
    resolveByPath: async () => undefined,
  };
  return {
    child,
    parent,
    provider: await createDshWorkspaceFolderProvider({ browser, roots: [root], workspace }),
    root,
  };
}

test("browse exposes opaque refs and registers the selected canonical directory", async () => {
  const { child, provider } = await fixture();
  const roots = await provider.browse({});
  expect(roots.entries).toHaveLength(1);
  expect(roots.entries[0]?.ref).not.toContain(child);

  const listing = await provider.browse({ folderRef: roots.entries[0]!.ref });
  expect(listing.entries.map((entry) => entry.displayName)).toEqual(["project"]);
  const result = await provider.register({ folderRef: listing.entries[0]!.ref });
  expect(result).toMatchObject({
    created: true,
    workspace: { displayName: "project", ref: "workspace-a" },
  });
});

test("creates a child folder under the selected canonical directory", async () => {
  const { provider, root } = await fixture();
  const roots = await provider.browse({});
  const created = await provider.create({ folderRef: roots.entries[0]!.ref, name: "fresh" });

  expect(created).toMatchObject({ displayName: "fresh", hidden: false, selectable: true });
  expect(created.ref).not.toContain(root);
  await expect(readdir(join(root, "fresh"))).resolves.toEqual([]);
});

test("rejects invalid folder names before touching the directory picker", async () => {
  const { provider } = await fixture();
  const roots = await provider.browse({});

  await expect(
    provider.create({ folderRef: roots.entries[0]!.ref, name: "../escape" }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
  });
});

test("uses the directory picker's Home instead of the DSH process cwd by default", async () => {
  const parent = await mkdtemp(join(tmpdir(), "orbis-folder-provider-home-"));
  fixtures.push(parent);
  const home = join(parent, "home");
  const project = join(home, "project");
  await mkdir(project, { recursive: true });
  const listedPaths: Array<string | undefined> = [];
  const browser: DirectoryPickerBrowseCapability = {
    kind: "browse",
    createDirectory: async () => {
      throw new Error("unused");
    },
    list: async (path): Promise<DirectoryListing> => {
      listedPaths.push(path);
      const current = await realpath(path ?? home);
      return {
        crumbs: [],
        entries: (await readdir(current, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({ hidden: false, name: entry.name, path: join(current, entry.name) })),
        home,
        path: current,
        truncated: false,
      };
    },
  };
  const provider = await createDshWorkspaceFolderProvider({
    browser,
    workspace: {
      create: async (path: string) =>
        ({ id: "workspace-home", path, title: basename(path) }) as Workspace,
      resolveByPath: async () => undefined,
    },
  });

  expect(listedPaths).toEqual([undefined]);
  const roots = await provider.browse({});
  expect(roots.entries).toMatchObject([{ displayName: "Home" }]);
  const listing = await provider.browse({ folderRef: roots.entries[0]!.ref });
  expect(listing.entries.map((entry) => entry.displayName)).toEqual(["project"]);
});

test("browse rejects a tampered folder reference", async () => {
  const { provider } = await fixture();
  const roots = await provider.browse({});
  const token = roots.entries[0]!.ref;
  const signatureOffset = token.lastIndexOf(".") + 1;
  const replacement = token[signatureOffset] === "A" ? "B" : "A";
  const tampered = `${token.slice(0, signatureOffset)}${replacement}${token.slice(signatureOffset + 1)}`;
  await expect(provider.browse({ folderRef: tampered })).rejects.toMatchObject({
    code: "invalid_argument",
  });
});

test("browse filters a symlink that resolves outside the configured root", async () => {
  const { parent, provider, root } = await fixture();
  const outside = join(parent, "outside");
  await mkdir(outside);
  await symlink(outside, join(root, "escape"));
  const roots = await provider.browse({});
  const listing = await provider.browse({ folderRef: roots.entries[0]!.ref });
  expect(listing.entries.map((entry) => entry.displayName)).not.toContain("escape");
});
