import { describe, expect, test } from "vitest";

import { createAgentSessionRef } from "./identifiers";
import {
  isAgentPromptReferenceActive,
  validateAgentPromptReferenceCompletionInput,
  validateAgentPromptReferenceCompletionResult,
} from "./references";

const ref = createAgentSessionRef({
  backendId: "remote:test",
  driverId: "dsh",
  nativeSessionId: "native",
  sessionId: "session",
});

const input = {
  cursor: 8,
  limit: 4,
  ref,
  source: "files" as const,
  text: "See @src",
};

describe("prompt reference completion contract", () => {
  test("only activates at-tokens at a token boundary", () => {
    const active = (text: string, cursor = text.length) =>
      isAgentPromptReferenceActive({ cursor, syntax: "at-token", text });

    expect(active("@")).toBe(true);
    expect(active("See @src")).toBe(true);
    expect(active('See @"path with spaces')).toBe(true);
    expect(active("first line\n@src")).toBe(true);
    expect(active("plain text")).toBe(false);
    expect(active("name@example.com")).toBe(false);
    expect(active("@src trailing")).toBe(false);
    expect(active("@src trailing", 4)).toBe(true);
  });

  test("keeps UTF-16 cursor and multiline replacement ranges", () => {
    const validated = validateAgentPromptReferenceCompletionInput({
      ...input,
      cursor: "你好 @src".length,
      text: "你好\n@src",
    });
    expect(validated.cursor).toBe(7);
    expect(validated.text).toBe("你好\n@src");
  });

  test("accepts a draft workspace target without manufacturing a session ref", () => {
    const validated = validateAgentPromptReferenceCompletionInput({
      cursor: 1,
      driverId: "dsh",
      limit: 4,
      source: "files",
      text: "@",
      workspaceRef: "workspace:project",
    });
    expect(validated).toMatchObject({
      driverId: "dsh",
      workspaceRef: "workspace:project",
    });
    expect("ref" in validated).toBe(false);
  });

  test("rejects missing and ambiguous completion targets", () => {
    expect(() =>
      validateAgentPromptReferenceCompletionInput({
        cursor: 1,
        limit: 4,
        source: "files",
        text: "@",
      }),
    ).toThrow(/target/u);
    expect(() =>
      validateAgentPromptReferenceCompletionInput({
        ...input,
        driverId: "dsh",
        workspaceRef: "workspace:project",
      }),
    ).toThrow(/ambiguous/u);
  });

  test("validates source-specific candidates and bounds", () => {
    const validated = validateAgentPromptReferenceCompletionInput(input);
    expect(
      validateAgentPromptReferenceCompletionResult(
        {
          candidates: [
            { insertText: "@src/", kind: "directory", label: "src" },
            { insertText: "@README.md", kind: "file", label: "README.md" },
          ],
          end: 8,
          start: 4,
        },
        validated,
      ),
    ).toMatchObject({ start: 4, end: 8 });
    expect(() =>
      validateAgentPromptReferenceCompletionResult(
        {
          candidates: [{ insertText: "@[other](dsh-session:x)", kind: "session", label: "other" }],
          end: 8,
          start: 4,
        },
        validated,
      ),
    ).toThrow(/source/u);
  });

  test("rejects unsafe text, invalid cursor, and duplicate insertions", () => {
    expect(() =>
      validateAgentPromptReferenceCompletionInput({ ...input, text: "bad\u0000text" }),
    ).toThrow();
    expect(() => validateAgentPromptReferenceCompletionInput({ ...input, cursor: 99 })).toThrow();
    const validated = validateAgentPromptReferenceCompletionInput(input);
    expect(() =>
      validateAgentPromptReferenceCompletionResult(
        {
          candidates: [
            { insertText: "@same", kind: "file", label: "a" },
            { insertText: "@same", kind: "file", label: "b" },
          ],
          end: 8,
          start: 4,
        },
        validated,
      ),
    ).toThrow(/unique/u);
  });

  test("returns undefined for no active token result", () => {
    expect(validateAgentPromptReferenceCompletionResult(undefined, input)).toBeUndefined();
  });
});
