import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { expect, test, vi } from "vitest";

import type { DshAgent } from "../adapter";
import { createDshPromptReferenceProvider } from "./dsh-prompt-reference-provider";

const agent = { id: "current", session: { header: {}, events: [] } } as unknown as DshAgent;

function contextFor(
  fileReferences: { list: (...args: never[]) => Promise<unknown[]> },
  sessionReferenceResolver: { listCandidates: (...args: never[]) => Promise<unknown[]> },
  sessionQuery: {
    listSessions: (...args: never[]) => Promise<unknown[]>;
    readTitleSnapshots: (...args: never[]) => Promise<unknown[]>;
  } = { listSessions: async () => [], readTitleSnapshots: async () => [] },
): Context {
  return { fileReferences, sessionQuery, sessionReferenceResolver } as unknown as Context;
}

test("maps quoted file candidates and preserves multiline replacement boundaries", async () => {
  const signal = new AbortController().signal;
  const list = vi.fn(async () => [
    { kind: "directory", path: "src/lib" },
    { kind: "file", path: "README.md" },
    { kind: "file", path: 'unsafe"name' },
  ]);
  const provider = createDshPromptReferenceProvider(
    contextFor({ list }, { listCandidates: async () => [] }),
  );
  const result = await provider.complete({
    agent,
    cursor: '你好\n@"src'.length,
    limit: 8,
    signal,
    source: "files",
    text: '你好\n@"src',
  });
  expect(result).toMatchObject({ end: 8, start: 3 });
  expect(result?.candidates).toEqual([
    { insertText: '@"src/lib/', kind: "directory", label: "src/lib" },
    { insertText: '@"README.md"', kind: "file", label: "README.md" },
  ]);
  expect(list).toHaveBeenCalledWith(agent, "src", signal);
});

test("does not trigger on email-like text and uses canonical session mentions", async () => {
  const listCandidates = vi.fn(async () => [
    { createdAt: 1, cwd: "/work", label: "Build notes", sessionId: "session-2" },
  ]);
  const provider = createDshPromptReferenceProvider(
    contextFor({ list: async () => [] }, { listCandidates }),
  );
  await expect(
    provider.complete({
      agent,
      cursor: 13,
      limit: 4,
      source: "sessions",
      text: "mail a@b.test",
    }),
  ).resolves.toBeUndefined();
  const signal = new AbortController().signal;
  const result = await provider.complete({
    agent,
    cursor: 8,
    limit: 1,
    signal,
    source: "sessions",
    text: "Open @Bu",
  });
  expect(result?.candidates[0]).toMatchObject({
    detail: "/work",
    kind: "session",
    label: "Build notes",
  });
  expect(result?.candidates[0]?.insertText).toMatch(/^@\[Build notes\]\(dsh-session:/u);
  expect(listCandidates).toHaveBeenCalledWith(agent, "Bu", 1, signal);
});

test("discovers files directly from a draft workspace", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "orbis-dsh-reference-"));
  try {
    await mkdir(join(workspacePath, "src"));
    await writeFile(join(workspacePath, "README.md"), "test");
    const provider = createDshPromptReferenceProvider(
      contextFor({ list: async () => [] }, { listCandidates: async () => [] }),
    );
    const result = await provider.complete({
      cursor: 1,
      limit: 8,
      source: "files",
      text: "@",
      workspacePath,
    });
    expect(result?.candidates).toEqual([
      { insertText: "@src/", kind: "directory", label: "src" },
      { insertText: "@README.md", kind: "file", label: "README.md" },
    ]);
  } finally {
    await rm(workspacePath, { force: true, recursive: true });
  }
});

test("ranks draft session candidates by workspace without excluding a made-up self", async () => {
  const listSessions = vi.fn(async () => [
    { header: { createdAt: 2, cwd: "/other", id: "other" }, live: false, persisted: true },
    { header: { createdAt: 1, cwd: "/work", id: "same" }, live: false, persisted: true },
  ]);
  const readTitleSnapshots = vi.fn(async () => [
    {
      sessionId: "same",
      status: "fulfilled" as const,
      value: {
        session: { createdAt: 1, cwd: "/work", id: "same" },
        title: { title: "Same workspace" },
      },
    },
    {
      sessionId: "other",
      status: "fulfilled" as const,
      value: {
        session: { createdAt: 2, cwd: "/other", id: "other" },
        title: { title: "Other workspace" },
      },
    },
  ]);
  const provider = createDshPromptReferenceProvider(
    contextFor(
      { list: async () => [] },
      { listCandidates: async () => [] },
      { listSessions, readTitleSnapshots },
    ),
  );
  const result = await provider.complete({
    cursor: 1,
    limit: 2,
    source: "sessions",
    text: "@",
    workspacePath: "/work",
  });
  expect(result?.candidates.map((candidate) => candidate.label)).toEqual([
    "Same workspace",
    "Other workspace",
  ]);
  expect(readTitleSnapshots).toHaveBeenCalledWith(["same", "other"], expect.any(AbortSignal));
});
