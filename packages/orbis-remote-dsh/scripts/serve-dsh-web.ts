import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  type CommandSpec,
  type DshSelection,
  parseDshSelection,
  prepareDsh,
} from "./serve-dsh-source";

const packageManifestSchema = z.object({
  dependencies: z.record(z.string(), z.unknown()),
});

const PACKAGE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DSH_HOME = join(homedir(), ".dsh");
const DSH_PROFILE = "web";
const OBSOLETE_PACKAGE_NAMES = ["@orbis/dsh-orbis-remote", "@orbis/remote-dsh"] as const;
const PACKAGE_NAME = "@orbisapp/remote-dsh";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3080;

interface Options {
  readonly dsh: DshSelection;
  readonly home: string;
  readonly port: number;
  readonly workspaceRoot?: string;
  readonly keepFixture: boolean;
}

interface Fixture {
  readonly cleanupPaths: string[];
  readonly home: string;
  readonly workspaceRoot: string;
}

function usage(): void {
  console.log(`Usage: pnpm run serve:dsh [options]

Build and install ${PACKAGE_NAME} into the persistent DSH web profile,
then start dsh web on the loopback interface.

Options:
  --dsh <selector>         DSH source; defaults to the package-local npm CLI
                           local:<path>
                           github:tag:<tag>
                           github:commit:<commit>
                           npm:<tag-or-version>
                           bin:<command>
  --dsh-bin <command>      explicit dsh executable (mutually exclusive with --dsh)
  --home <path>            DSH_HOME; defaults to ~/.dsh and reuses its web profile
  --workspace-root <path>  workspace root; defaults to a disposable temporary path
  --port <number>          DSH Web port (default: ${DEFAULT_PORT})
  --keep                   keep generated temporary files after exit
  -h, --help               show this help

Environment overrides:
  ORBIS_DSH              same as --dsh
  ORBIS_DSH_BIN          same as --dsh-bin
  DSH_HOME               override the default DSH home
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

function parseOptions(argv: readonly string[]): Options {
  let dshSelector = process.env.ORBIS_DSH;
  let dshBin = process.env.ORBIS_DSH_BIN;
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
      case "--dsh-bin":
        dshBin = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--dsh":
        dshSelector = requireValue(argv, index, argument);
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

  return {
    dsh: parseDshSelection(dshSelector, dshBin),
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
  const result = packageManifestSchema.safeParse(manifest);
  return new Set(result.success ? Object.keys(result.data.dependencies) : []);
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
    DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME ?? join(fixture.home, "agents"),
    DSH_HOME: fixture.home,
    DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? "workspace-write",
    DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED ?? "1",
    ORBIS_DSH_RAW_EVENT_RECORDING: process.env.ORBIS_DSH_RAW_EVENT_RECORDING ?? "1",
  };

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
      ["install"],
      environment,
    );
    await runCommand(
      { command: "pnpm", prefix: [], cwd: PACKAGE_DIRECTORY },
      ["run", "build"],
      environment,
    );
    const dsh = await prepareDsh(options.dsh, {
      packageDirectory: PACKAGE_DIRECTORY,
      cleanupPaths: fixture.cleanupPaths,
      environment,
      runCommand,
    });
    console.log(`DSH source: ${dsh.description}`);
    console.log(`DSH command: ${commandLine(dsh.command, [])}`);
    const existingDependencies = await profileDependencies(fixture.home);
    if (existingDependencies !== undefined) {
      await runCommand(
        {
          command: "pnpm",
          prefix: [],
          cwd: join(fixture.home, "profiles", DSH_PROFILE),
        },
        ["install"],
        environment,
      );
    }
    for (const packageName of [...OBSOLETE_PACKAGE_NAMES, PACKAGE_NAME]) {
      if (!existingDependencies?.has(packageName)) continue;
      await runCommand(
        dsh.command,
        ["plugin", "--profile", DSH_PROFILE, "remove", packageName],
        environment,
      );
    }
    await runCommand(
      dsh.command,
      ["plugin", "--profile", DSH_PROFILE, "add", `link:${PACKAGE_DIRECTORY}`],
      environment,
    );
    await runCommand(
      dsh.command,
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
    console.log(`\n$ ${commandLine(dsh.command, webArgs)}\n`);
    web = spawn(dsh.command.command, [...dsh.command.prefix, ...webArgs], {
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
      console.log(`Kept temporary paths at ${fixture.cleanupPaths.join(", ")}`);
    } else if (options.keepFixture) {
      console.log("No temporary paths were created.");
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
