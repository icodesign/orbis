import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DSH_HOME = join(homedir(), ".dsh");
const DSH_PROFILE = "web";
const LEGACY_PACKAGE_NAME = "@orbis/dsh-orbis-remote";
const PACKAGE_NAME = "@orbis/remote-dsh";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3080;

interface CommandSpec {
  readonly command: string;
  readonly prefix: readonly string[];
  readonly cwd: string;
}

interface Options {
  readonly harnessDirectory: string;
  readonly dsh: CommandSpec;
  readonly home: string;
  readonly port: number;
  readonly workspaceRoot?: string;
  readonly keepFixture: boolean;
}

const NODE_DIRECTORY_SYMLINK_REMOVAL_PROBE = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbis-dsh-node-probe-"));
const target = path.join(root, "target");
const link = path.join(root, "link");
let supported = false;
try {
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, "junction");
  fs.rmSync(link);
  supported = true;
} finally {
  try { fs.unlinkSync(link); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
if (!supported) process.exitCode = 1;
`;

interface Fixture {
  readonly cleanupPaths: readonly string[];
  readonly home: string;
  readonly workspaceRoot: string;
}

function usage(): void {
  console.log(`Usage: pnpm run serve:dsh [options]

Build and install ${PACKAGE_NAME} into the persistent DSH web profile,
then start dsh web on the loopback interface.

Options:
  --harness <path>         DeepSeek Harness checkout
  --dsh-bin <command>     dsh executable or built apps/cli/lib/bin.js path
  --node-bin <command>    Node executable used for a built DSH CLI
  --home <path>            DSH_HOME; defaults to ~/.dsh and reuses its web profile
  --workspace-root <path>  workspace root; defaults to a disposable temporary path
  --port <number>          DSH Web port (default: ${DEFAULT_PORT})
  --keep                   keep the generated temporary workspace after exit
  -h, --help               show this help

Environment overrides:
  ORBIS_DSH_HARNESS_DIR   same as --harness
  ORBIS_DSH_BIN           same as --dsh-bin
  ORBIS_DSH_NODE_BIN      same as --node-bin
  DSH_HOME                override the default DSH home
`);
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value))
    throw new Error(`--port must be a number, got ${JSON.stringify(value)}`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`--port must be between 0 and 65535, got ${value}`);
  }
  return port;
}

function nodeSupportsDshProfileHealing(command: string): boolean {
  return (
    spawnSync(command, ["-e", NODE_DIRECTORY_SYMLINK_REMOVAL_PROBE], {
      stdio: "ignore",
    }).status === 0
  );
}

function resolveCompatibleNode(requested?: string): string {
  const executable = process.platform === "win32" ? "node.exe" : "node";
  const candidates = requested
    ? [requested]
    : [
        process.execPath,
        ...(process.env.PATH ?? "")
          .split(delimiter)
          .filter((directory) => directory.length > 0)
          .map((directory) => join(directory, executable))
          .filter(existsSync),
      ];
  for (const candidate of new Set(candidates)) {
    if (nodeSupportsDshProfileHealing(candidate)) return candidate;
  }
  const detail = requested === undefined ? "available Node installations" : requested;
  throw new Error(
    `${detail} cannot safely refresh DSH's profile links; upgrade Node or pass --node-bin`,
  );
}

function resolveDshCommand(
  harnessDirectory: string,
  requested?: string,
  requestedNode?: string,
): CommandSpec {
  const builtCli = join(harnessDirectory, "apps/cli/lib/bin.js");
  const candidate = requested ?? builtCli;
  if (existsSync(candidate)) {
    return {
      command: resolveCompatibleNode(requestedNode),
      prefix: [resolve(candidate)],
      cwd: harnessDirectory,
    };
  }
  if (candidate.includes("/") || isAbsolute(candidate)) {
    throw new Error(`dsh CLI not found: ${candidate}`);
  }
  return {
    command: candidate,
    prefix: [],
    cwd: harnessDirectory,
  };
}

function parseOptions(argv: readonly string[]): Options {
  let harnessDirectory = process.env.ORBIS_DSH_HARNESS_DIR ?? process.env.DEEPSEEK_HARNESS_DIR;
  let dshBin = process.env.ORBIS_DSH_BIN;
  let nodeBin = process.env.ORBIS_DSH_NODE_BIN;
  let home = process.env.DSH_HOME ?? DEFAULT_DSH_HOME;
  let port = DEFAULT_PORT;
  let workspaceRoot = process.env.ORBIS_DSH_WORKSPACE_ROOT;
  let keepFixture = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      case "--harness":
        harnessDirectory = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--dsh-bin":
        dshBin = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--node-bin":
        nodeBin = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--home":
        home = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--port":
        port = parsePort(requireValue(argv, index, argument));
        index += 1;
        break;
      case "--workspace-root":
        workspaceRoot = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--keep":
        keepFixture = true;
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }

  if (harnessDirectory === undefined) {
    throw new Error("a DSH checkout is required; pass --harness or set ORBIS_DSH_HARNESS_DIR");
  }
  harnessDirectory = resolve(harnessDirectory);
  return {
    dsh: resolveDshCommand(harnessDirectory, dshBin, nodeBin),
    harnessDirectory,
    home: resolve(home),
    keepFixture,
    port,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot: resolve(workspaceRoot) }),
  };
}

async function createFixture(options: Options): Promise<Fixture> {
  const cleanupPaths: string[] = [];
  let workspaceRoot: string;
  if (options.workspaceRoot !== undefined) {
    workspaceRoot = options.workspaceRoot;
  } else {
    const temporaryWorkspaceRoot = await mkdtemp(join(tmpdir(), "orbis-dsh-web-"));
    cleanupPaths.push(temporaryWorkspaceRoot);
    workspaceRoot = join(temporaryWorkspaceRoot, "workspace");
  }

  const home = options.home;
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  return { cleanupPaths, home, workspaceRoot };
}

function commandLine(spec: CommandSpec, args: readonly string[]): string {
  return [spec.command, ...spec.prefix, ...args].join(" ");
}

async function runCommand(
  spec: CommandSpec,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  console.log(`\n$ ${commandLine(spec, args)}`);
  const child = spawn(spec.command, [...spec.prefix, ...args], {
    cwd: spec.cwd,
    env,
    stdio: "inherit",
  });
  const result = await waitForExit(child);
  if (result.signal !== null || result.code !== 0) {
    throw new Error(
      `${commandLine(spec, args)} exited with ${result.signal ?? `code ${result.code ?? 1}`}`,
    );
  }
}

function waitForExit(
  child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function profileDependencies(home: string): Promise<ReadonlySet<string> | undefined> {
  const manifestPath = join(home, "profiles", DSH_PROFILE, "package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (typeof manifest !== "object" || manifest === null || !("dependencies" in manifest)) {
    return new Set();
  }
  const dependencies = manifest.dependencies;
  if (typeof dependencies !== "object" || dependencies === null) return new Set();
  return new Set(Object.keys(dependencies));
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    waitForExit(child).catch(() => undefined),
    new Promise<void>((resolveTimeout) => {
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolveTimeout();
      }, 10_000).unref();
    }),
  ]);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const fixture = await createFixture(options);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ORBIS_DSH_HARNESS_DIR: options.harnessDirectory,
    DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME ?? join(fixture.home, "agents"),
    DSH_HOME: fixture.home,
    DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? "workspace-write",
    DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED ?? "1",
  };

  console.log(`DSH repository: ${options.harnessDirectory}`);
  console.log(`DSH command: ${commandLine(options.dsh, [])}`);
  console.log(`DSH profile: ${DSH_PROFILE}`);
  console.log(`DSH home: ${fixture.home}`);
  console.log(`Workspace root: ${fixture.workspaceRoot}`);
  console.log(`Web URL: http://${DEFAULT_HOST}:${options.port}`);

  let web: ChildProcess | undefined;
  const forwardSignal = (signal: NodeJS.Signals): void => {
    if (web !== undefined && web.exitCode === null && web.signalCode === null) web.kill(signal);
    if (!options.keepFixture) {
      for (const path of fixture.cleanupPaths) rmSync(path, { recursive: true, force: true });
    }
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);

  try {
    await runCommand(
      { command: "pnpm", prefix: [], cwd: PACKAGE_DIRECTORY },
      ["install", "--config.auto-install-peers=false"],
      environment,
    );
    await runCommand(
      { command: "pnpm", prefix: [], cwd: PACKAGE_DIRECTORY },
      ["run", "build"],
      environment,
    );
    const existingDependencies = await profileDependencies(fixture.home);
    if (existingDependencies !== undefined) {
      await runCommand(
        {
          command: "pnpm",
          prefix: [],
          cwd: join(fixture.home, "profiles", DSH_PROFILE),
        },
        ["install", "--config.auto-install-peers=false"],
        environment,
      );
    }
    for (const packageName of [LEGACY_PACKAGE_NAME, PACKAGE_NAME]) {
      if (!existingDependencies?.has(packageName)) continue;
      await runCommand(
        options.dsh,
        ["plugin", "--profile", DSH_PROFILE, "remove", packageName],
        environment,
      );
    }
    await runCommand(
      options.dsh,
      ["plugin", "--profile", DSH_PROFILE, "add", `link:${PACKAGE_DIRECTORY}`],
      environment,
    );
    await runCommand(
      options.dsh,
      ["plugin", "--profile", DSH_PROFILE, "why", PACKAGE_NAME],
      environment,
    );

    const webArgs = [
      "--profile",
      DSH_PROFILE,
      "--host",
      DEFAULT_HOST,
      "--port",
      String(options.port),
    ];
    console.log(`\n$ ${commandLine(options.dsh, webArgs)}\n`);
    web = spawn(options.dsh.command, [...options.dsh.prefix, ...webArgs], {
      cwd: fixture.workspaceRoot,
      env: environment,
      stdio: "inherit",
    });
    const result = await waitForExit(web);
    if (result.signal === "SIGINT" || result.signal === "SIGTERM") return;
    if (result.signal !== null || result.code !== 0) {
      throw new Error(`dsh web exited with ${result.signal ?? `code ${result.code ?? 1}`}`);
    }
  } finally {
    process.removeListener("SIGINT", forwardSignal);
    process.removeListener("SIGTERM", forwardSignal);
    if (web !== undefined) await stopChild(web);
    if (options.keepFixture && fixture.cleanupPaths.length > 0) {
      console.log(`Kept temporary workspace at ${fixture.cleanupPaths.join(", ")}`);
    } else if (options.keepFixture) {
      console.log("No temporary workspace was created.");
    } else {
      await Promise.all(
        fixture.cleanupPaths.map((path) => rm(path, { recursive: true, force: true })),
      );
    }
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
