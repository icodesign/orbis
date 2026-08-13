import { jsonValueSchema } from "@orbis/transport";
import { z } from "zod";

const nonEmptyString = z.string().min(1);
const safeInteger = z.number().int().refine(Number.isSafeInteger);
const nonNegativeInteger = safeInteger.min(0);
const positiveInteger = safeInteger.min(1);
const timestamp = nonEmptyString;
const jsonObject = z.record(z.string(), jsonValueSchema);

export const v2RefSchema = z
  .object({
    backendId: nonEmptyString,
    driverId: nonEmptyString,
    nativeSessionId: nonEmptyString,
    sessionId: nonEmptyString,
  })
  .passthrough();

export const v2ModelSchema = z
  .object({
    modelId: nonEmptyString,
    provider: nonEmptyString,
    thinkingLevel: nonEmptyString.optional(),
  })
  .passthrough();

export const v2ModelMetadataSchema = v2ModelSchema
  .extend({
    contextWindow: positiveInteger.optional(),
    defaultThinkingLevel: nonEmptyString.optional(),
    description: z.string().optional(),
    displayName: nonEmptyString,
    providerDisplayName: nonEmptyString.optional(),
    thinkingLevels: z
      .array(
        z
          .object({
            description: z.string().optional(),
            displayName: nonEmptyString,
            id: nonEmptyString,
          })
          .passthrough(),
      )
      .min(1)
      .optional(),
  })
  .passthrough();

export const v2WorkspaceSchema = z
  .object({ displayName: nonEmptyString, ref: nonEmptyString })
  .passthrough();

export const v2WorkspaceFolderSchema = z
  .object({
    displayName: nonEmptyString,
    hidden: z.boolean(),
    ref: nonEmptyString,
    selectable: z.boolean(),
  })
  .passthrough();

export const v2ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ text: z.string(), type: z.literal("text") }).passthrough(),
  z
    .object({ data: nonEmptyString, mimeType: nonEmptyString, type: z.literal("image") })
    .passthrough(),
  z
    .object({ redacted: z.boolean().optional(), text: z.string(), type: z.literal("thinking") })
    .passthrough(),
  z
    .object({
      callId: nonEmptyString,
      input: jsonValueSchema.optional(),
      name: nonEmptyString,
      type: z.literal("tool_call"),
    })
    .passthrough(),
  z
    .object({ name: nonEmptyString, type: z.literal("resource"), uri: nonEmptyString })
    .passthrough(),
]);

export const v2UsageSchema = z
  .object({
    cacheReadTokens: nonNegativeInteger.optional(),
    cacheWriteTokens: nonNegativeInteger.optional(),
    costUsd: z.number().min(0).refine(Number.isFinite).optional(),
    inputTokens: nonNegativeInteger,
    outputTokens: nonNegativeInteger,
  })
  .passthrough();

export const v2RunSummarySchema = z
  .object({
    error: z.object({ code: nonEmptyString, message: nonEmptyString }).passthrough().optional(),
    finishedAt: timestamp.optional(),
    outcome: z.enum(["completed", "cancelled", "failed"]).optional(),
    runId: nonEmptyString,
    startedAt: timestamp,
  })
  .passthrough();

export const v2EntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      _meta: jsonValueSchema.optional(),
      content: z.array(v2ContentBlockSchema),
      createdAt: timestamp,
      cursor: nonNegativeInteger,
      errorMessage: nonEmptyString.optional(),
      id: nonEmptyString,
      kind: z.literal("message"),
      model: v2ModelSchema.optional(),
      parentId: nonEmptyString.nullable(),
      role: z.enum(["user", "assistant", "system"]),
      stopReason: z.enum(["stop", "length", "tool_use", "aborted", "error"]).optional(),
      usage: v2UsageSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      _meta: jsonValueSchema.optional(),
      callId: nonEmptyString,
      content: z.array(v2ContentBlockSchema).optional(),
      createdAt: timestamp,
      cursor: nonNegativeInteger,
      id: nonEmptyString,
      input: jsonValueSchema.optional(),
      kind: z.literal("tool"),
      name: nonEmptyString,
      output: jsonValueSchema.optional(),
      parentId: nonEmptyString.nullable(),
      status: z.enum(["success", "error", "cancelled"]),
    })
    .passthrough(),
  z
    .object({
      _meta: jsonValueSchema.optional(),
      code: nonEmptyString,
      createdAt: timestamp,
      cursor: nonNegativeInteger,
      id: nonEmptyString,
      kind: z.literal("notice"),
      level: z.enum(["info", "warn", "error"]),
      message: nonEmptyString,
      parentId: nonEmptyString.nullable(),
    })
    .passthrough(),
  z
    .object({
      _meta: jsonValueSchema.optional(),
      content: z.array(v2ContentBlockSchema),
      createdAt: timestamp,
      cursor: nonNegativeInteger,
      id: nonEmptyString,
      kind: z.literal("context"),
      label: nonEmptyString.optional(),
      origin: z.enum(["inject", "recall"]),
      parentId: nonEmptyString.nullable(),
    })
    .passthrough(),
]);

export const v2QueuedInputSchema = z
  .object({
    content: z.array(v2ContentBlockSchema),
    id: nonEmptyString,
    kind: z.enum(["steer", "follow_up", "next_run"]),
    queuedAt: timestamp,
  })
  .passthrough();

export const v2PermissionSchema = z
  .object({
    callId: nonEmptyString.optional(),
    defaultOptionId: nonEmptyString,
    detail: z.string().optional(),
    expiresAt: timestamp,
    options: z.array(
      z
        .object({
          kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
          label: nonEmptyString,
          optionId: nonEmptyString,
        })
        .passthrough(),
    ),
    requestId: nonEmptyString,
    requestedAt: timestamp,
    title: nonEmptyString,
  })
  .passthrough();

export const v2StateSchema = z
  .object({
    activeRun: v2RunSummarySchema.nullable().optional(),
    configOptions: jsonObject,
    createdAt: timestamp,
    cwd: z.string().nullable(),
    lastRun: v2RunSummarySchema.nullable().optional(),
    leafEntryId: nonEmptyString.nullable(),
    mode: z.string().nullable(),
    model: v2ModelSchema.nullable(),
    pendingInputs: z.array(v2QueuedInputSchema),
    pendingPermissions: z.array(v2PermissionSchema),
    ref: v2RefSchema,
    revision: nonNegativeInteger,
    runState: z.enum(["idle", "running", "suspended", "error"]),
    title: z.string().nullable(),
    updatedAt: timestamp,
    usageTotal: v2UsageSchema.nullable().optional(),
    workspaceRef: z.string().nullable(),
  })
  .passthrough();

export const v2StatePatchSchema = z
  .object({
    activeRun: v2RunSummarySchema.nullable().optional(),
    configOptions: jsonObject.optional(),
    cwd: z.string().nullable().optional(),
    lastRun: v2RunSummarySchema.nullable().optional(),
    leafEntryId: nonEmptyString.nullable().optional(),
    mode: z.string().nullable().optional(),
    model: v2ModelSchema.nullable().optional(),
    pendingInputs: z.array(v2QueuedInputSchema).optional(),
    pendingPermissions: z.array(v2PermissionSchema).optional(),
    runState: z.enum(["idle", "running", "suspended", "error"]).optional(),
    title: z.string().nullable().optional(),
    updatedAt: timestamp.optional(),
    usageTotal: v2UsageSchema.nullable().optional(),
    workspaceRef: z.string().nullable().optional(),
  })
  .passthrough();

export const v2OverlaySchema = z
  .object({
    runId: nonEmptyString,
    runningTools: z.array(
      z
        .object({
          callId: nonEmptyString,
          chunkSeq: positiveInteger,
          content: z.array(v2ContentBlockSchema).optional(),
          entryId: nonEmptyString,
          input: jsonValueSchema.optional(),
          name: nonEmptyString,
          status: z.enum(["pending", "running"]),
        })
        .passthrough(),
    ),
    streaming: z
      .object({
        chunkSeq: positiveInteger,
        content: z.array(v2ContentBlockSchema),
        entryId: nonEmptyString,
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const v2SessionSummarySchema = z
  .object({
    driverId: nonEmptyString,
    ref: v2RefSchema,
    runState: z.enum(["idle", "running", "suspended", "error"]),
    title: z.string().nullable(),
    updatedAt: timestamp,
  })
  .passthrough();

export const v2DriverSchema = z
  .object({
    availability: z
      .object({
        available: z.boolean(),
        reason: z.string().optional(),
      })
      .passthrough()
      .optional(),
    capabilities: z.array(nonEmptyString),
    displayName: nonEmptyString,
    id: nonEmptyString,
    version: nonEmptyString.optional(),
  })
  .passthrough();

export const v2DeviceSchema = z
  .object({ name: nonEmptyString.optional(), platform: nonEmptyString.optional() })
  .passthrough();

export const v2LimitsSchema = z
  .object({
    maxPromptBytes: positiveInteger,
    maxReplayBatch: positiveInteger,
    maxSnapshotWindow: positiveInteger,
  })
  .passthrough();

export const v2HelloResultSchema = z
  .object({
    capabilities: z
      .object({
        attachments: z.union([
          z.literal(false),
          z.object({ maxBytes: positiveInteger, mimeTypes: z.array(nonEmptyString) }).passthrough(),
        ]),
        dispose: z.boolean(),
        fork: z.boolean(),
        permission: z.boolean(),
        presence: z.boolean(),
      })
      .passthrough(),
    drivers: z.array(v2DriverSchema),
    hostId: nonEmptyString,
    hostRevision: nonEmptyString,
    limits: v2LimitsSchema,
    version: z.literal(2),
  })
  .passthrough();

export const v2HelloInputSchema = z
  .object({ supportedVersions: z.array(positiveInteger), device: v2DeviceSchema })
  .passthrough();

export const v2ListInputSchema = z
  .object({
    cursor: nonEmptyString.optional(),
    driverId: nonEmptyString.optional(),
    limit: positiveInteger.max(1_000).optional(),
  })
  .passthrough();

export const v2ModelsListInputSchema = z
  .object({ driverId: nonEmptyString.optional() })
  .passthrough();

export const v2WorkspacesListInputSchema = z.object({ driverId: nonEmptyString }).passthrough();

export const v2WorkspacesBrowseInputSchema = z
  .object({ driverId: nonEmptyString, folderRef: nonEmptyString.optional() })
  .passthrough();

export const v2WorkspacesRegisterInputSchema = z
  .object({
    driverId: nonEmptyString,
    folderRef: nonEmptyString,
    idempotencyKey: nonEmptyString,
  })
  .passthrough();

export const v2SyncInputSchema = z
  .object({
    afterCursor: nonNegativeInteger.optional(),
    afterEntryId: nonEmptyString.nullable().optional(),
    limit: positiveInteger.max(1_000).optional(),
    mode: z.enum(["once", "live"]),
    ref: v2RefSchema,
  })
  .passthrough()
  .superRefine((value, context) => {
    if ((value.afterCursor === undefined) !== (value.afterEntryId === undefined)) {
      context.addIssue({
        code: "custom",
        message: "afterCursor and afterEntryId are required together",
      });
    }
    if (value.afterCursor === 0 && value.afterEntryId !== null) {
      context.addIssue({
        code: "custom",
        message: "afterEntryId must be null when afterCursor is zero",
      });
    }
    if (
      value.afterCursor !== undefined &&
      value.afterCursor > 0 &&
      typeof value.afterEntryId !== "string"
    ) {
      context.addIssue({
        code: "custom",
        message: "afterEntryId is required for a nonzero afterCursor",
      });
    }
  });

export const v2CreateInputSchema = z
  .object({
    driverId: nonEmptyString,
    idempotencyKey: nonEmptyString,
    mode: z.string().optional(),
    model: v2ModelSchema.optional(),
    nativeSessionId: nonEmptyString.optional(),
    title: z.string().optional(),
    workspaceRef: nonEmptyString.optional(),
  })
  .passthrough();

export const v2PromptInputSchema = z
  .object({
    content: z.array(v2ContentBlockSchema),
    delivery: z.enum(["steer", "follow_up"]).optional(),
    expectedRevision: nonNegativeInteger.optional(),
    idempotencyKey: nonEmptyString,
    ref: v2RefSchema,
  })
  .passthrough();

export const v2CancelInputSchema = z
  .object({
    idempotencyKey: nonEmptyString,
    keepInbox: z.boolean().optional(),
    ref: v2RefSchema,
    runId: nonEmptyString.optional(),
  })
  .passthrough();

export const v2UpdateInputSchema = z
  .object({
    expectedRevision: nonNegativeInteger.optional(),
    idempotencyKey: nonEmptyString,
    patch: z
      .object({
        configOptions: jsonObject.optional(),
        mode: z.string().nullable().optional(),
        model: v2ModelSchema.nullable().optional(),
        title: z.string().nullable().optional(),
      })
      .passthrough(),
    ref: v2RefSchema,
  })
  .passthrough();

export const v2EntriesInputSchema = z
  .object({
    beforeCursor: nonNegativeInteger,
    limit: positiveInteger.max(1_000).optional(),
    ref: v2RefSchema,
  })
  .passthrough();

export const v2PermissionResponseInputSchema = z
  .object({
    idempotencyKey: nonEmptyString,
    optionId: nonEmptyString,
    ref: v2RefSchema,
    requestId: nonEmptyString,
  })
  .passthrough();

export const v2ForkInputSchema = z
  .object({
    fromEntryId: nonEmptyString.optional(),
    idempotencyKey: nonEmptyString,
    ref: v2RefSchema,
    title: z.string().optional(),
  })
  .passthrough();

export const v2DisposeInputSchema = z
  .object({
    deleteHistory: z.boolean().optional(),
    idempotencyKey: nonEmptyString,
    ref: v2RefSchema,
  })
  .passthrough();

export const v2SessionEventSchema = z.union([
  z
    .object({
      channel: z.literal("replayable"),
      cursor: nonNegativeInteger,
      entry: v2EntrySchema,
      eventId: nonEmptyString,
      occurredAt: timestamp,
      sessionId: nonEmptyString,
      source: v2RefSchema.pick({ backendId: true, driverId: true }).extend({
        nativeType: nonEmptyString.optional(),
        version: nonEmptyString.optional(),
      }),
      type: z.literal("entry.appended"),
    })
    .passthrough(),
  z
    .object({
      channel: z.literal("state"),
      eventId: nonEmptyString,
      occurredAt: timestamp,
      patch: v2StatePatchSchema,
      revision: nonNegativeInteger,
      sessionId: nonEmptyString,
      source: v2RefSchema.pick({ backendId: true, driverId: true }).extend({
        nativeType: nonEmptyString.optional(),
        version: nonEmptyString.optional(),
      }),
      type: z.literal("session.state.changed"),
    })
    .passthrough(),
  z
    .object({
      blockIndex: nonNegativeInteger,
      channel: z.literal("transient"),
      chunkSeq: positiveInteger,
      delta: z.string(),
      entryId: nonEmptyString,
      eventId: nonEmptyString,
      occurredAt: timestamp,
      part: z.enum(["text", "thinking", "tool_output"]),
      sessionId: nonEmptyString,
      source: v2RefSchema.pick({ backendId: true, driverId: true }).extend({
        nativeType: nonEmptyString.optional(),
        version: nonEmptyString.optional(),
      }),
      type: z.literal("entry.delta"),
    })
    .passthrough(),
  z
    .object({
      channel: z.literal("transient"),
      detail: z.string().optional(),
      eventId: nonEmptyString,
      kind: z.enum(["thinking", "compaction", "retry", "summarizing"]),
      occurredAt: timestamp,
      runId: nonEmptyString,
      sessionId: nonEmptyString,
      source: v2RefSchema.pick({ backendId: true, driverId: true }).extend({
        nativeType: nonEmptyString.optional(),
        version: nonEmptyString.optional(),
      }),
      type: z.literal("run.activity"),
    })
    .passthrough(),
  z
    .object({
      channel: z.literal("transient"),
      devices: z.array(
        z
          .object({
            deviceId: nonEmptyString,
            name: nonEmptyString.optional(),
            since: timestamp,
            viewing: z.boolean(),
          })
          .passthrough(),
      ),
      eventId: nonEmptyString,
      occurredAt: timestamp,
      sessionId: nonEmptyString,
      source: v2RefSchema.pick({ backendId: true, driverId: true }).extend({
        nativeType: nonEmptyString.optional(),
        version: nonEmptyString.optional(),
      }),
      type: z.literal("presence.changed"),
    })
    .passthrough(),
]);

export const v2HostEventSchema = z.union([
  z
    .object({ session: v2SessionSummarySchema, type: z.literal("host.session.added") })
    .passthrough(),
  z
    .object({ session: v2SessionSummarySchema, type: z.literal("host.session.changed") })
    .passthrough(),
  z
    .object({
      reason: z.enum(["disposed", "gone"]),
      sessionId: nonEmptyString,
      type: z.literal("host.session.removed"),
    })
    .passthrough(),
  z
    .object({ drivers: z.array(v2DriverSchema), type: z.literal("host.drivers.changed") })
    .passthrough(),
  z.object({ revision: nonEmptyString, type: z.literal("host.models.changed") }).passthrough(),
]);

export const v2SyncResultSchema = z.union([
  z
    .object({
      hasMore: z.boolean(),
      hostRevision: nonEmptyString,
      kind: z.literal("replay"),
      overlay: v2OverlaySchema.optional(),
      state: v2StateSchema,
      throughCursor: nonNegativeInteger,
    })
    .passthrough(),
  z
    .object({
      entries: z.array(v2EntrySchema),
      hasOlder: z.boolean(),
      hostRevision: nonEmptyString,
      kind: z.literal("snapshot"),
      oldestCursor: nonNegativeInteger,
      overlay: v2OverlaySchema.optional(),
      state: v2StateSchema,
    })
    .passthrough(),
]);
