import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SubagentDescendantListEntry } from "@deepseek-ai/dsh-subagent";
import { expect, test, vi } from "vitest";

import {
  createDshAttachmentPort,
  createDshPlanModeProvider,
  createDshSessionSubagentProvider,
  inject,
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
