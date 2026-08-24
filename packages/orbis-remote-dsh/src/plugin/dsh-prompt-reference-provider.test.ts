import type { Context } from "@deepseek-ai/cordis";
import { expect, test, vi } from "vitest";

import type { DshAgent } from "../adapter";
import { createDshPromptReferenceProvider } from "./dsh-prompt-reference-provider";

const agent = { id: "current", session: { header: {}, events: [] } } as unknown as DshAgent;

function contextFor(
  fileReferences: { list: (...args: never[]) => Promise<unknown[]> },
  sessionReferenceResolver: { listCandidates: (...args: never[]) => Promise<unknown[]> },
): Context {
  return { fileReferences, sessionReferenceResolver } as unknown as Context;
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
    cursor: "你好\n@\"src".length,
    limit: 8,
    signal,
    source: "files",
    text: "你好\n@\"src",
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
