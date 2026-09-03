import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SubagentDescendantListEntry } from "@deepseek-ai/dsh-subagent";
import { expect, test, vi } from "vitest";

import type { OrbisRemoteDshHost } from "../host";
import {
  createDshAttachmentPort,
  createDshPermissionProvider,
  createDshPlanModeProvider,
  createDshSessionSubagentProvider,
  createRawDshEventReplayPort,
  inject,
  isRawDshEventRecordingEnabled,
  subscribeRawDshEventRecorder,
} from "./dsh-plugin";

const image = { data: "AA==", mediaType: "image/png" } as const;

function contextFor(store: AttachmentStore): Context {
  return { attachments: store } as unknown as Context;
}

test("maps DSH image admission failures to invalid_argument", async () => {
  const error = Object.assign(new Error("bad image"), { code: "INVALID_IMAGE" });
  const store = {
    saveImages: async () => {
      throw error;
    },
  } as unknown as AttachmentStore;
  const port = createDshAttachmentPort(contextFor(store));
  await expect(port?.admitEncodedImages([image])).rejects.toMatchObject({
    code: "invalid_argument",
  });
});

test("does not mislabel attachment storage failures as invalid user input", async () => {
  const error = new Error("disk unavailable");
  const store = {
    saveImages: async () => {
      throw error;
    },
  } as unknown as AttachmentStore;
  const port = createDshAttachmentPort(contextFor(store));
  await expect(port?.admitEncodedImages([image])).rejects.toBe(error);
});

test("injects and forwards the official DSH subagent listing unchanged", async () => {
  expect(inject).toContain("subagents");
  const signal = new AbortController().signal;
  const rows = [
    {
      activity: "running",
      depth: 1,
      hasChildren: false,
      id: "child-1",
      kind: "child",
      mode: "continuable",
      parentId: "root",
      label: "Research",
    },
  ] as unknown as readonly SubagentDescendantListEntry[];
  const listDescendants = vi.fn(async () => rows);
  const context = {
    subagents: { listDescendants },
  } as unknown as Context;
  const provider = createDshSessionSubagentProvider(context);
  expect(provider).toBeDefined();
  await expect(provider?.listDescendants("root", signal)).resolves.toBe(rows);
  expect(listDescendants).toHaveBeenCalledWith(SessionId("root"), signal);
});

test("does not advertise a provider when the DSH service is absent", () => {
  expect(createDshSessionSubagentProvider({} as Context)).toBeUndefined();
});

test("does not require or advertise plan mode when the optional service is absent", () => {
  const get = vi.fn(() => undefined);
  const context = { get } as unknown as Context;

  expect(inject).not.toContain("planMode");
  expect(createDshPlanModeProvider(context)).toBeUndefined();
  expect(get).toHaveBeenCalledWith("planMode");
});

test("uses the optional plan mode service when it is present", () => {
  const agent = {} as Agent;
  const planMode = {
    get: vi.fn(() => ({ active: true })),
    set: vi.fn(() => "committed" as const),
  };
  const context = {
    get: vi.fn((name: string) => (name === "planMode" ? planMode : undefined)),
  } as unknown as Context;

  const provider = createDshPlanModeProvider(context);
  expect(provider).toBeDefined();
  expect(provider?.get(agent)).toEqual({ active: true });
  expect(provider?.set(agent, false)).toBe("committed");
  expect(planMode.get).toHaveBeenCalledWith(agent);
  expect(planMode.set).toHaveBeenCalledWith(agent, false);
});

test("reads and writes alpha.5 permission presets through the live Session", async () => {
  const session = { events: [] };
  const current = vi.fn(() => "workspace-write");
  const set = vi.fn();
  const context = {
    permissionPresets: {
      current,
      names: ["workspace-write", "danger-full-access"],
      optionOf: (value: string) => ({ name: value, value }),
      set,
    },
    sessions: { get: vi.fn(() => session) },
  } as unknown as Context;

  const provider = createDshPermissionProvider(context);

  expect(provider.describe("session-1")).toMatchObject({
    currentValue: "workspace-write",
    id: "permissions",
    options: [{ value: "workspace-write" }, { value: "danger-full-access" }],
  });
  expect(current).toHaveBeenCalledWith(session);
  await provider.set("session-1", "danger-full-access");
  expect(set).toHaveBeenCalledWith(session, "danger-full-access");
});

test("enables raw recording only for the explicit server development flag", () => {
  expect(isRawDshEventRecordingEnabled({ ORBIS_DSH_RAW_EVENT_RECORDING: "1" })).toBe(true);
  expect(isRawDshEventRecordingEnabled({ ORBIS_DSH_RAW_EVENT_RECORDING: "0" })).toBe(false);
  expect(isRawDshEventRecordingEnabled({})).toBe(false);
});

test("subscribes the recorder beside the adapter at the native DSH event boundary", () => {
  let listener: ((session: { id: unknown }, event: unknown) => void) | undefined;
  const remove = vi.fn();
  const context = {
    on: vi.fn((name: string, next: typeof listener) => {
      expect(name).toBe("session/event");
      listener = next;
      return remove;
    }),
  } as unknown as Context;
  const capture = vi.fn();
  const event = { type: "message.delta", payload: { text: "raw" } };

  const unsubscribe = subscribeRawDshEventRecorder(context, { capture });
  listener?.({ id: SessionId("native-session") }, event);
  unsubscribe();

  expect(capture).toHaveBeenCalledWith("native-session", event);
  expect(remove).toHaveBeenCalledOnce();
});

test("creates replay sessions through the real DSH backend and appends on the live session", async () => {
  const ref = {
    backendId: "dsh-host",
    driverId: "dsh",
    nativeSessionId: "replay-session",
    sessionId: "replay-session",
  };
  const append = vi.fn(() => ({ seq: 3 }));
  const session = {
    append,
    id: SessionId("replay-session"),
    seq: 3,
    snapshotEvents: () => [
      { data: { prefix: 0 }, seq: 0, time: 1, type: "test/prefix" },
      { data: { prefix: 1 }, seq: 1, time: 2, type: "test/prefix" },
      { data: { prefix: 2 }, seq: 2, time: 3, type: "test/prefix" },
    ],
  };
  const flush = vi.fn(async () => undefined);
  const announceCatalogChanged = vi.fn();
  const observeSessionSubscription = vi.fn(() => () => undefined);
  const rename = vi.fn(() => undefined);
  const host = {
    isSessionSubscribed: vi.fn(() => true),
    nativeBackend: {
      announceCatalogChanged,
      getDshDriver: () => ({
        createSession: vi.fn(async () => ({ ref })),
        listWorkspaces: vi.fn(async () => [{ displayName: "Workspace", ref: "workspace-a" }]),
      }),
    },
    observeSessionSubscription,
  } as unknown as OrbisRemoteDshHost;
  const context = {
    sessionTitle: { rename },
    sessions: {
      flush,
      get: vi.fn(() => session),
    },
  } as unknown as Context;

  const target = await createRawDshEventReplayPort(context, () => host).createSession();
  const event = {
    data: { message: "hello" },
    seq: 3,
    sourceEventSeqs: [1, 2],
    surfaceOp: "append" as const,
    type: "assistant/message",
  };

  expect(target).toMatchObject({ initialSeq: 3, sessionId: "replay-session" });
  expect(target.isSubscribed()).toBe(true);
  target.prepare([
    {
      data: {
        content: [{ text: "hello", type: "text" }],
        source: { kind: "user" },
      },
      seq: 3,
      type: "user/message",
    },
    {
      data: { messageSeqs: [3], source: { kind: "fallback" }, title: "Hello" },
      seq: 4,
      type: "session/title",
    },
  ]);
  expect(rename).toHaveBeenCalledWith(session, "Hello");
  target.announce();
  expect(target.append(event)).toBe(3);
  expect(append).toHaveBeenCalledWith("assistant/message", event.data, {
    sourceEventSeqs: [1, 2],
    surfaceOp: "append",
  });
  await target.flush();
  expect(flush).toHaveBeenCalledWith(session);
  expect(announceCatalogChanged).toHaveBeenCalledWith(ref);
});
