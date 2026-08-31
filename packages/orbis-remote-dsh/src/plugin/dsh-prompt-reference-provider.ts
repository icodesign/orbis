import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  activeAtToken,
  formatFileMention,
  type FileReferenceCandidate,
} from "@deepseek-ai/dsh-file-reference";
import {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  WorkspaceFileSearch,
} from "@deepseek-ai/dsh-file-reference-local/search";
import type { SessionRecord, SessionTitleObservationResult } from "@deepseek-ai/dsh-session-query";
import {
  formatSessionReferenceMention,
  type SessionReferenceCandidate,
} from "@deepseek-ai/dsh-session-reference";
import type { AgentPromptReferenceCompletionResult } from "@orbisapp/orbis-agent-backend";

import type { DshPromptReferenceProvider } from "../adapter";

function lineAtCursor(
  text: string,
  cursor: number,
): { readonly line: string; readonly lineStart: number } {
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

function candidateRank(cwd: string | undefined, targetCwd: string): number {
  return cwd === targetCwd ? 0 : cwd === undefined ? 1 : 2;
}

async function draftSessionCandidates(input: {
  readonly context: Context;
  readonly limit: number;
  readonly query: string;
  readonly signal: AbortSignal;
  readonly workspacePath: string;
}): Promise<SessionReferenceCandidate[]> {
  input.signal.throwIfAborted();
  const needle = input.query.toLocaleLowerCase();
  const records = (await input.context.sessionQuery.listSessions(input.signal)).map(
    (record, index) => ({ index, record }),
  );
  const inspected =
    needle === ""
      ? records
          .sort(
            (left, right) =>
              candidateRank(left.record.header.cwd, input.workspacePath) -
                candidateRank(right.record.header.cwd, input.workspacePath) ||
              left.index - right.index,
          )
          .slice(0, input.limit)
      : records;
  const observations = await input.context.sessionQuery.readTitleSnapshots(
    inspected.map(({ record }) => record.header.id),
    input.signal,
  );
  return inspected
    .map(({ index, record }, observationIndex) => ({
      index,
      label: titleForRecord(record, observations[observationIndex]),
      record,
    }))
    .filter(({ label, record }) => {
      if (needle === "") return true;
      return (
        String(record.header.id).toLocaleLowerCase().includes(needle) ||
        record.header.cwd?.toLocaleLowerCase().includes(needle) === true ||
        label.toLocaleLowerCase().includes(needle)
      );
    })
    .sort(
      (left, right) =>
        candidateRank(left.record.header.cwd, input.workspacePath) -
          candidateRank(right.record.header.cwd, input.workspacePath) || left.index - right.index,
    )
    .slice(0, input.limit)
    .map(({ label, record }) => ({
      createdAt: record.header.createdAt,
      ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
      label,
      sameWorkspace: record.header.cwd === input.workspacePath,
      sessionId: record.header.id,
    }));
}

function titleForRecord(
  record: SessionRecord,
  observation: SessionTitleObservationResult | undefined,
): string {
  return observation?.status === "fulfilled"
    ? (observation.value.title?.title ?? String(record.header.id))
    : String(record.header.id);
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
        const candidates = await (async () => {
          if ("agent" in input) {
            return fileReferences.list(input.agent as unknown as Agent, token.query, signal);
          }
          const search = new WorkspaceFileSearch(input.workspacePath, {
            excludedDirectories: DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
            maxEntries: DEFAULT_FILE_SEARCH_MAX_ENTRIES,
            maxResults: input.limit,
          });
          try {
            return await search.list(token.query, signal);
          } finally {
            search.dispose();
          }
        })();
        return {
          candidates: fileCandidates(candidates, token.quoted).slice(0, input.limit),
          end: input.cursor,
          start: input.cursor - token.prefix.length,
        };
      }
      const candidates =
        "agent" in input
          ? await sessionReferenceResolver.listCandidates(
              input.agent as unknown as Agent,
              token.query,
              input.limit,
              signal,
            )
          : await draftSessionCandidates({
              context,
              limit: input.limit,
              query: token.query,
              signal,
              workspacePath: input.workspacePath,
            });
      return {
        candidates: sessionCandidates(candidates),
        end: input.cursor,
        start: input.cursor - token.prefix.length,
      };
    },
  };
}
