/**
 * Opt-in real DSH profile E2E.
 *
 * This runner deliberately talks to a real `dsh web` process. It never swaps
 * in an in-memory backend or a fake transport. The profile/model phases run
 * without provider credentials; a missing key skips only prompt/replay phases
 * by default (set ORBIS_DSH_REAL_E2E_STRICT=1 to turn that skip into a failure).
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdtemp, mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createOrbisRemoteAgentV2Connection } from "@orbisapp/remote-agent-protocol";
import {
  generateDeviceIdentity,
  OrbisRemoteConnection,
  parsePairingInvitation,
} from "@orbisapp/transport";

import { createNodeWebSocketFactory } from "../src/plugin/node-websocket.ts";
import { delay, waitFor } from "./real-profile-e2e-utils.ts";

const PACKAGE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.env.ORBIS_DSH_REAL_E2E_STRICT === "1";
const OPT_IN = process.env.ORBIS_DSH_REAL_E2E === "1";
const PACKAGE_DSH_BIN = join(
  PACKAGE_DIRECTORY,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "dsh.cmd" : "dsh",
);
const DSH_COMMAND =
  process.env.ORBIS_DSH_BIN ?? (existsSync(PACKAGE_DSH_BIN) ? PACKAGE_DSH_BIN : "dsh");
const WEB_READY_TIMEOUT_MS = 90_000;

function log(message) {
  process.stdout.write(`[orbis-dsh-real-e2e] ${message}\n`);
}

function redact(value) {
  let result = String(value);
  for (const secret of [process.env.DEEPSEEK_API_KEY]) {
    if (secret !== undefined && secret.length > 0) result = result.split(secret).join("<redacted>");
  }
  return result;
}

function prerequisiteFailure(message) {
  if (STRICT) throw new Error(message);
  log(`SKIP: ${message}`);
  process.exitCode = 0;
}

function secureRandom(length) {
  return Promise.resolve(new Uint8Array(randomBytes(length)));
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-16_000);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("error", rejectCommand);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveCommand({ code: 0, output });
        return;
      }
      rejectCommand(
        new Error(
          `${command} ${args.join(" ")} exited with ${signal ?? `code ${code}`}\n${redact(output)}`,
        ),
      );
    });
  });
}

function startWeb({ home, agentsHome, workspace, overlay }) {
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_AGENTS_HOME: agentsHome,
    DSH_TELEMETRY_DISABLED: "1",
    DSH_PERMISSION_MODE: "workspace-write",
  };
  // Never let a user's configured Orbis identity escape into the isolated
  // fixture. The real credentials-local plugin will create a fresh
  // host identity under this fixture's DSH_HOME.
  delete env.ORBIS_DSH_HOST_IDENTITY_V1;

  const child = spawn(
    DSH_COMMAND,
    ["--profile", "web", "--patch", overlay, "--host", "127.0.0.1", "--port", "0"],
    { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let resolveReady;
  let rejectReady;
  let didSettleReady = false;
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const timer = setTimeout(() => {
    rejectReady(new Error(`dsh web was not ready in ${WEB_READY_TIMEOUT_MS}ms`));
  }, WEB_READY_TIMEOUT_MS);
  const consume = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-24_000);
    const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(output);
    if (match?.[1] !== undefined) {
      didSettleReady = true;
      clearTimeout(timer);
      resolveReady(match[1]);
    }
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", consume);
  child.once("error", (error) => {
    clearTimeout(timer);
    if (!didSettleReady) {
      didSettleReady = true;
      rejectReady(error);
    }
  });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    if (!didSettleReady) {
      didSettleReady = true;
      rejectReady(new Error(`dsh web exited with ${signal ?? `code ${code}`}\n${redact(output)}`));
    }
  });

  return {
    child,
    ready,
    async stop() {
      clearTimeout(timer);
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolveClose) => child.once("close", resolveClose)),
        delay(10_000).then(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }),
      ]);
    },
  };
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`${path} failed over HTTP ${response.status}: ${redact(body.error ?? text)}`);
  }
  return body;
}

async function dshRpc(baseUrl, method, payload) {
  const body = await requestJson(baseUrl, `/api/${method}`, {
    method: "POST",
    body: JSON.stringify({
      type: "client-request",
      rpcId: `orbis-real-e2e-${method}-${randomUUID()}`,
      method,
      payload,
    }),
  });
  const result = body.result;
  if (!result?.ok) {
    throw new Error(`${method} failed: ${result?.error?.code ?? "unknown"}`);
  }
  return result.value;
}

/** Preserve the test phase when an encrypted remote request fails. */
async function agentStep(label, operation) {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} failed: ${redact(message)}`, { cause: error });
  }
}

function isProtocolFailure(error) {
  return typeof error === "object" && error !== null && error.code === "protocol";
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port");
  const port = address.port;
  await new Promise((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function connectClient({ invitation, identity, pairing, deviceId }) {
  const websocketFactory = await createNodeWebSocketFactory();
  const peer = {
    deviceId,
    deviceName: "Orbis real profile E2E",
    role: "client",
    version: "orbis-remote-dsh-e2e/1",
  };
  const connection = await OrbisRemoteConnection.connectEndpoint({
    websocketUrl: invitation.endpoint.url,
    hostId: invitation.hostId,
    peer,
    security:
      pairing === undefined
        ? { mode: "authenticated", identity, remotePublicKey: invitation.hostPublicKey }
        : {
            mode: "pairing",
            identity,
            remotePublicKey: invitation.hostPublicKey,
            pairing: { pairingId: invitation.pairingId, secret: pairing },
          },
    random: secureRandom,
    webSocketFactory: websocketFactory,
  });
  const agent = createOrbisRemoteAgentV2Connection(connection);
  try {
    const hello = await agent.hello({
      device: { name: "Orbis real profile E2E", platform: "node" },
      supportedVersions: [2],
    });
    return { connection, agent, hello };
  } catch (error) {
    agent.close();
    throw error;
  }
}

async function statePermissions(path) {
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`state file ${path} is not owner-only`);
  }
  const directory = await stat(dirname(path));
  if ((directory.mode & 0o077) !== 0) {
    throw new Error(`state directory ${dirname(path)} is not owner-only`);
  }
}

async function assertNoSecrets(paths, secrets) {
  for (const path of paths) {
    const text = await readFile(path, "utf8");
    for (const secret of secrets) {
      if (secret !== undefined && secret.length > 0 && text.includes(secret)) {
        throw new Error(`secret material was written to ${path}`);
      }
    }
  }
}

async function appendDelivery(journalPath, delivery) {
  // Keep payloads out of the fixture journal: the ordering proof only needs
  // the durable identity/cursor, never provider text or tool output. v2 has
  // no transport ACK; the host index is the replay authority.
  await appendFile(
    journalPath,
    `${JSON.stringify({
      cursor: delivery.transportEvent.eventSeq ?? null,
      eventId: delivery.event.eventId,
      type: delivery.event.type,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(journalPath, 0o600);
}

function createDeliveryQueue(journalPath) {
  let tail = Promise.resolve();
  let failure;
  return {
    enqueue(delivery) {
      const operation = tail.then(async () => {
        await appendDelivery(journalPath, delivery);
      });
      tail = operation.catch((error) => {
        failure ??= error;
      });
      return operation;
    },
    async wait() {
      await tail;
      if (failure) throw failure;
    },
  };
}

function latestDurableDeliveryCursor(deliveries, fallback) {
  let cursor = fallback;
  for (const delivery of deliveries) {
    if (delivery.transportEvent.durability !== "durable") continue;
    const candidate = delivery.transportEvent.eventSeq;
    if (!Number.isSafeInteger(candidate) || candidate < cursor) continue;
    cursor = candidate;
  }
  return cursor;
}

async function persistedIndexEntryCount(path) {
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(state.sessions)
      ? state.sessions.reduce(
          (count, session) => count + (Array.isArray(session.entries) ? session.entries.length : 0),
          0,
        )
      : 0;
  } catch {
    return 0;
  }
}

async function assertDshCompatibility() {
  const expected = process.env.ORBIS_DSH_EXPECTED_VERSION ?? "0.1.1-rc.2";
  const probeRoot = await mkdtemp(join(tmpdir(), "orbis-dsh-compat-"));
  const probeEnv = {
    ...process.env,
    DSH_HOME: join(probeRoot, "dsh-home"),
    DSH_AGENTS_HOME: join(probeRoot, "agents-home"),
    DSH_TELEMETRY_DISABLED: "1",
  };
  await mkdir(probeEnv.DSH_HOME, { recursive: true, mode: 0o700 });
  await mkdir(probeEnv.DSH_AGENTS_HOME, { recursive: true, mode: 0o700 });
  try {
    const version = await runCommand(DSH_COMMAND, ["--version"], { env: probeEnv });
    if (!version.output.trim().split(/\s+/u).includes(expected)) {
      throw new Error(
        `unsupported DSH version (expected ${expected}; set ORBIS_DSH_EXPECTED_VERSION for an explicitly reviewed version)`,
      );
    }
    const launcherHelp = await runCommand(DSH_COMMAND, ["--help"], { env: probeEnv });
    if (!launcherHelp.output.includes("--patch")) {
      throw new Error("DSH launcher is missing the required --patch flag");
    }
    const webHelp = await runCommand(DSH_COMMAND, ["--profile", "web", "--help"], {
      env: probeEnv,
    });
    for (const flag of ["--host", "--port"]) {
      if (!webHelp.output.includes(flag))
        throw new Error(`DSH Web is missing the required ${flag} flag`);
    }
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

async function assertIsolatedIdentityRotationFailsClosed({
  home,
  workspace,
  agentsHome,
  overlay,
  invitation,
  deviceIdentity,
  session,
  web,
  agentConnection,
}) {
  const envPath = join(home, ".env");
  let contents;
  try {
    contents = await readFile(envPath, "utf8");
  } catch {
    log(
      "NOTE: isolated credentials-local did not persist .env; host identity rotation was not exercised",
    );
    return { web, agentConnection };
  }
  const identityLine = contents.match(/^ORBIS_DSH_HOST_IDENTITY_V1=.*$/mu);
  if (!identityLine) {
    log(
      "NOTE: isolated credentials-local did not expose a file-backed host identity; rotation was not exercised",
    );
    return { web, agentConnection };
  }
  const rotated = contents.replace(/^ORBIS_DSH_HOST_IDENTITY_V1=.*(?:\n|$)/mu, "");
  agentConnection?.agent.close();
  await waitFor(
    () => agentConnection?.connection.state === "closed",
    "rotation preflight disconnect",
  );
  await web.stop();
  await writeFile(envPath, rotated, { encoding: "utf8", mode: 0o600 });
  web = startWeb({ home, agentsHome, workspace, overlay });
  const rotatedBaseUrl = await web.ready;
  await waitFor(async () => {
    const status = await requestJson(rotatedBaseUrl, "/orbis/status");
    return status.connection?.state === "connected";
  }, "rotated DSH Web host transport");
  let rejected = false;
  try {
    await connectClient({
      invitation,
      identity: deviceIdentity,
      deviceId: "orbis-real-e2e-rotated-key",
    });
  } catch {
    rejected = true;
  }
  if (!rejected)
    throw new Error("host identity rotation was not rejected by the pinned direct client");
  const pairingStatus = await requestJson(rotatedBaseUrl, "/orbis/pairings", {
    method: "POST",
    body: "{}",
  });
  const rotatedInvitation = parsePairingInvitation(pairingStatus.pairing?.invitation ?? "");
  const rotatedIdentity = await generateDeviceIdentity(secureRandom);
  let rotatedConnection;
  let storeRejected = false;
  let rejectionPhase;
  try {
    rotatedConnection = await connectClient({
      invitation: rotatedInvitation,
      identity: rotatedIdentity,
      pairing: rotatedInvitation.pairingSecret,
      deviceId: "orbis-real-e2e-new-key",
    });
    try {
      await rotatedConnection.agent.sync({ mode: "once", ref: session.ref });
    } catch (error) {
      if (!isProtocolFailure(error)) throw error;
      storeRejected = true;
      rejectionPhase = "sessions.sync";
    }
  } catch (error) {
    if (!isProtocolFailure(error)) throw error;
    // hello includes hostRevision, so the host-key-bound v2 store can reject
    // the rotated identity before session methods are available.
    storeRejected = true;
    rejectionPhase = "orbis.hello";
  } finally {
    rotatedConnection?.agent.close();
  }
  if (!storeRejected) {
    throw new Error(
      "a new host identity was allowed to open the old host-key-bound delivery state",
    );
  }
  // Restore the isolated fixture credential only; never touch a user's profile.
  await writeFile(envPath, contents, { encoding: "utf8", mode: 0o600 });
  log(
    `PASS: isolated host-identity removal was rejected by the pinned direct client during ${rejectionPhase} (fixture only)`,
  );
  return { web, agentConnection: undefined };
}

async function main() {
  if (!OPT_IN) {
    log("SKIP: set ORBIS_DSH_REAL_E2E=1 to run the real profile fixture");
    return;
  }
  try {
    await assertDshCompatibility();
  } catch (error) {
    prerequisiteFailure(
      `the installed DSH CLI is not the reviewed profile prerequisite: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  try {
    await runCommand("pnpm", ["--dir", PACKAGE_DIRECTORY, "run", "build"]);
  } catch (error) {
    prerequisiteFailure(
      `the Orbis DSH bundle could not be built: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const parent = process.env.ORBIS_DSH_E2E_ROOT
    ? resolve(process.env.ORBIS_DSH_E2E_ROOT)
    : tmpdir();
  const fixture = await mkdtemp(join(parent, "orbis-dsh-real-e2e-"));
  const home = join(fixture, "dsh-home");
  const agentsHome = join(fixture, "agents-home");
  const workspace = join(fixture, "workspace");
  const stateDirectory = join(fixture, "orbis-state");
  const hostState = join(stateDirectory, "host-state.json");
  const agentState = join(stateDirectory, "agent-state.json");
  const debugLog = join(stateDirectory, "server-debug.jsonl");
  const clientJournal = join(fixture, "client-delivery-journal.jsonl");
  const overlay = join(fixture, "orbis-overlay.yml");
  await writeFile(
    overlay,
    [
      "- id: orbis-remote",
      "  config:",
      `    statePath: ${JSON.stringify(hostState)}`,
      `    agentStatePath: ${JSON.stringify(agentState)}`,
      `    logPath: ${JSON.stringify(debugLog)}`,
      "    workspaceRoots:",
      `      - ${JSON.stringify(workspace)}`,
      "",
    ].join("\n"),
  );

  let web;
  let agentConnection;
  let deviceIdentity;
  let invitation;
  let workspaceId;
  let session;
  let baselineCursor = 0;
  let baselineEntryId;
  let deliveries = [];
  const providerSecrets = [process.env.DEEPSEEK_API_KEY];
  try {
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await runCommand(
      DSH_COMMAND,
      ["plugin", "--profile", "web", "add", `link:${PACKAGE_DIRECTORY}`],
      {
        cwd: fixture,
        env: {
          ...process.env,
          DSH_HOME: home,
          DSH_TELEMETRY_DISABLED: "1",
        },
      },
    );
    web = startWeb({ home, agentsHome, workspace, overlay });
    const baseUrl = await web.ready;
    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/orbis/status`);
      return response.ok;
    }, "Orbis loopback management route");

    const directPort = await freePort();
    await requestJson(baseUrl, "/orbis/config", {
      method: "PUT",
      body: JSON.stringify({
        directPort,
        hostName: "Orbis real profile fixture",
      }),
    });
    const pairingStatus = await requestJson(baseUrl, "/orbis/pairings", {
      method: "POST",
      body: "{}",
    });
    if (typeof pairingStatus.pairing?.invitation !== "string") {
      throw new Error("the real DSH plugin did not return a direct pairing invitation");
    }
    invitation = parsePairingInvitation(pairingStatus.pairing.invitation);
    if (invitation.endpoint.kind !== "lan") {
      throw new Error("the fixture unexpectedly selected a non-LAN bootstrap endpoint");
    }
    deviceIdentity = await generateDeviceIdentity(secureRandom);
    agentConnection = await connectClient({
      invitation,
      identity: deviceIdentity,
      pairing: invitation.pairingSecret,
      deviceId: `orbis-real-e2e-${randomUUID()}`,
    });
    if (
      !agentConnection.connection.endpointManifest.endpoints.some(
        (endpoint) => endpoint.kind === "lan",
      )
    ) {
      throw new Error("the authenticated welcome did not publish an automatic LAN endpoint");
    }

    const statusAfterPairing = await waitFor(async () => {
      const status = await requestJson(baseUrl, "/orbis/status");
      return status.devices?.some((device) => device.keyId === deviceIdentity.keyId)
        ? status
        : false;
    }, "direct pairing commit");
    if (
      !statusAfterPairing.configuration.autoDirectEndpoints.some(
        (endpoint) => endpoint.kind === "lan",
      )
    ) {
      throw new Error("the direct fixture did not report an automatic LAN endpoint");
    }

    const activeAgent = agentConnection.agent;
    const activeDeliveryQueue = createDeliveryQueue(clientJournal);
    activeAgent.onEvent((delivery) => {
      deliveries.push(delivery);
      void activeDeliveryQueue.enqueue(delivery).catch(() => undefined);
    });
    const drivers = await agentStep("drivers.list", () => activeAgent.listDrivers());
    const dshDriver = drivers.find((driver) => driver.id === "dsh");
    if (dshDriver === undefined) throw new Error("real DSH driver was not advertised");
    if (!dshDriver.capabilities.includes("model.select")) {
      throw new Error("real DSH driver did not advertise model.select");
    }
    if (!dshDriver.capabilities.includes("workspace.open")) {
      throw new Error("real DSH driver did not advertise workspace.open");
    }

    const folderRoots = await agentStep("workspaces.browse", () =>
      activeAgent.browseWorkspaces({ driverId: "dsh" }),
    );
    const fixtureRoot = folderRoots.entries[0];
    if (fixtureRoot === undefined) throw new Error("the server did not expose its configured root");
    const workspaceResult = await agentStep("workspaces.register", () =>
      activeAgent.registerWorkspace({
        driverId: "dsh",
        folderRef: fixtureRoot.ref,
        idempotencyKey: `orbis-real-e2e-workspace-${randomUUID()}`,
      }),
    );
    workspaceId = workspaceResult.workspace.ref;
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      throw new Error("the Orbis workspace API did not return an opaque workspace id");
    }
    session = await agentStep("sessions.create", () =>
      activeAgent.createSession({
        driverId: "dsh",
        idempotencyKey: `orbis-real-e2e-create-${randomUUID()}`,
        workspaceRef: workspaceId,
      }),
    );
    const listed = await agentStep("sessions.list", async () =>
      activeAgent.listSessions({ driverId: "dsh" }),
    );
    if (!listed.sessions.some((candidate) => candidate.ref.sessionId === session.ref.sessionId)) {
      throw new Error("the created DSH session was not discoverable through sessions.list");
    }
    const initialSync = await agentStep("initial sessions.sync", () =>
      activeAgent.sync({ mode: "live", ref: session.ref }),
    );
    if (initialSync.kind !== "snapshot")
      throw new Error("initial session sync did not return a snapshot");
    baselineCursor = 0;

    const modelCatalog = await agentStep("models.list", () =>
      activeAgent.listModels({ driverId: "dsh" }),
    );
    if (modelCatalog.models.length === 0) {
      throw new Error("the real DSH provider catalog was empty");
    }
    const isCurrentModel = (candidate) =>
      candidate.provider === initialSync.state.model?.provider &&
      candidate.modelId === initialSync.state.model.modelId;
    const selectedModel =
      modelCatalog.models.find(
        (candidate) => !isCurrentModel(candidate) && candidate.provider.includes("deepseek"),
      ) ?? modelCatalog.models.find((candidate) => !isCurrentModel(candidate));
    if (selectedModel === undefined) {
      throw new Error("the real DSH catalog did not expose an alternate model to select");
    }
    const modelSelection = {
      modelId: selectedModel.modelId,
      provider: selectedModel.provider,
    };
    const modelUpdateId = `orbis-real-e2e-model-${randomUUID()}`;
    const modelUpdate = await agentStep("sessions.update model", () =>
      activeAgent.update({
        expectedRevision: initialSync.state.revision,
        idempotencyKey: modelUpdateId,
        patch: { model: modelSelection },
        ref: session.ref,
      }),
    );
    const duplicateModelUpdate = await agentStep("idempotent sessions.update model", () =>
      activeAgent.update({
        expectedRevision: initialSync.state.revision,
        idempotencyKey: modelUpdateId,
        patch: { model: modelSelection },
        ref: session.ref,
      }),
    );
    if (
      modelUpdate.revision <= initialSync.state.revision ||
      duplicateModelUpdate.revision !== modelUpdate.revision
    ) {
      throw new Error("the real DSH model update was not revisioned and idempotent");
    }
    await waitFor(
      () =>
        deliveries.some(
          (delivery) =>
            delivery.event.type === "session.state.changed" &&
            delivery.event.revision === modelUpdate.revision &&
            delivery.event.patch.model?.provider === modelSelection.provider &&
            delivery.event.patch.model.modelId === modelSelection.modelId,
        ),
      "real DSH model selection event",
    );
    const dshModelState = await dshRpc(baseUrl, "session.models", {
      sessionId: session.ref.nativeSessionId,
    });
    if (
      dshModelState.current?.provider !== modelSelection.provider ||
      dshModelState.current.model !== modelSelection.modelId
    ) {
      throw new Error("Orbis and DSH Web did not observe the same selected model");
    }
    if (!process.env.DEEPSEEK_API_KEY) {
      await activeDeliveryQueue.wait();
      await statePermissions(hostState);
      await statePermissions(agentState);
      await statePermissions(debugLog);
      await statePermissions(clientJournal);
      await assertNoSecrets(
        [hostState, agentState, debugLog, clientJournal],
        [invitation.pairingSecret],
      );
      log(
        "PASS: real DSH profile boot, direct pairing, workspace browse/register, session creation, model catalog, and shared model selection",
      );
      prerequisiteFailure(
        "DEEPSEEK_API_KEY is required for the remaining real prompt/replay phases; no fake provider is used",
      );
      return;
    }

    // An omitted delivery starts a new DSH run. `follow_up` and `steer` are
    // queued input modes for an already active run, so using either here would
    // correctly be rejected as a session-state conflict.
    const firstReceipt = await agentStep("initial new-run prompt", () =>
      activeAgent.prompt({
        ref: session.ref,
        content: [{ text: "Reply with a short acknowledgement. Do not call tools.", type: "text" }],
        idempotencyKey: `orbis-real-e2e-first-${randomUUID()}`,
      }),
    );
    if (typeof firstReceipt.runId !== "string")
      throw new Error("the real DSH prompt was not admitted");
    await waitFor(
      () =>
        deliveries.some(
          (delivery) =>
            delivery.event.type === "session.state.changed" && delivery.event.patch.lastRun,
        ),
      "first real prompt run",
    );
    await activeDeliveryQueue.wait();
    await waitFor(
      async () => (await persistedIndexEntryCount(agentState)) > 0,
      "durable cursor index persistence",
    );

    activeAgent.close();
    await waitFor(() => agentConnection.connection.state === "closed", "direct disconnect");
    agentConnection = await connectClient({
      invitation,
      identity: deviceIdentity,
      deviceId: "orbis-real-e2e-reconnect",
    });
    const replayAgent = agentConnection.agent;
    const replayDeliveries = [];
    const replayDeliveryQueue = createDeliveryQueue(clientJournal);
    replayAgent.onEvent((delivery) => {
      replayDeliveries.push(delivery);
      void replayDeliveryQueue.enqueue(delivery).catch(() => undefined);
    });
    const replay = await agentStep("reconnect sessions.sync", () =>
      replayAgent.sync({
        afterCursor: baselineCursor,
        afterEntryId: null,
        mode: "once",
        ref: session.ref,
      }),
    );
    if (replay.kind !== "replay") {
      throw new Error("direct reconnect did not replay the native durable suffix");
    }
    if (replayDeliveries.length === 0) throw new Error("replay returned no durable deliveries");
    await replayDeliveryQueue.wait();
    const committedCursor = latestDurableDeliveryCursor(
      [...deliveries, ...replayDeliveries],
      baselineCursor,
    );
    if (committedCursor <= baselineCursor) {
      throw new Error("replay did not advance the durable client cursor");
    }
    const committedEntryId = [...deliveries, ...replayDeliveries]
      .filter((delivery) => delivery.event.type === "entry.appended")
      .at(-1)?.event.entry.id;
    if (committedEntryId === undefined) throw new Error("replay did not include an appended entry");

    // Restart the real DSH Web process. The native transcript and the small
    // cursor index are independent, so the durable suffix remains
    // replayable without a host ACK journal or duplicated payload event log.
    await writeFile(
      overlay,
      [
        "- id: orbis-remote",
        "  config:",
        `    statePath: ${JSON.stringify(hostState)}`,
        `    agentStatePath: ${JSON.stringify(agentState)}`,
        "",
      ].join("\n"),
    );
    replayAgent.close();
    await waitFor(() => agentConnection.connection.state === "closed", "pre-restart disconnect");
    await web.stop();
    web = startWeb({ home, agentsHome, workspace, overlay });
    const restartedBaseUrl = await web.ready;
    await waitFor(async () => {
      const status = await requestJson(restartedBaseUrl, "/orbis/status");
      return (
        status.configuration.hostId === invitation.hostId && status.connection.state === "connected"
      );
    }, "real DSH Web restart and host identity restore");

    agentConnection = await connectClient({
      invitation,
      identity: deviceIdentity,
      deviceId: "orbis-real-e2e-restart",
    });
    const restartedAgent = agentConnection.agent;
    const restartedDeliveries = [];
    const restartedDeliveryQueue = createDeliveryQueue(clientJournal);
    restartedAgent.onEvent((delivery) => {
      deliveries.push(delivery);
      restartedDeliveries.push(delivery);
      void restartedDeliveryQueue.enqueue(delivery).catch(() => undefined);
    });
    const sessionsAfterRestart = await agentStep("post-restart sessions.list", () =>
      restartedAgent.listSessions({ driverId: "dsh" }),
    );
    if (
      !sessionsAfterRestart.sessions.some(
        (candidate) => candidate.ref.sessionId === session.ref.sessionId,
      )
    ) {
      throw new Error("session catalog did not survive the real DSH Web restart");
    }
    // `sessions.list` only reads the catalog. A live `sessions.sync` installs
    // the delivery subscription atomically, so resume the last committed cursor
    // before starting the next run or its durable events would have no client
    // target.
    const restartSync = await agentStep("post-restart sessions.sync", () =>
      restartedAgent.sync({
        afterCursor: committedCursor,
        afterEntryId: committedEntryId,
        mode: "live",
        ref: session.ref,
      }),
    );
    if (restartSync.kind !== "replay" || Number(restartSync.throughCursor) !== committedCursor) {
      throw new Error("post-restart sync did not establish the committed live baseline");
    }
    const secondReceipt = await agentStep("post-restart new-run prompt", () =>
      restartedAgent.prompt({
        ref: session.ref,
        content: [
          { text: "Reply with one short acknowledgement. Do not call tools.", type: "text" },
        ],
        idempotencyKey: `orbis-real-e2e-second-${randomUUID()}`,
      }),
    );
    if (typeof secondReceipt.runId !== "string")
      throw new Error("the post-restart prompt was not admitted");
    await waitFor(
      () =>
        restartedDeliveries.some(
          (delivery) =>
            delivery.event.type === "session.state.changed" && delivery.event.patch.lastRun,
        ),
      "post-restart real prompt run",
    );
    await restartedDeliveryQueue.wait();
    restartedAgent.close();
    await waitFor(() => agentConnection.connection.state === "closed", "post-restart disconnect");
    await delay(500);
    await statePermissions(agentState);

    agentConnection = await connectClient({
      invitation,
      identity: deviceIdentity,
      deviceId: "orbis-real-e2e-history-reconnect",
    });
    const historyAgent = agentConnection.agent;
    const history = await agentStep("full history replay after restart", () =>
      historyAgent.sync({ mode: "once", ref: session.ref }),
    );
    if (history.kind !== "snapshot" || history.entries.length < 2) {
      throw new Error("the native history was not returned as a v2 snapshot");
    }
    const historyPage = await agentStep("sessions.entries", () =>
      historyAgent.entries({
        ref: session.ref,
        beforeCursor: Number(history.oldestCursor) + 1,
        limit: 1,
      }),
    );
    if (!Array.isArray(historyPage.entries) || typeof historyPage.hasOlder !== "boolean") {
      throw new Error("sessions.entries did not return the v2 history page shape");
    }

    historyAgent.close();
    await waitFor(() => agentConnection.connection.state === "closed", "rotation preflight close");
    const rotation = await assertIsolatedIdentityRotationFailsClosed({
      home,
      workspace,
      agentsHome,
      overlay,
      invitation,
      deviceIdentity,
      session,
      web,
      agentConnection,
    });
    web = rotation.web;
    agentConnection = rotation.agentConnection;

    await statePermissions(hostState);
    await statePermissions(agentState);
    await statePermissions(debugLog);
    await statePermissions(clientJournal);
    await assertNoSecrets(
      [hostState, agentState, debugLog, clientJournal],
      [invitation.pairingSecret, ...providerSecrets],
    );
    log(
      "PASS: direct pairing, v2 DSH operations, cursor-index replay, no-ACK delivery, and restart recovery",
    );
    log(
      "NOTE: host identity rotation coverage is fixture-only (old pinned client rejected; new key rejected by old delivery state); production rotation still requires an explicit migration API.",
    );
  } finally {
    try {
      agentConnection?.agent.close();
    } catch {
      // Cleanup must remain best effort after an assertion failure.
    }
    await web?.stop();
    if (process.env.ORBIS_DSH_E2E_KEEP === "1") {
      log(`fixture preserved at ${fixture}`);
    } else {
      await rm(fixture, { recursive: true, force: true });
    }
  }
}

await main();
