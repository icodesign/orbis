import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const DSH_GITHUB_REPOSITORY = "https://github.com/deepseek-ai/deepseek-harness.git";
const DSH_NPM_PACKAGE = "@deepseek-ai/dsh";

export interface CommandSpec {
  readonly command: string;
  readonly prefix: readonly string[];
  readonly cwd: string;
}

export type DshSelection =
  | { readonly kind: "default" }
  | { readonly kind: "binary"; readonly command: string }
  | { readonly kind: "local"; readonly directory: string }
  | { readonly kind: "github-tag"; readonly tag: string }
  | { readonly kind: "github-commit"; readonly commit: string }
  | { readonly kind: "npm"; readonly selector: string };

export interface PreparedDsh {
  readonly command: CommandSpec;
  readonly description: string;
}

interface PrepareDshOptions {
  readonly packageDirectory: string;
  readonly cleanupPaths: string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly runCommand: (
    spec: CommandSpec,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => Promise<void>;
}

function requireSelectorValue(selector: string, prefix: string): string {
  const value = selector.slice(prefix.length);
  if (value.length === 0) throw new Error(`DSH selector ${JSON.stringify(selector)} is incomplete`);
  return value;
}

function validateNpmSelector(selector: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/u.test(selector)) {
    throw new Error(
      `invalid DSH npm tag or version ${JSON.stringify(selector)}; use a dist-tag or exact version`,
    );
  }
}

function validateGitHubCommit(commit: string): void {
  if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/u.test(commit)) {
    throw new Error(
      `invalid DSH GitHub commit ${JSON.stringify(commit)}; use the complete 40- or 64-character hexadecimal commit`,
    );
  }
}

export function parseDshSelection(
  selector: string | undefined,
  binary: string | undefined,
  cwd = process.cwd(),
): DshSelection {
  if (selector !== undefined && binary !== undefined) {
    throw new Error("--dsh and --dsh-bin are mutually exclusive");
  }
  if (binary !== undefined) {
    if (binary.length === 0) throw new Error("--dsh-bin requires a non-empty command");
    return { kind: "binary", command: binary };
  }
  if (selector === undefined) return { kind: "default" };

  if (selector.startsWith("bin:")) {
    return { kind: "binary", command: requireSelectorValue(selector, "bin:") };
  }
  if (selector.startsWith("local:")) {
    const directory = requireSelectorValue(selector, "local:");
    return { kind: "local", directory: resolve(cwd, directory) };
  }
  if (selector.startsWith("github:tag:")) {
    return { kind: "github-tag", tag: requireSelectorValue(selector, "github:tag:") };
  }
  if (selector.startsWith("github:commit:")) {
    const commit = requireSelectorValue(selector, "github:commit:");
    validateGitHubCommit(commit);
    return { kind: "github-commit", commit };
  }
  if (selector.startsWith("npm:")) {
    const npmSelector = requireSelectorValue(selector, "npm:");
    validateNpmSelector(npmSelector);
    return { kind: "npm", selector: npmSelector };
  }

  throw new Error(
    `unsupported DSH selector ${JSON.stringify(selector)}; expected local:, github:tag:, github:commit:, npm:, or bin:`,
  );
}

function resolveBinaryCommand(command: string, packageDirectory: string): CommandSpec {
  if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
    const absoluteCommand = resolve(command);
    if (!existsSync(absoluteCommand)) throw new Error(`dsh CLI not found: ${absoluteCommand}`);
    return { command: absoluteCommand, prefix: [], cwd: packageDirectory };
  }
  if (command.length === 0) throw new Error("dsh CLI command cannot be empty");
  return { command, prefix: [], cwd: packageDirectory };
}

function resolveDefaultCommand(packageDirectory: string): CommandSpec {
  const localDsh = join(
    packageDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "dsh.cmd" : "dsh",
  );
  return resolveBinaryCommand(existsSync(localDsh) ? localDsh : "dsh", packageDirectory);
}

async function prepareSourceCheckout(
  directory: string,
  description: string,
  options: PrepareDshOptions,
): Promise<PreparedDsh> {
  const manifestPath = join(directory, "package.json");
  const lockfilePath = join(directory, "pnpm-lock.yaml");
  const sourceCliPath = join(directory, "apps", "cli", "src", "bin.ts");
  if (!existsSync(manifestPath) || !existsSync(lockfilePath) || !existsSync(sourceCliPath)) {
    throw new Error(
      `DSH source checkout is incomplete at ${directory}; expected package.json, pnpm-lock.yaml, and apps/cli/src/bin.ts`,
    );
  }

  await options.runCommand(
    { command: "pnpm", prefix: [], cwd: directory },
    ["install", "--frozen-lockfile"],
    options.environment,
  );
  await options.runCommand(
    { command: "pnpm", prefix: [], cwd: directory },
    ["run", "build"],
    options.environment,
  );

  const builtCliPath = join(directory, "apps", "cli", "lib", "bin.js");
  if (!existsSync(builtCliPath)) {
    throw new Error(`DSH build did not produce ${builtCliPath}`);
  }
  return {
    command: {
      command: process.execPath,
      prefix: [builtCliPath],
      cwd: directory,
    },
    description,
  };
}

async function prepareGitHubCheckout(
  selection: Extract<DshSelection, { readonly kind: "github-tag" | "github-commit" }>,
  options: PrepareDshOptions,
): Promise<PreparedDsh> {
  if (selection.kind === "github-tag") {
    await options.runCommand(
      { command: "git", prefix: [], cwd: options.packageDirectory },
      ["check-ref-format", `refs/tags/${selection.tag}`],
      options.environment,
    );
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "orbis-dsh-github-"));
  options.cleanupPaths.push(temporaryRoot);
  const checkout = join(temporaryRoot, "deepseek-harness");
  const git = { command: "git", prefix: [], cwd: checkout } satisfies CommandSpec;
  await options.runCommand(
    { command: "git", prefix: [], cwd: temporaryRoot },
    ["init", checkout],
    options.environment,
  );
  await options.runCommand(
    git,
    ["remote", "add", "origin", DSH_GITHUB_REPOSITORY],
    options.environment,
  );
  const requestedRef =
    selection.kind === "github-tag" ? `refs/tags/${selection.tag}` : selection.commit;
  await options.runCommand(
    git,
    ["fetch", "--depth", "1", "origin", requestedRef],
    options.environment,
  );
  await options.runCommand(git, ["checkout", "--detach", "FETCH_HEAD"], options.environment);

  return prepareSourceCheckout(
    checkout,
    selection.kind === "github-tag"
      ? `GitHub tag ${selection.tag}`
      : `GitHub commit ${selection.commit}`,
    options,
  );
}

async function prepareNpmDsh(selector: string, options: PrepareDshOptions): Promise<PreparedDsh> {
  const installRoot = await mkdtemp(join(tmpdir(), "orbis-dsh-npm-"));
  options.cleanupPaths.push(installRoot);
  await writeFile(
    join(installRoot, "package.json"),
    `${JSON.stringify({ name: "orbis-dsh-runtime", private: true }, undefined, 2)}\n`,
    "utf8",
  );
  await options.runCommand(
    { command: "pnpm", prefix: [], cwd: installRoot },
    ["add", "--save-exact", "--ignore-workspace", `${DSH_NPM_PACKAGE}@${selector}`],
    options.environment,
  );

  const manifest = JSON.parse(
    await readFile(join(installRoot, "node_modules", DSH_NPM_PACKAGE, "package.json"), "utf8"),
  ) as { readonly version?: unknown };
  if (typeof manifest.version !== "string") {
    throw new Error(`installed ${DSH_NPM_PACKAGE} does not declare a version`);
  }
  const binary = join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "dsh.cmd" : "dsh",
  );
  return {
    command: resolveBinaryCommand(binary, installRoot),
    description: `npm ${selector} (${manifest.version})`,
  };
}

export async function prepareDsh(
  selection: DshSelection,
  options: PrepareDshOptions,
): Promise<PreparedDsh> {
  switch (selection.kind) {
    case "default":
      return {
        command: resolveDefaultCommand(options.packageDirectory),
        description: "package-local npm CLI",
      };
    case "binary":
      return {
        command: resolveBinaryCommand(selection.command, options.packageDirectory),
        description: `binary ${selection.command}`,
      };
    case "local":
      return prepareSourceCheckout(
        selection.directory,
        `local source ${selection.directory}`,
        options,
      );
    case "github-tag":
    case "github-commit":
      return prepareGitHubCheckout(selection, options);
    case "npm":
      return prepareNpmDsh(selection.selector, options);
  }
}
