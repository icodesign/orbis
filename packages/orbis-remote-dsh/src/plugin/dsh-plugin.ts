import { join, resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent";
import {
  admitEncodedImages,
  isImageAdmissionError,
  type AttachmentStore,
} from "@deepseek-ai/dsh-attachment";
import type { EncodedImageAttachment, ImageAttachmentRef } from "@deepseek-ai/dsh-attachment/types";
import type {} from "@deepseek-ai/dsh-credentials";
import type {} from "@deepseek-ai/dsh-file-reference";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type {} from "@deepseek-ai/dsh-host-apiproxy";
import type { DirectoryPickerBrowseCapability } from "@deepseek-ai/dsh-host-directory-picker";
import type {} from "@deepseek-ai/dsh-host-webserver";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";
import type {} from "@deepseek-ai/dsh-plan-mode";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-session-projection-cache";
import type {} from "@deepseek-ai/dsh-session-query";
import type {} from "@deepseek-ai/dsh-session-reference";
import type { SubagentDescendantListEntry, SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-workspace";
import z from "@deepseek-ai/schemastery";
import { AgentBackendError } from "@orbisapp/orbis-agent-backend";

import type {
  DshEncodedImageAttachment,
  DshImageAttachmentReference,
  DshSessionAttachmentPort,
  DshSessionModeProvider,
  DshSessionPermissionProvider,
  DshSessionSubagentProvider,
} from "../adapter";
import { OrbisRemoteDshHost, type OrbisRemoteDshHostDshOptions } from "../host";
import { ORBIS_DSH_DRIVER_VERSION } from "./constants";
import { createDshPromptReferenceProvider } from "./dsh-prompt-reference-provider";
import { listDshSessionCatalog, type DshSessionProjectionCache } from "./dsh-session-catalog";
import { OrbisDshFileLogger } from "./file-logger";
import { OrbisDshHostService, type OrbisDshCredentials } from "./host-service";
import { createOrbisHttpRoute } from "./http-api";
import { OrbisDshStateStore } from "./state-store";
import { createDshWorkspaceFolderProvider } from "./workspace-folder-provider";

export const name = "orbis-dsh-remote";
export const inject = [
  "agents",
  "subagents",
  "attachments",
  "fileReferences",
  "apiProxy",
  "credentials",
  "directoryPicker",
  "webServer",
  "sessionPersistence",
  "sessionProjectionCache",
  "sessionReferenceResolver",
  "sessionQuery",
  "sessions",
  "permissionPresets",
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
  readonly content: readonly unknown[];
  readonly source: { readonly kind: "user" };
}) {
  const content = input.content.map((block): ContentBlock => {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      throw new AgentBackendError("protocol", "The DSH user message content is invalid");
    }
    const candidate = block as Record<string, unknown>;
    if (candidate.type === "text" && typeof candidate.text === "string") {
      return { text: candidate.text, type: "text" };
    }
    if (
      candidate.type === "image" &&
      typeof candidate.attachment === "object" &&
      candidate.attachment !== null
    ) {
      return { attachment: candidate.attachment as ImageAttachmentRef, type: "image" };
    }
    throw new AgentBackendError("protocol", "The DSH user message content is invalid");
  });
  return createUserMessage({
    content,
    source: input.source,
  });
}

function dshImageReference(reference: ImageAttachmentRef): DshImageAttachmentReference {
  return {
    attachmentId: String(reference.attachmentId),
    bytes: reference.bytes,
    height: reference.height,
    mediaType: reference.mediaType,
    ...(reference.name === undefined ? {} : { name: reference.name }),
    width: reference.width,
  };
}

export function createDshAttachmentPort(context: Context): DshSessionAttachmentPort | undefined {
  const attachments = (context as Context & { readonly attachments?: AttachmentStore }).attachments;
  if (attachments === undefined) return undefined;
  return {
    async admitEncodedImages(images: readonly DshEncodedImageAttachment[]) {
      try {
        const refs = await admitEncodedImages(
          attachments,
          images.map(
            (image): EncodedImageAttachment => ({
              data: image.data,
              mediaType: image.mediaType as EncodedImageAttachment["mediaType"],
              ...(image.name === undefined ? {} : { name: image.name }),
            }),
          ),
        );
        return refs.map(dshImageReference);
      } catch (error) {
        if (isImageAdmissionError(error)) {
          throw new AgentBackendError("invalid_argument", "The image attachment was rejected");
        }
        throw error;
      }
    },
    async readImage(reference, signal) {
      const stored = await attachments.readImage(reference as ImageAttachmentRef, signal);
      return { data: stored.data, reference: dshImageReference(stored.ref) };
    },
  };
}

function dshPlanMode(context: Context): Context["planMode"] | undefined {
  return context.get("planMode");
}

function createOrbisDshContext(context: Context): OrbisRemoteDshHostDshOptions["context"] {
  const planMode = dshPlanMode(context);
  return {
    ...(context.apiProxy === undefined ? {} : { apiProxy: context.apiProxy }),
    agents: context.agents,
    ...(planMode === undefined ? {} : { planMode }),
    on: context.on.bind(context),
    sessionPersistence: context.sessionPersistence,
    // The generic Orbis backend keeps its own narrow DSH port named
    // `workspace`; the current Harness service is exposed as `workspaceRegistry`.
    workspace: context.workspaceRegistry,
  } as unknown as OrbisRemoteDshHostDshOptions["context"];
}

interface PermissionPresetContext {
  readonly permissionPresets?: {
    readonly names: readonly string[];
    current(events: readonly unknown[]): string;
    optionOf(name: string): {
      readonly description?: string;
      readonly name: string;
      readonly value: string;
    };
    set(session: { readonly events: readonly unknown[] }, name: string): void;
  };
  readonly sessions?: {
    get(id: unknown): { readonly events: readonly unknown[] } | undefined;
  };
}

function createDshPermissionProvider(context: Context): DshSessionPermissionProvider {
  const services = context as unknown as PermissionPresetContext;
  return {
    describe(nativeSessionId, events) {
      const permissionPresets = services.permissionPresets;
      if (permissionPresets === undefined) return undefined;
      const session = services.sessions?.get(SessionId(nativeSessionId));
      const sessionEvents = events ?? session?.events;
      if (sessionEvents === undefined) return undefined;
      const currentValue = permissionPresets.current(sessionEvents);
      const options = [
        ...permissionPresets.names.map((name) => permissionPresets.optionOf(name)),
        ...(permissionPresets.names.includes(currentValue)
          ? []
          : [permissionPresets.optionOf(currentValue)]),
      ];
      return {
        currentValue,
        id: "permissions",
        name: "Permissions",
        options,
      };
    },
    set(nativeSessionId, value) {
      const permissionPresets = services.permissionPresets;
      const session = services.sessions?.get(SessionId(nativeSessionId));
      if (permissionPresets === undefined || session === undefined) {
        throw new Error(`DSH session "${nativeSessionId}" is unavailable for permission update`);
      }
      permissionPresets.set(session, value);
    },
  };
}

export function createDshPlanModeProvider(context: Context): DshSessionModeProvider | undefined {
  const planMode = dshPlanMode(context);
  if (planMode === undefined) return undefined;
  return {
    get(agent) {
      return planMode.get(agent as unknown as Agent);
    },
    set(agent, active) {
      return planMode.set(agent as unknown as Agent, active);
    },
  };
}

/**
 * Keeps the official DSH descendant listing authoritative. The adapter owns
 * native-id to canonical-ref mapping; this composition seam only supplies the
 * exact DSH rows and caller cancellation signal without parsing or reordering.
 */
export function createDshSessionSubagentProvider(
  context: Context,
): DshSessionSubagentProvider | undefined {
  const subagents = (context as Context & { readonly subagents?: SubagentRuntime }).subagents;
  if (subagents === undefined) return undefined;
  return {
    listDescendants(nativeSessionId, signal): Promise<readonly SubagentDescendantListEntry[]> {
      return subagents.listDescendants(SessionId(nativeSessionId), signal);
    },
  };
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
            permissionPresets: createDshPermissionProvider(context),
            planMode: createDshPlanModeProvider(context),
            attachments: createDshAttachmentPort(context),
            promptReferences: createDshPromptReferenceProvider(context),
            subagents: createDshSessionSubagentProvider(context),
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
