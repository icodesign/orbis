import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  activeAtToken,
  formatFileMention,
  type FileReferenceCandidate,
} from "@deepseek-ai/dsh-file-reference";
import {
  formatSessionReferenceMention,
  type SessionReferenceCandidate,
} from "@deepseek-ai/dsh-session-reference";
import type {
  AgentPromptReferenceCompletionResult,
} from "@orbisapp/orbis-agent-backend";

import type { DshAgent, DshPromptReferenceProvider } from "../adapter";

function lineAtCursor(text: string, cursor: number): { readonly line: string; readonly lineStart: number } {
  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  const lineEnd = text.indexOf("\n", cursor);
  return {
    line: text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd),
    lineStart,
  };
}

function fileCandidates(
  candidates: readonly FileReferenceCandidate[],
  quoted: boolean,
): AgentPromptReferenceCompletionResult["candidates"] {
  return candidates.flatMap((candidate) => {
    const insertText = formatFileMention(candidate, quoted);
    if (insertText === undefined) return [];
    return [{ insertText, kind: candidate.kind, label: candidate.path }];
  });
}

function sessionCandidates(
  candidates: readonly SessionReferenceCandidate[],
): AgentPromptReferenceCompletionResult["candidates"] {
  return candidates.map((candidate) => ({
    ...(candidate.cwd === undefined ? {} : { detail: candidate.cwd }),
    insertText: formatSessionReferenceMention({
      label: candidate.label,
      sessionId: candidate.sessionId,
    }),
    kind: "session" as const,
    label: candidate.label,
  }));
}

export function createDshPromptReferenceProvider(context: Context): DshPromptReferenceProvider {
  const fileReferences = context.fileReferences;
  const sessionReferenceResolver = context.sessionReferenceResolver;
  return {
    async complete(input) {
      const { line, lineStart } = lineAtCursor(input.text, input.cursor);
      const token = activeAtToken(line, input.cursor - lineStart);
      if (token === undefined) return undefined;
      const signal = input.signal ?? new AbortController().signal;
      if (input.source === "files") {
        const candidates = await fileReferences.list(
          input.agent as unknown as Agent,
          token.query,
          signal,
        );
        return {
          candidates: fileCandidates(candidates, token.quoted).slice(0, input.limit),
          end: input.cursor,
          start: input.cursor - token.prefix.length,
        };
      }
      const candidates = await sessionReferenceResolver.listCandidates(
        input.agent as unknown as Agent,
        token.query,
        input.limit,
        signal,
      );
      return {
        candidates: sessionCandidates(candidates),
        end: input.cursor,
        start: input.cursor - token.prefix.length,
      };
    },
  };
}
