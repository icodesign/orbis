import { lstat, mkdir, readlink, stat, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harnessDirectory = process.env.ORBIS_DSH_HARNESS_DIR ?? process.env.DEEPSEEK_HARNESS_DIR;

const peerPaths: Readonly<Record<string, string>> = {
  cordis: "vendor/cordis",
  schemastery: "vendor/schemastery",
  "dsh-agent": "packages/core/agent",
  "dsh-client-locale": "packages/client/locale",
  "dsh-client-runtime": "packages/client/runtime",
  "dsh-client-ui-primitives": "packages/client/ui-primitives",
  "dsh-client-ui-settings": "packages/client/ui-settings",
  "dsh-client-ui-slots": "packages/client/ui-slots",
  "dsh-credentials": "packages/credentials/credentials",
  "dsh-home-paths": "packages/util/home-paths",
  "dsh-host-apiproxy": "packages/host/apiproxy",
  "dsh-host-directory-picker": "packages/host/directory-picker",
  "dsh-host-directory-picker-browse": "packages/host/directory-picker-browse",
  "dsh-host-webserver": "packages/host/webserver",
  "dsh-llm": "packages/llm/llm",
  "dsh-session": "packages/core/session",
  "dsh-session-persistence": "packages/session/session-persistence",
  "dsh-session-projection-cache": "packages/session/session-projection-cache",
  "dsh-workspace": "packages/workspace/workspace",
};

async function replaceSymlink(path: string, target: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (!existing.isSymbolicLink()) {
      throw new Error(`refusing to replace a non-symlink DSH dependency: ${path}`);
    }
    await unlink(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await symlink(target, path, "dir");
}

if (harnessDirectory === undefined) {
  throw new Error(
    "a DSH checkout is required; set ORBIS_DSH_HARNESS_DIR before building the plugin",
  );
}

const harnessRoot = resolve(harnessDirectory);
await stat(harnessRoot);
const scopeDirectory = join(packageDirectory, "node_modules", "@deepseek-ai");
await mkdir(scopeDirectory, { recursive: true });

for (const [name, relativePath] of Object.entries(peerPaths)) {
  const target = resolve(harnessRoot, relativePath);
  await stat(target);
  await replaceSymlink(join(scopeDirectory, name), target);
}

const configured = await Promise.all(
  Object.keys(peerPaths).map(async (name) => `${name} -> ${await readlink(join(scopeDirectory, name))}`),
);
console.log(`Configured ${configured.length} DSH peer links from ${harnessRoot}`);
