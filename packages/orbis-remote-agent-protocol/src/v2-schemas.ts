import { jsonValueSchema } from "@orbisapp/transport";
import { z } from "zod";

const nonEmptyString = z.string().min(1);
const boundedPermissionId = nonEmptyString.max(1024).refine((value) => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return value === value.trim();
});
const boundedPermissionDetail = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    for (const character of value) {
      const code = character.charCodeAt(0);
      if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
        return false;
      }
    }
    return true;
  });
const boundedQuestionText = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => value.trim().length > 0)
  .refine((value) => {
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code === 0x7f || (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
        return false;
      }
    }
    return true;
  });
const boundedQuestionDetail = z
  .string()
  .min(1)
  .max(65_536)
  .refine((value) => value.trim().length > 0)
  .refine((value) => {
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code === 0x7f || (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
        return false;
      }
    }
    return true;
  });
const boundedQuestionSingleLine = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => value.trim().length > 0)
  .refine((value) => {
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code <= 0x1f || code === 0x7f) return false;
    }
    return true;
  });
const safeInteger = z.number().int().refine(Number.isSafeInteger);
const nonNegativeInteger = safeInteger.min(0);
const positiveInteger = safeInteger.min(1);
const timestamp = nonEmptyString;
const jsonObject = z.record(z.string(), jsonValueSchema);
const boundedReferenceText = z
  .string()
  .max(65_536)
  .refine((value) => {
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code === 0x7f || (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
        return false;
      }
    }
    return true;
  });
const boundedReferenceDisplay = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value === value.trim())
  .refine((value) => {
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code <= 0x1f || code === 0x7f) return false;
    }
    return true;
  });

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

const v2SessionConfigOptionChoiceSchema = z
  .object({
    description: z.string().optional(),
    name: nonEmptyString,
    value: nonEmptyString,
  })
  .passthrough();

export const v2SessionConfigOptionSchema = z
  .object({
    currentValue: nonEmptyString,
    description: z.string().optional(),
    id: nonEmptyString,
    name: nonEmptyString,
    options: z.array(v2SessionConfigOptionChoiceSchema).min(1),
  })
  .passthrough();

export const v2ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ text: z.string(), type: z.literal("text") }).passthrough(),
  z
    .object({
      data: nonEmptyString,
      mimeType: nonEmptyString,
      name: nonEmptyString.optional(),
      type: z.literal("image"),
    })
    .passthrough(),
  z
    .object({
      attachmentId: nonEmptyString,
      bytes: positiveInteger.optional(),
      height: positiveInteger.optional(),
      mimeType: nonEmptyString,
      name: nonEmptyString.optional(),
      type: z.literal("image_reference"),
      width: positiveInteger.optional(),
    })
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

/** Prompt transport deliberately accepts only text and completed-upload refs. */
export const v2PromptContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ text: z.string(), type: z.literal("text") }).strict(),
  z
    .object({
      uploadId: nonEmptyString,
      mimeType: nonEmptyString,
      name: nonEmptyString.optional(),
      type: z.literal("image_upload"),
    })
    .strict(),
]);

export const v2StreamingContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ text: z.string(), type: z.literal("text") }).passthrough(),
  z
    .object({ redacted: z.boolean().optional(), text: z.string(), type: z.literal("thinking") })
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

const v2PermissionOptionSchema = z
  .object({
    kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
    label: boundedPermissionId,
    optionId: boundedPermissionId,
  })
  .passthrough();

export const v2PermissionSchema = z
  .object({
    callId: boundedPermissionId.optional(),
    detail: boundedPermissionDetail.optional(),
    options: z.array(v2PermissionOptionSchema).min(2).max(16),
    requestId: boundedPermissionId,
    requestedAt: timestamp,
    title: boundedPermissionId,
  })
  .passthrough()
  .superRefine((value, context) => {
    const optionIds = new Set(value.options.map((option) => option.optionId));
    if (optionIds.size !== value.options.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Permission option ids must be unique",
      });
    }
    if (!value.options.some((option) => option.kind.startsWith("allow_"))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Permission request requires an allow option",
      });
    }
    if (!value.options.some((option) => option.kind.startsWith("reject_"))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Permission request requires a reject option",
      });
    }
  });

const v2QuestionOptionSchema = z
  .object({
    description: boundedQuestionText.optional(),
    label: boundedQuestionSingleLine,
    optionId: boundedPermissionId,
  })
  .passthrough();

const v2QuestionItemSchema = z
  .object({
    detail: boundedQuestionDetail.optional(),
    header: boundedQuestionSingleLine.optional(),
    intent: z
      .object({ kind: z.literal("plan-review"), approveOptionId: boundedPermissionId })
      .passthrough()
      .optional(),
    multiSelect: z.boolean(),
    options: z.array(v2QuestionOptionSchema).max(32),
    question: boundedQuestionText,
    questionId: boundedPermissionId,
  })
  .passthrough()
  .superRefine((value, context) => {
    const optionIds = new Set(value.options.map((option) => option.optionId));
    if (optionIds.size !== value.options.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Question option ids must be unique",
      });
    }
    if (value.intent !== undefined && value.detail === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Plan-review questions require detail",
      });
    }
    if (value.intent !== undefined && !optionIds.has(value.intent.approveOptionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Question approve option id must reference an option",
      });
    }
  });

export const v2QuestionRequestSchema = z
  .object({
    questions: z.array(v2QuestionItemSchema).min(1).max(32),
    requestedAt: timestamp,
    requestId: boundedPermissionId,
  })
  .passthrough()
  .superRefine((value, context) => {
    const questionIds = new Set(value.questions.map((question) => question.questionId));
    if (questionIds.size !== value.questions.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Question ids must be unique" });
    }
  });

const v2QuestionAnswerItemSchema = z
  .object({
    customText: boundedQuestionDetail.optional(),
    optionIds: z.array(boundedPermissionId),
    questionId: boundedPermissionId,
  })
  .passthrough()
  .superRefine((value, context) => {
    if (new Set(value.optionIds).size !== value.optionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Question answer option ids must be unique",
      });
    }
  });

export const v2QuestionResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({ answers: z.array(v2QuestionAnswerItemSchema), kind: z.literal("answered") })
    .passthrough(),
  z.object({ kind: z.literal("cancelled") }).passthrough(),
]);

const v2WorkStateGoalSchema = z
  .object({
    blockedReason: z
      .object({ code: boundedPermissionId, message: boundedQuestionDetail })
      .passthrough()
      .optional(),
    createdAt: timestamp,
    id: boundedPermissionId,
    maxGoalRounds: positiveInteger,
    objective: boundedQuestionDetail,
    phase: z.enum(["active", "blocked", "complete", "paused"]),
    revision: positiveInteger,
    roundsStarted: nonNegativeInteger,
    updatedAt: timestamp,
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.phase === "blocked" && value.blockedReason === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Blocked goals require a reason" });
    }
    if (value.phase !== "blocked" && value.blockedReason !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only blocked goals may have a reason",
      });
    }
  });

const v2TodoSchema = z
  .object({
    content: boundedQuestionSingleLine,
    status: z.enum(["pending", "in_progress", "completed"]),
  })
  .passthrough();

const v2WorkStateSchema = z
  .object({
    goal: v2WorkStateGoalSchema.nullable(),
    todos: z.array(v2TodoSchema).max(256),
  })
  .passthrough()
  .superRefine((value, context) => {
    const contents = new Set(value.todos.map((todo) => todo.content));
    if (contents.size !== value.todos.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Todo contents must be unique" });
    }
  });

export const v2StateSchema = z
  .object({
    activeRun: v2RunSummarySchema.nullable().optional(),
    configOptions: z.array(v2SessionConfigOptionSchema),
    createdAt: timestamp,
    cwd: z.string().nullable(),
    lastRun: v2RunSummarySchema.nullable().optional(),
    leafEntryId: nonEmptyString.nullable(),
    mode: z.string().nullable(),
    model: v2ModelSchema.nullable(),
    pendingInputs: z.array(v2QueuedInputSchema),
    pendingPermissions: z.array(v2PermissionSchema),
    pendingQuestions: z.array(v2QuestionRequestSchema),
    ref: v2RefSchema,
    revision: nonNegativeInteger,
    runState: z.enum(["idle", "running", "suspended", "error"]),
    title: z.string().nullable(),
    updatedAt: timestamp,
    usageTotal: v2UsageSchema.nullable().optional(),
    workspaceRef: z.string().nullable(),
    workState: v2WorkStateSchema,
  })
  .passthrough();

export const v2StatePatchSchema = z
  .object({
    activeRun: v2RunSummarySchema.nullable().optional(),
    configOptions: z.array(v2SessionConfigOptionSchema).optional(),
    cwd: z.string().nullable().optional(),
    lastRun: v2RunSummarySchema.nullable().optional(),
    leafEntryId: nonEmptyString.nullable().optional(),
    mode: z.string().nullable().optional(),
    model: v2ModelSchema.nullable().optional(),
    pendingInputs: z.array(v2QueuedInputSchema).optional(),
    pendingPermissions: z.array(v2PermissionSchema).optional(),
    pendingQuestions: z.array(v2QuestionRequestSchema).optional(),
    runState: z.enum(["idle", "running", "suspended", "error"]).optional(),
    title: z.string().nullable().optional(),
    updatedAt: timestamp.optional(),
    usageTotal: v2UsageSchema.nullable().optional(),
    workspaceRef: z.string().nullable().optional(),
    workState: v2WorkStateSchema.optional(),
  })
  .passthrough();

export const v2OverlaySchema = z
  .object({
    runId: nonEmptyString,
    runningTools: z.array(
      z
        .object({
          callId: nonEmptyString,
          // A tool can enter pending state before its first streamed input or
          // output fragment. Zero means no delta has been observed yet.
          chunkSeq: nonNegativeInteger,
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
        blocks: z.array(
          z
            .object({
              blockIndex: nonNegativeInteger,
              content: v2StreamingContentBlockSchema,
            })
            .passthrough(),
        ),
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
          z
            .object({
              downloadChunkBytes: positiveInteger,
              maxImageBytes: positiveInteger,
              maxImagesPerMessage: positiveInteger,
              maxMessageImageBytes: positiveInteger,
              mimeTypes: z.array(nonEmptyString).min(1),
              uploadChunkBytes: positiveInteger,
            })
            .passthrough(),
        ]),
        dispose: z.boolean(),
        fork: z.boolean(),
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

const boundedSubagentId = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim())
  .refine((value) => {
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code <= 0x1f || code === 0x7f) return false;
    }
    return true;
  });

const boundedSubagentLabel = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim())
  .refine((value) => {
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code <= 0x1f || code === 0x7f) return false;
    }
    return true;
  });

const v2SubagentRefSchema = z
  .object({
    backendId: boundedSubagentId,
    driverId: boundedSubagentId,
    nativeSessionId: boundedSubagentId,
    sessionId: boundedSubagentId,
  })
  .strict();

const v2SubagentChildSchema = z
  .object({
    activity: z.enum(["inactive", "running"]),
    depth: positiveInteger.max(1024),
    hasChildren: z.boolean(),
    kind: z.literal("child"),
    label: boundedSubagentLabel.optional(),
    mode: z.enum(["continuable", "one-shot"]),
    parentRef: v2SubagentRefSchema,
    ref: v2SubagentRefSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "continuable" && value.label === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Continuable subagents require label",
      });
    }
  });

const v2SubagentDiagnosticSchema = z
  .object({
    depth: positiveInteger.max(1024),
    kind: z.literal("diagnostic"),
    parentRef: v2SubagentRefSchema,
    reason: z.enum(["corrupt", "unavailable", "unsupported"]),
    ref: v2SubagentRefSchema,
  })
  .strict();

export const v2SubagentEntrySchema = z.discriminatedUnion("kind", [
  v2SubagentChildSchema,
  v2SubagentDiagnosticSchema,
]);

export const v2SubagentListInputSchema = z.object({ ref: v2SubagentRefSchema }).strict();

export const v2SubagentListResponseSchema = z
  .object({ entries: z.array(v2SubagentEntrySchema).max(1024) })
  .strict();

export const v2ModelsListInputSchema = z
  .object({ driverId: nonEmptyString.optional() })
  .passthrough();

export const v2WorkspacesListInputSchema = z.object({ driverId: nonEmptyString }).passthrough();

export const v2WorkspacesBrowseInputSchema = z
  .object({ driverId: nonEmptyString, folderRef: nonEmptyString.optional() })
  .passthrough();

export const v2WorkspacesCreateFolderInputSchema = z
  .object({
    driverId: nonEmptyString,
    idempotencyKey: nonEmptyString,
    name: nonEmptyString,
    parentFolderRef: nonEmptyString,
  })
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
    content: z.array(v2PromptContentBlockSchema).min(1),
    delivery: z.enum(["steer", "follow_up"]).optional(),
    expectedRevision: nonNegativeInteger.optional(),
    idempotencyKey: nonEmptyString,
    ref: v2RefSchema,
  })
  .passthrough();

export const v2PromptReferenceCompletionInputSchema = z
  .object({
    cursor: nonNegativeInteger,
    limit: positiveInteger.max(64),
    ref: v2RefSchema,
    source: z.enum(["files", "sessions"]),
    text: boundedReferenceText,
  })
  .passthrough();

export const v2PromptReferenceCompletionResultSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            detail: boundedReferenceDisplay.max(2_048).optional(),
            insertText: boundedReferenceDisplay,
            kind: z.enum(["directory", "file", "session"]),
            label: boundedReferenceDisplay.max(512),
          })
          .strict(),
      )
      .max(64),
    end: nonNegativeInteger,
    start: nonNegativeInteger,
  })
  .strict();

export const v2PromptReferenceCompletionResponseSchema =
  v2PromptReferenceCompletionResultSchema.nullable();

export const v2AttachmentUploadBeginInputSchema = z
  .object({
    idempotencyKey: nonEmptyString,
    mimeType: nonEmptyString,
    name: nonEmptyString.optional(),
    ref: v2RefSchema,
    totalBytes: positiveInteger,
    uploadId: boundedPermissionId,
  })
  .passthrough();

export const v2AttachmentUploadChunkInputSchema = z
  .object({
    data: nonEmptyString,
    idempotencyKey: nonEmptyString,
    offset: nonNegativeInteger,
    uploadId: boundedPermissionId,
  })
  .passthrough();

export const v2AttachmentUploadFinishInputSchema = z
  .object({
    idempotencyKey: nonEmptyString,
    uploadId: boundedPermissionId,
  })
  .passthrough();

export const v2AttachmentUploadAbortInputSchema = z
  .object({
    idempotencyKey: nonEmptyString,
    uploadId: boundedPermissionId,
  })
  .passthrough();

export const v2AttachmentReadInputSchema = z
  .object({
    attachmentId: boundedPermissionId,
    offset: nonNegativeInteger,
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
    idempotencyKey: boundedPermissionId,
    optionId: boundedPermissionId,
    ref: v2RefSchema,
    requestId: boundedPermissionId,
  })
  .passthrough();

export const v2QuestionResponseInputSchema = z
  .object({
    idempotencyKey: boundedPermissionId,
    ref: v2RefSchema,
    requestId: boundedPermissionId,
    response: v2QuestionResponseSchema,
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
      settlesEntryId: nonEmptyString.optional(),
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
      part: z.enum(["text", "thinking", "tool_input", "tool_output"]),
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
      eventId: nonEmptyString,
      occurredAt: timestamp,
      sessionId: nonEmptyString,
      source: v2RefSchema.pick({ backendId: true, driverId: true }).extend({
        nativeType: nonEmptyString.optional(),
        version: nonEmptyString.optional(),
      }),
      tool: z
        .object({
          callId: nonEmptyString,
          content: z.array(v2ContentBlockSchema).optional(),
          entryId: nonEmptyString,
          input: jsonValueSchema.optional(),
          name: nonEmptyString,
          status: z.enum(["cancelled", "error", "pending", "running", "success"]),
        })
        .passthrough(),
      type: z.literal("tool.state.changed"),
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
