import { describe, expect, test } from "vitest";

import {
  agentDeliveryCursor,
  agentDriverId,
  agentEntryId,
  agentEventId,
  agentRunId,
  agentTimestamp,
  applyAgentSessionEvent,
  createAgentBackendDescriptor,
  createAgentDriverDescriptor,
  createAgentSessionProjection,
  createAgentSessionRef,
  hasAgentDriverCapability,
  validateAgentPermissionRequest,
  validateAgentPermissionResponseInput,
  validateAgentPromptInput,
  validateAgentQuestionRequest,
  validateAgentQuestionResponseForRequest,
  validateAgentQuestionResponseInput,
  validateAgentSessionSubagentEntry,
  validateAgentSessionSubagentList,
  validateAgentWorkState,
  type AgentEntryAppendedEvent,
  type AgentEntryDeltaEvent,
  type AgentSessionStateChangedEvent,
  type AgentSessionEvent,
  type AgentSessionMetadata,
  type AgentToolStateChangedEvent,
} from "./index";
import { FakeAgentBackend } from "./testkit";

const FIXED_TIME = agentTimestamp("2026-08-10T00:00:00.000Z");

function sequential(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function createBackend(): FakeAgentBackend {
  return new FakeAgentBackend({
    createEntryId: sequential("entry"),
    createEventId: sequential("event"),
    createRunId: sequential("run"),
    createSessionId: sequential("session"),
    descriptor: createAgentBackendDescriptor({
      displayName: "This device",
      id: "local",
      kind: "local",
    }),
    drivers: [
      createAgentDriverDescriptor({
        capabilities: [
          "prompt.follow_up",
          "run.cancel",
          "session.create",
          "session.list",
          "session.read",
        ],
        displayName: "Pi",
        id: "pi",
      }),
      createAgentDriverDescriptor({
        capabilities: [
          "prompt.follow_up",
          "run.cancel",
          "session.create",
          "session.list",
          "session.read",
        ],
        displayName: "DeepSeek Harness",
        id: "dsh",
      }),
    ],
    now: () => FIXED_TIME,
  });
}

function projectionFixture() {
  const ref = createAgentSessionRef({
    backendId: "remote:build-mac",
    driverId: "pi",
    nativeSessionId: "pi-native-1",
    sessionId: "session-1",
  });
  const metadata: AgentSessionMetadata = {
    createdAt: FIXED_TIME,
    title: "Original title",
    updatedAt: FIXED_TIME,
  };
  return { metadata, ref };
}

function subagentRef(nativeSessionId: string) {
  return createAgentSessionRef({
    backendId: "dsh-host",
    driverId: "dsh",
    nativeSessionId,
    sessionId: nativeSessionId,
  });
}

test("validates subagent child/diagnostic rows and preserves pre-order", () => {
  const root = subagentRef("root");
  const child = subagentRef("child");
  const diagnostic = subagentRef("broken");
  const entries = validateAgentSessionSubagentList([
    {
      activity: "running",
      depth: 1,
      hasChildren: true,
      kind: "child",
      mode: "continuable",
      parentRef: root,
      ref: child,
      label: "Build helper",
    },
    { depth: 2, kind: "diagnostic", parentRef: child, reason: "corrupt", ref: diagnostic },
  ], root);

  expect(entries.map((entry) => entry.ref.sessionId)).toEqual(["child", "broken"]);
  expect(Object.isFrozen(entries)).toBe(true);
  expect(() =>
    validateAgentSessionSubagentEntry({
      activity: "inactive",
      depth: 1,
      hasChildren: false,
      kind: "child",
      mode: "continuable",
      parentRef: root,
      ref: child,
    }),
  ).toThrow(/label/i);
});

test("rejects malformed subagent identities, duplicate rows, and invalid enums", () => {
  const root = subagentRef("root");
  const child = subagentRef("child");
  expect(() =>
    validateAgentSessionSubagentEntry({
      activity: "running",
      depth: 0,
      hasChildren: false,
      kind: "child",
      mode: "one-shot",
      parentRef: root,
      ref: child,
    }),
  ).toThrow(/depth/i);
  expect(() =>
    validateAgentSessionSubagentList([
      {
        depth: 1,
        kind: "diagnostic",
        parentRef: root,
        reason: "corrupt",
        ref: child,
      },
      {
        depth: 1,
        kind: "diagnostic",
        parentRef: root,
        reason: "corrupt",
        ref: child,
      },
    ], root),
  ).toThrow(/duplicate/i);
  expect(() =>
    validateAgentSessionSubagentEntry({
      depth: 1,
      kind: "diagnostic",
      parentRef: root,
      reason: "unknown",
      ref: child,
    }),
  ).toThrow(/reason/i);
  const catalogChild = createAgentSessionRef({
    backendId: root.backendId,
    driverId: root.driverId,
    nativeSessionId: "child-native",
    sessionId: "catalog-child",
  });
  expect(() =>
    validateAgentSessionSubagentList(
      [
        {
          activity: "running",
          depth: 1,
          hasChildren: false,
          kind: "child",
          mode: "one-shot",
          parentRef: root,
          ref: catalogChild,
        },
      ],
      root,
    ),
  ).not.toThrow();
});

test("root-aware subagent validation rejects foreign, orphaned, and misnested rows", () => {
  const root = createAgentSessionRef({
    backendId: "remote:host",
    driverId: "dsh",
    nativeSessionId: "native-root",
    sessionId: "catalog-root",
  });
  const child = createAgentSessionRef({
    backendId: root.backendId,
    driverId: root.driverId,
    nativeSessionId: "native-child",
    sessionId: "catalog-child",
  });
  const grandchild = createAgentSessionRef({
    backendId: root.backendId,
    driverId: root.driverId,
    nativeSessionId: "native-grandchild",
    sessionId: "catalog-grandchild",
  });
  const foreign = createAgentSessionRef({
    backendId: "other-host",
    driverId: root.driverId,
    nativeSessionId: "native-foreign",
    sessionId: "catalog-foreign",
  });
  const orphan = createAgentSessionRef({
    backendId: root.backendId,
    driverId: root.driverId,
    nativeSessionId: "native-orphan",
    sessionId: "catalog-orphan",
  });
  const childRow = {
    activity: "inactive" as const,
    depth: 1,
    hasChildren: true,
    kind: "child" as const,
    mode: "continuable" as const,
    parentRef: root,
    ref: child,
    label: "Child",
  };
  expect(
    validateAgentSessionSubagentList(
      [childRow, { ...childRow, depth: 2, parentRef: child, ref: grandchild }],
      root,
    ),
  ).toHaveLength(2);
  expect(() =>
    validateAgentSessionSubagentList([{ ...childRow, ref: foreign }], root),
  ).toThrow(/foreign/i);
  expect(() =>
    validateAgentSessionSubagentList(
      [{ ...childRow, depth: 2, parentRef: orphan, ref: grandchild }],
      root,
    ),
  ).toThrow(/pre-order/i);
  expect(() =>
    validateAgentSessionSubagentList(
      [{ ...childRow, depth: 3, parentRef: child, ref: grandchild }],
      root,
    ),
  ).toThrow(/pre-order/i);
  expect(() =>
    validateAgentSessionSubagentList(
      [
        {
          depth: 1,
          kind: "diagnostic" as const,
          parentRef: root,
          reason: "unavailable" as const,
          ref: orphan,
        },
        { ...childRow, depth: 2, parentRef: orphan, ref: grandchild },
      ],
      root,
    ),
  ).toThrow(/pre-order/i);
});

function durableEntryEvent(
  cursor: number,
  eventId: string,
  entryId: string,
): AgentEntryAppendedEvent {
  const { ref } = projectionFixture();
  return {
    cursor: agentDeliveryCursor(cursor),
    durability: "durable",
    eventId: agentEventId(eventId),
    occurredAt: FIXED_TIME,
    payload: {
      entry: {
        content: [{ text: "durable assistant reply", type: "text" }],
        createdAt: FIXED_TIME,
        cursor: agentDeliveryCursor(cursor),
        id: agentEntryId(entryId),
        kind: "message",
        parentId: null,
        role: "assistant",
      },
    },
    sessionId: ref.sessionId,
    source: { backendId: ref.backendId, driverId: ref.driverId },
    type: "entry.appended",
  };
}

function expectApplied(event: AgentSessionEvent, projection = createProjection()) {
  const result = applyAgentSessionEvent(projection, event);
  expect(result.kind).toBe("applied");
  if (result.kind !== "applied") {
    throw new Error(`Expected event to apply, got ${result.kind}`);
  }
  return result.projection;
}

function createProjection() {
  const { metadata, ref } = projectionFixture();
  return createAgentSessionProjection(ref, metadata);
}

async function expectConflict(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
    throw new Error("Expected the operation to reject with a conflict");
  } catch (error) {
    expect(error).toMatchObject({ code: "conflict" });
  }
}

async function expectUnavailable(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
    throw new Error("Expected the operation to reject because the driver is unavailable");
  } catch (error) {
    expect(error).toMatchObject({ code: "unavailable" });
  }
}

describe("agent backend contract", () => {
  test("requires canonical base64 for inline image prompt blocks", () => {
    expect(() =>
      validateAgentPromptInput({
        content: [{ data: "AB==", mimeType: "image/png", type: "image" }],
      }),
    ).toThrow(/canonical base64/u);
    expect(
      validateAgentPromptInput({
        content: [{ data: "AA==", mimeType: "image/png", type: "image" }],
      }),
    ).toMatchObject({ content: [{ data: "AA==", type: "image" }] });
  });

  test("seeds runtime status observers, emits real transitions, and closes after publishing closed", async () => {
    const backend = createBackend();
    const record = await backend.getDriver("pi").createSession();
    const runtime = await backend.connectRuntime(record.ref);
    const statuses: string[] = [];

    runtime.observeStatus((status) => statuses.push(status));
    runtime.observeStatus(() => {
      throw new Error("observer failure");
    });
    expect(statuses).toEqual(["ready"]);

    await runtime.prompt({ content: [{ text: "Run", type: "text" }] });
    await runtime.finish("completed");
    await runtime.close();

    expect(statuses).toEqual(["ready", "running", "ready", "closed"]);
    expect(runtime.getStatus()).toBe("closed");
  });

  test("allows a local backend to host Pi and DSH sessions concurrently without tying a run to a UI subscription", async () => {
    const backend = createBackend();
    const pi = backend.getDriver("pi");
    const dsh = backend.getDriver("dsh");
    const piRecord = await pi.createSession({ title: "Pi session" });
    const dshRecord = await dsh.createSession({ title: "DSH session" });
    const piRuntime = await backend.connectRuntime(piRecord.ref);
    const dshRuntime = await backend.connectRuntime(dshRecord.ref);
    const piEvents: AgentSessionEvent[] = [];
    const unsubscribe = piRuntime.subscribe((event) => piEvents.push(event));

    await piRuntime.prompt({
      content: [{ text: "Keep running while the UI switches away", type: "text" }],
    });
    unsubscribe();
    await dshRuntime.prompt({ content: [{ text: "A separate DSH run", type: "text" }] });
    await piRuntime.commitAssistantText("Pi completed a durable response after the switch");

    expect(piRuntime.getStatus()).toBe("running");
    expect(dshRuntime.getStatus()).toBe("running");
    expect(piEvents.map((event) => event.type)).toEqual(["session.state.changed"]);
    expect((await backend.readSession(piRecord.ref)).entries).toMatchObject([
      { content: [{ text: "Pi completed a durable response after the switch", type: "text" }] },
    ]);
    expect((await backend.readSession(piRecord.ref)).cursor).toBe(agentDeliveryCursor(1));
    expect((await backend.readSession(dshRecord.ref)).cursor).toBe(agentDeliveryCursor(0));
    expect(await backend.connectRuntime(piRecord.ref)).toBe(piRuntime);
    await expectConflict(() => dsh.readSession(piRecord.ref));
  });

  test("closing one runtime is a connection-lifetime operation and does not stop other sessions", async () => {
    const backend = createBackend();
    const pi = backend.getDriver("pi");
    const first = await pi.createSession({ title: "First" });
    const second = await pi.createSession({ title: "Second" });
    const firstRuntime = await backend.connectRuntime(first.ref);
    const secondRuntime = await backend.connectRuntime(second.ref);

    await firstRuntime.prompt({ content: [{ text: "First run", type: "text" }] });
    await secondRuntime.prompt({ content: [{ text: "Second run", type: "text" }] });
    await firstRuntime.close();

    expect(firstRuntime.getStatus()).toBe("closed");
    expect(secondRuntime.getStatus()).toBe("running");
    expect((await backend.readSession(first.ref)).activeRun?.state).toBe("running");
    expect((await backend.readSession(second.ref)).activeRun?.state).toBe("running");
    expect(await backend.listSessions()).toMatchObject([
      { ref: { sessionId: first.ref.sessionId }, runtimeStatus: "closed" },
      { ref: { sessionId: second.ref.sessionId }, runtimeStatus: "running" },
    ]);

    const reconnectedFirstRuntime = await backend.connectRuntime(first.ref);
    expect(reconnectedFirstRuntime).not.toBe(firstRuntime);
    expect(reconnectedFirstRuntime.getStatus()).toBe("running");
    expect(await reconnectedFirstRuntime.cancel()).toEqual({ cancelled: true });
    expect((await backend.readSession(first.ref)).state).toBe("idle");
    expect(secondRuntime.getStatus()).toBe("running");
  });

  test("lists a known unavailable driver but rejects attempts to create a session with it", async () => {
    const unavailableDsh = createAgentDriverDescriptor({
      availability: {
        available: false,
        reason: "DeepSeek Harness is not installed on this device",
        unsupportedCapabilities: ["session.create", "session.read"],
      },
      capabilities: [],
      displayName: "DeepSeek Harness",
      id: "dsh",
    });
    const backend = new FakeAgentBackend({
      createSessionId: sequential("session"),
      descriptor: createAgentBackendDescriptor({
        displayName: "This device",
        id: "local",
        kind: "local",
      }),
      drivers: [unavailableDsh],
      now: () => FIXED_TIME,
    });

    expect(await backend.listDrivers()).toEqual([unavailableDsh]);
    await expectUnavailable(() =>
      backend.createSession({ driverId: agentDriverId("dsh"), title: "Cannot start" }),
    );
  });

  test("projects only contiguous durable events, deduplicates replay, and leaves transient deltas out of the cache", () => {
    const { ref } = projectionFixture();
    const runStarted: AgentSessionStateChangedEvent = {
      durability: "transient",
      eventId: agentEventId("event-1"),
      occurredAt: FIXED_TIME,
      payload: {
        patch: {
          activeRun: { id: agentRunId("run-1"), startedAt: FIXED_TIME },
          runState: "running",
        },
        revision: 1,
      },
      sessionId: ref.sessionId,
      source: { backendId: ref.backendId, driverId: ref.driverId },
      type: "session.state.changed",
    };
    const entry = durableEntryEvent(1, "event-2", "entry-1");
    const transient: AgentEntryDeltaEvent = {
      durability: "transient",
      eventId: agentEventId("event-transient"),
      occurredAt: FIXED_TIME,
      payload: {
        blockIndex: 0,
        chunkSeq: 1,
        delta: "not persisted",
        entryId: agentEntryId("stream-1"),
        part: "tool_input",
      },
      sessionId: ref.sessionId,
      source: { backendId: ref.backendId, driverId: ref.driverId },
      type: "entry.delta",
    };
    const toolState: AgentToolStateChangedEvent = {
      durability: "transient",
      eventId: agentEventId("event-tool-state"),
      occurredAt: FIXED_TIME,
      payload: {
        tool: {
          callId: "call-1",
          entryId: agentEntryId("tool-call-1"),
          input: { path: "/workspace/demo.ts" },
          name: "read",
          status: "running",
        },
      },
      sessionId: ref.sessionId,
      source: { backendId: ref.backendId, driverId: ref.driverId },
      type: "tool.state.changed",
    };

    const afterStart = expectApplied(runStarted);
    const afterEntry = expectApplied(entry, afterStart);
    const duplicate = applyAgentSessionEvent(afterEntry, entry);
    const ignoredTransient = applyAgentSessionEvent(afterEntry, transient);
    const ignoredToolState = applyAgentSessionEvent(afterEntry, toolState);
    const gap = applyAgentSessionEvent(afterEntry, durableEntryEvent(3, "event-4", "entry-4"));
    const stale = applyAgentSessionEvent(
      afterEntry,
      durableEntryEvent(1, "event-stale", "entry-stale"),
    );
    const wrongSource = applyAgentSessionEvent(afterEntry, {
      ...durableEntryEvent(3, "event-wrong-source", "entry-wrong-source"),
      source: { backendId: ref.backendId, driverId: agentDriverId("dsh") },
    });

    expect(afterEntry.cursor).toBe(agentDeliveryCursor(1));
    expect(afterEntry.entries).toHaveLength(1);
    expect(afterEntry.lastAppliedDurableEvent).toEqual({
      cursor: agentDeliveryCursor(1),
      eventId: agentEventId("event-2"),
    });
    expect(duplicate).toMatchObject({ kind: "ignored", reason: "duplicate" });
    expect(ignoredTransient).toMatchObject({ kind: "ignored", reason: "transient" });
    expect(ignoredTransient.projection).toBe(afterEntry);
    expect(ignoredToolState).toMatchObject({ kind: "ignored", reason: "transient" });
    expect(ignoredToolState.projection).toBe(afterEntry);
    expect(gap).toMatchObject({
      expectedCursor: agentDeliveryCursor(2),
      kind: "gap",
      receivedCursor: agentDeliveryCursor(3),
    });
    expect(stale).toMatchObject({ kind: "conflict", error: { code: "cursor_conflict" } });
    expect(wrongSource).toMatchObject({ kind: "conflict", error: { code: "protocol" } });
  });

  test("advances the selected branch leaf when a durable entry extends it", () => {
    const root = durableEntryEvent(1, "event-root", "entry-root");
    const initial = { ...createProjection(), leafEntryId: null };
    const afterRoot = expectApplied(root, initial);

    expect(afterRoot.leafEntryId).toBe(root.payload.entry.id);

    const childEvent = durableEntryEvent(2, "event-child", "entry-child");
    const child = {
      ...childEvent,
      payload: {
        ...childEvent.payload,
        entry: {
          ...childEvent.payload.entry,
          id: agentEntryId("entry-child"),
          parentId: root.payload.entry.id,
        },
      },
    } satisfies AgentEntryAppendedEvent;
    const afterChild = expectApplied(child, afterRoot);

    expect(afterChild.leafEntryId).toBe(child.payload.entry.id);
    expect(afterChild.revision).toBe(afterRoot.revision);

    const forkEvent = durableEntryEvent(3, "event-fork", "entry-fork");
    const fork = {
      ...forkEvent,
      payload: {
        ...forkEvent.payload,
        entry: {
          ...forkEvent.payload.entry,
          id: agentEntryId("entry-fork"),
          parentId: agentEntryId("entry-other-branch"),
        },
      },
    } satisfies AgentEntryAppendedEvent;
    const afterFork = expectApplied(fork, afterChild);

    expect(afterFork.leafEntryId).toBe(child.payload.entry.id);
  });

  test("validates permission options as a full decision set and preserves multiline detail", () => {
    const request = validateAgentPermissionRequest({
      detail: "The tool needs access to this file.\nReview the path before continuing.",
      options: [
        { kind: "allow_once", label: "Allow once", optionId: "allow-once" },
        { kind: "reject_once", label: "Reject", optionId: "reject-once" },
      ],
      requestId: "request-1",
      requestedAt: FIXED_TIME,
      title: "Read a file",
    });
    expect(request.detail).toContain("\n");

    expect(() =>
      validateAgentPermissionRequest({
        options: [
          { kind: "allow_once", label: "Allow", optionId: "same" },
          { kind: "reject_once", label: "Reject", optionId: "same" },
        ],
        requestId: "request-2",
        requestedAt: FIXED_TIME,
        title: "Duplicate options",
      }),
    ).toThrow(/unique/u);
    expect(() =>
      validateAgentPermissionRequest({
        options: [
          { kind: "allow_once", label: "Allow", optionId: "allow" },
          { kind: "allow_always", label: "Always allow", optionId: "always" },
        ],
        requestId: "request-3",
        requestedAt: FIXED_TIME,
        title: "Missing rejection",
      }),
    ).toThrow(/reject option/u);
    expect(() =>
      validateAgentPermissionRequest({
        options: [
          { kind: "reject_once", label: "Reject", optionId: "reject" },
          { kind: "reject_always", label: "Always reject", optionId: "always-reject" },
        ],
        requestId: "request-4",
        requestedAt: FIXED_TIME,
        title: "Missing approval",
      }),
    ).toThrow(/allow option/u);
    expect(
      validateAgentPermissionResponseInput({
        optionId: "allow-once",
        requestId: "request-1",
      }),
    ).toEqual({ optionId: "allow-once", requestId: "request-1" });
  });

  test("keeps Ask User separate from permission and validates full-set opaque answers", () => {
    const request = validateAgentQuestionRequest({
      questions: [
        {
          detail: "# Review\n\nChoose the deployment target.",
          header: "Target",
          intent: { approveOptionId: "yes", kind: "plan-review" },
          multiSelect: false,
          options: [
            { label: "Approve", optionId: "yes" },
            { description: "Do not continue", label: "Reject", optionId: "no" },
          ],
          question: "Continue with this plan?",
          questionId: "deploy",
        },
        {
          multiSelect: true,
          options: [{ label: "Email", optionId: "email" }],
          question: "Which notifications should be enabled?",
          questionId: "notifications",
        },
      ],
      requestId: "question-1",
      requestedAt: FIXED_TIME,
    });
    expect(request.questions.map((question) => question.questionId)).toEqual([
      "deploy",
      "notifications",
    ]);
    expect(request.questions[0]?.detail).toContain("\n");

    expect(
      validateAgentQuestionResponseForRequest(
        {
          requestId: "question-1",
          response: {
            answers: [
              { customText: "Looks good", optionIds: ["email"], questionId: "notifications" },
              { optionIds: ["yes"], questionId: "deploy" },
            ],
            kind: "answered",
          },
        },
        request,
      ),
    ).toMatchObject({
      response: {
        answers: [
          { optionIds: ["yes"], questionId: "deploy" },
          { optionIds: ["email"], questionId: "notifications" },
        ],
      },
    });
    expect(
      validateAgentQuestionResponseInput({
        requestId: "question-1",
        response: { kind: "cancelled" },
      }),
    ).toMatchObject({ response: { kind: "cancelled" } });
    expect(() =>
      validateAgentQuestionRequest({
        questions: [
          {
            intent: { approveOptionId: "missing", kind: "plan-review" },
            multiSelect: false,
            options: [{ label: "Approve", optionId: "yes" }],
            question: "Invalid plan",
            questionId: "plan",
          },
        ],
        requestId: "question-bad-intent",
        requestedAt: FIXED_TIME,
      }),
    ).toThrow(/reference an option/u);
    expect(() =>
      validateAgentQuestionResponseForRequest(
        {
          requestId: "question-1",
          response: {
            answers: [
              { optionIds: ["yes"], questionId: "deploy" },
              { optionIds: [], questionId: "deploy" },
            ],
            kind: "answered",
          },
        },
        request,
      ),
    ).toThrow(/unique/u);
    expect(() =>
      validateAgentQuestionResponseForRequest(
        {
          requestId: "question-1",
          response: {
            answers: [
              { customText: "Cannot combine", optionIds: ["yes"], questionId: "deploy" },
              { optionIds: ["email"], questionId: "notifications" },
            ],
            kind: "answered",
          },
        },
        request,
      ),
    ).toThrow(/combine/u);
    expect(() =>
      validateAgentQuestionRequest({
        questions: [
          {
            intent: { approveOptionId: "yes", kind: "plan-review" },
            multiSelect: false,
            options: [{ label: "Approve", optionId: "yes" }],
            question: "Missing detail",
            questionId: "plan",
          },
        ],
        requestId: "question-bad-detail",
        requestedAt: FIXED_TIME,
      }),
    ).toThrow(/require detail/u);
  });

  test("replaces and clears pending questions and work state as whole snapshots", () => {
    const { ref } = projectionFixture();
    const request = validateAgentQuestionRequest({
      questions: [
        {
          multiSelect: false,
          options: [{ label: "Yes", optionId: "yes" }],
          question: "Continue?",
          questionId: "continue",
        },
      ],
      requestId: "question-state",
      requestedAt: FIXED_TIME,
    });
    const first = expectApplied({
      durability: "transient",
      eventId: agentEventId("state-questions"),
      occurredAt: FIXED_TIME,
      payload: {
        patch: {
          pendingQuestions: [request],
          workState: validateAgentWorkState({
            goal: {
              createdAt: FIXED_TIME,
              id: "goal-1",
              maxGoalRounds: 4,
              objective: "Ship the feature",
              phase: "active",
              revision: 1,
              roundsStarted: 1,
              updatedAt: FIXED_TIME,
            },
            todos: [{ content: "Review", status: "in_progress" }],
          }),
        },
        revision: 1,
      },
      sessionId: ref.sessionId,
      source: { backendId: ref.backendId, driverId: ref.driverId },
      type: "session.state.changed",
    });
    expect(first.pendingQuestions).toEqual([request]);
    expect(first.workState.goal?.id).toBe("goal-1");
    expect(first.workState.todos).toEqual([{ content: "Review", status: "in_progress" }]);

    const cleared = expectApplied(
      {
        durability: "transient",
        eventId: agentEventId("state-clear"),
        occurredAt: FIXED_TIME,
        payload: {
          patch: { pendingQuestions: [], workState: { goal: null, todos: [] } },
          revision: 2,
        },
        sessionId: ref.sessionId,
        source: { backendId: ref.backendId, driverId: ref.driverId },
        type: "session.state.changed",
      },
      first,
    );
    expect(cleared.pendingQuestions).toEqual([]);
    expect(cleared.workState).toEqual({ goal: null, todos: [] });
    expect(() =>
      validateAgentWorkState({
        goal: {
          createdAt: FIXED_TIME,
          id: "goal-0",
          maxGoalRounds: 0,
          objective: "Invalid",
          phase: "active",
          revision: 0,
          roundsStarted: 0,
          updatedAt: FIXED_TIME,
        },
        todos: [],
      }),
    ).toThrow(/invalid/u);
    expect(() =>
      validateAgentWorkState({
        goal: null,
        todos: [
          { content: "Same", status: "pending" },
          { content: "Same", status: "completed" },
        ],
      }),
    ).toThrow(/unique/u);
  });

  test("advertises independent plan and question capabilities", () => {
    const driver = createAgentDriverDescriptor({
      capabilities: ["plan.select", "question.respond"],
      displayName: "Questions",
      id: "questions",
    });
    expect(hasAgentDriverCapability(driver, "plan.select")).toBe(true);
    expect(hasAgentDriverCapability(driver, "question.respond")).toBe(true);
  });
});
