import { join, resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-credentials";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type {} from "@deepseek-ai/dsh-host-apiproxy";
import type { DirectoryPickerBrowseCapability } from "@deepseek-ai/dsh-host-directory-picker";
import type {} from "@deepseek-ai/dsh-host-webserver";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-session-projection-cache";
import type {} from "@deepseek-ai/dsh-workspace";
import z from "@deepseek-ai/schemastery";
import {
  OrbisRemoteDshHost,
  type OrbisRemoteDshHostDshOptions,
} from "../host";

import { listDshSessionCatalog, type DshSessionProjectionCache } from "./dsh-session-catalog";
import { OrbisDshFileLogger } from "./file-logger";
import { OrbisDshHostService, type OrbisDshCredentials } from "./host-service";
import { createOrbisHttpRoute } from "./http-api";
import { ORBIS_DSH_DRIVER_VERSION } from "./constants";
import { OrbisDshStateStore } from "./state-store";
import { createDshWorkspaceFolderProvider } from "./workspace-folder-provider";

export const name = "orbis-dsh-remote";
export const inject = [
  "agents",
  "apiProxy",
  "credentials",
  "directoryPicker",
  "webServer",
  "sessionPersistence",
  "sessionProjectionCache",
  "workspaceRegistry",
] as const;

export interface Config {
  /** Optional override for the public device and host transport state file. */
  statePath?: string;
  /** Optional override for the host-owned v2 cursor/index state file. */
  agentStatePath?: string;
  /** Optional override for the owner-only JSONL server diagnostics file. */
  logPath?: string;
  /** Server directories exposed to paired clients. Defaults to the directory picker's Home. */
  workspaceRoots?: string[];
}

export const Config: z<Config> = z.object({
  // Schemastery object fields are nullable/omittable by default. The DSH
  // profile's Schemastery implementation intentionally has no `.optional()`
  // builder (unlike zod), so keep optionality in the object shape itself.
  agentStatePath: z.string(),
  logPath: z.string(),
  statePath: z.string(),
  workspaceRoots: z.array(z.string()),
});

function createDshUserMessage(input: {
  readonly content: readonly [{ readonly text: string; readonly type: "text" }];
  readonly source: { readonly kind: "user" };
}) {
  return createUserMessage({
    content: [...input.content],
    source: input.source,
  });
}

function createOrbisDshContext(context: Context): OrbisRemoteDshHostDshOptions["context"] {
  return {
    ...(context.apiProxy === undefined ? {} : { apiProxy: context.apiProxy }),
    agents: context.agents,
    on: context.on.bind(context),
    sessionPersistence: context.sessionPersistence,
    // The generic Orbis backend keeps its own narrow DSH port named
    // `workspace`; the current Harness service is exposed as `workspaceRegistry`.
    workspace: context.workspaceRegistry,
  } as unknown as OrbisRemoteDshHostDshOptions["context"];
}

/**
 * Mount the DSH remote harness adapter plus the loopback-only Orbis device
 * management route. The plugin deliberately refuses a LAN-bound DSH web
 * process: a pairing invitation contains a one-time secret and must never be
 * exposed through an unauthenticated web origin.
 */
export async function apply(context: Context, config?: Config): Promise<void> {
  if (context.webServer.host !== "127.0.0.1") {
    throw new Error(
      "orbis-dsh-remote requires dsh web to bind 127.0.0.1 because pairing controls are loopback-only",
    );
  }
  const statePath = resolve(
    config?.statePath ?? join(resolveDshHome(), "orbis", "dsh-remote-host.v2.json"),
  );
  const agentStatePath = resolve(
    config?.agentStatePath ?? join(resolveDshHome(), "orbis", "dsh-remote-agent.v2.json"),
  );
  const logPath = resolve(
    config?.logPath ?? join(resolveDshHome(), "orbis", "dsh-remote-debug.jsonl"),
  );
  const directoryPicker = context.directoryPicker.capability();
  if (directoryPicker.kind !== "browse") {
    throw new Error("orbis-dsh-remote requires a browse directoryPicker capability");
  }
  const workspaceProvider = await createDshWorkspaceFolderProvider({
    browser: directoryPicker as DirectoryPickerBrowseCapability,
    ...(config?.workspaceRoots?.length ? { roots: config.workspaceRoots } : {}),
    workspace: context.workspaceRegistry,
  });
  const dshContext = createOrbisDshContext(context);
  const service = new OrbisDshHostService(
    new OrbisDshStateStore(statePath),
    context.credentials as unknown as OrbisDshCredentials,
    {
      create: ({ hostId, hostKeyId }) =>
        new OrbisRemoteDshHost({
          dsh: {
            context: dshContext,
            createUserMessage: createDshUserMessage,
            driver: { version: ORBIS_DSH_DRIVER_VERSION },
            listSessionCatalog: () =>
              listDshSessionCatalog(
                dshContext.sessionPersistence,
                context.sessionProjectionCache as DshSessionProjectionCache,
              ),
            toSessionId: SessionId,
          },
          hostId,
          hostKeyId,
          workspaceProvider,
          state: {
            path: agentStatePath,
          },
        }),
    },
    undefined,
    undefined,
    new OrbisDshFileLogger(logPath),
  );
  await service.start();

  context.effect(async () => {
    const disposeRoute = context.webServer.register(createOrbisHttpRoute(service));
    void service.connectIfConfigured().catch(() => undefined);
    return async () => {
      disposeRoute();
      await service.dispose();
    };
  }, "orbis-dsh-remote: host lifecycle");
}
