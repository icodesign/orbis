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
  type AgentEntryAppendedEvent,
  type AgentEntryDeltaEvent,
  type AgentSessionStateChangedEvent,
  type AgentSessionEvent,
  type AgentSessionMetadata,
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

    await piRuntime.prompt({ text: "Keep running while the UI switches away" });
    unsubscribe();
    await dshRuntime.prompt({ text: "A separate DSH run" });
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

    await firstRuntime.prompt({ text: "First run" });
    await secondRuntime.prompt({ text: "Second run" });
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
        part: "text",
      },
      sessionId: ref.sessionId,
      source: { backendId: ref.backendId, driverId: ref.driverId },
      type: "entry.delta",
    };

    const afterStart = expectApplied(runStarted);
    const afterEntry = expectApplied(entry, afterStart);
    const duplicate = applyAgentSessionEvent(afterEntry, entry);
    const ignoredTransient = applyAgentSessionEvent(afterEntry, transient);
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
    expect(gap).toMatchObject({
      expectedCursor: agentDeliveryCursor(2),
      kind: "gap",
      receivedCursor: agentDeliveryCursor(3),
    });
    expect(stale).toMatchObject({ kind: "conflict", error: { code: "cursor_conflict" } });
    expect(wrongSource).toMatchObject({ kind: "conflict", error: { code: "protocol" } });
  });
});
