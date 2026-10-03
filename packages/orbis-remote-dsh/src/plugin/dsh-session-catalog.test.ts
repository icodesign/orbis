import { SessionId } from "@deepseek-ai/dsh-session";
import { describe, expect, test } from "vitest";

import {
  listDshSessionCatalog,
  type DshCatalogHeader,
  type DshCatalogPersistence,
  type DshSessionProjectionCache,
} from "./dsh-session-catalog";

function header(
  id: string,
  createdAt: number,
  extra: Partial<DshCatalogHeader> = {},
): DshCatalogHeader {
  return { version: 4, createdAt, id: SessionId(id), isSeeded: false, ...extra };
}

function snapshot(headerValue: DshCatalogHeader) {
  return { header: headerValue, revision: `revision:${String(headerValue.id)}` };
}

describe("DSH session catalog", () => {
  test("reads title and list metadata from the zero-I/O projection cache", async () => {
    const cacheCalls: Array<{ id: unknown; keys?: readonly string[] }> = [];
    const inspectCalls: unknown[] = [];
    const persistence: DshCatalogPersistence & { inspect(): Promise<never> } = {
      inspect: async () => {
        inspectCalls.push(true);
        throw new Error("catalog must not inspect a transcript");
      },
      list: async () => [snapshot(header("named", 10)), snapshot(header("untitled", 20))],
    };
    const projectionCache: DshSessionProjectionCache = {
      cachedSnapshot: (listedHeader, keys) => {
        if (keys !== undefined) new Set(keys);
        cacheCalls.push({ id: listedHeader.id, keys });
        return listedHeader.id === "named"
          ? {
              asOfSeq: -1,
              values: {
                sessionListMetadata: { blank: false, lastPromptAt: 100 },
                title: "  Existing DSH title  ",
              },
            }
          : { asOfSeq: -1, values: { sessionListMetadata: { blank: true, lastPromptAt: null } } };
      },
    };

    await expect(listDshSessionCatalog(persistence, projectionCache)).resolves.toEqual([
      { createdAt: 10, id: "named", title: "Existing DSH title", updatedAt: 100 },
      { createdAt: 20, id: "untitled", updatedAt: 20 },
    ]);
    expect(cacheCalls).toEqual([
      { id: "named", keys: undefined },
      { id: "untitled", keys: undefined },
    ]);
    expect(inspectCalls).toHaveLength(0);
  });

  test("keeps a catalog row when the cache lookup is unavailable", async () => {
    const persistence: DshCatalogPersistence = {
      list: async () => [snapshot(header("legacy", 10))],
    };
    const projectionCache: DshSessionProjectionCache = {
      cachedSnapshot: () => {
        throw new Error("stale cache");
      },
    };

    await expect(listDshSessionCatalog(persistence, projectionCache)).resolves.toEqual([
      { createdAt: 10, id: "legacy", updatedAt: 10 },
    ]);
  });

  test("hides subagent-origin rows while retaining ordinary parent-session forks", async () => {
    const cachedIds: unknown[] = [];
    const persistence: DshCatalogPersistence = {
      list: async () => [
        snapshot(header("child", 10, { origin: "subagent", parentSession: SessionId("root") })),
        snapshot(header("fork", 20, { parentSession: SessionId("root") })),
      ],
    };
    const projectionCache: DshSessionProjectionCache = {
      cachedSnapshot: (listedHeader) => {
        cachedIds.push(listedHeader.id);
        return { asOfSeq: -1, values: { title: "Fork title" } };
      },
    };

    await expect(listDshSessionCatalog(persistence, projectionCache)).resolves.toEqual([
      {
        createdAt: 20,
        id: "fork",
        parentSession: SessionId("root"),
        title: "Fork title",
        updatedAt: 20,
      },
    ]);
    expect(cachedIds).toEqual(["fork"]);
  });

  test("reads seeded session titles using the cache lifecycle identity", async () => {
    const cachedIds: unknown[] = [];
    const seeded = header("seeded", 450, { isSeeded: true, parentSession: SessionId("root") });
    const persistence: DshCatalogPersistence = {
      list: async () => [snapshot(seeded)],
    };
    const projectionCache: DshSessionProjectionCache = {
      cachedSnapshot: (listedHeader) => {
        cachedIds.push(listedHeader.id);
        return {
          asOfSeq: -1,
          values: {
            sessionListMetadata: { blank: false, lastPromptAt: 900 },
            title: "Fork title",
          },
        };
      },
    };

    await expect(listDshSessionCatalog(persistence, projectionCache)).resolves.toEqual([
      {
        createdAt: 450,
        id: "seeded",
        parentSession: SessionId("root"),
        title: "Fork title",
        updatedAt: 900,
      },
    ]);
    expect(cachedIds).toEqual(["seeded"]);
  });

  test("uses the official predecessor title hint when the current cache row is unavailable", async () => {
    const persistence: DshCatalogPersistence = {
      list: async () => [snapshot(header("legacy-title", 100))],
    };
    const projectionCache: DshSessionProjectionCache = {
      cachedSnapshot: () => undefined,
      cachedPredecessorTitle: () => ({
        asOfSeq: -1,
        values: { title: "Cached predecessor title" },
      }),
    };

    await expect(listDshSessionCatalog(persistence, projectionCache)).resolves.toEqual([
      {
        createdAt: 100,
        id: "legacy-title",
        title: "Cached predecessor title",
        updatedAt: 100,
      },
    ]);
  });
});
