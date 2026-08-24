import { describe, expect, test } from "vitest";

import { createAgentSessionRef } from "./identifiers";
import {
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
  test("keeps UTF-16 cursor and multiline replacement ranges", () => {
    const validated = validateAgentPromptReferenceCompletionInput({
      ...input,
      cursor: "你好 @src".length,
      text: "你好\n@src",
    });
    expect(validated.cursor).toBe(7);
    expect(validated.text).toBe("你好\n@src");
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
