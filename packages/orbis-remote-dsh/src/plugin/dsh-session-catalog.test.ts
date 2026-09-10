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
  return { createdAt, id, isSeeded: false, ...extra };
}

function snapshot(headerValue: DshCatalogHeader) {
  return { header: headerValue, revision: `revision:${String(headerValue.id)}` };
}

describe("DSH session catalog", () => {
  test("reads title and list metadata from the zero-I/O projection cache", async () => {
    const cacheCalls: Array<{ id: unknown; inheritedEventCount: number }> = [];
    const inspectCalls: unknown[] = [];
    const persistence: DshCatalogPersistence & { inspect(): Promise<never> } = {
      inspect: async () => {
        inspectCalls.push(true);
        throw new Error("catalog must not inspect a transcript");
      },
      list: async () => [snapshot(header("named", 10)), snapshot(header("untitled", 20))],
    };
    const projectionCache: DshSessionProjectionCache = {
      cachedSnapshot: (listedHeader, inheritedEventCount) => {
        cacheCalls.push({ id: listedHeader.id, inheritedEventCount });
        return listedHeader.id === "named"
          ? {
              values: {
                sessionListMetadata: { blank: false, lastPromptAt: 100 },
                title: "  Existing DSH title  ",
              },
            }
          : { values: { sessionListMetadata: { blank: true, lastPromptAt: null } } };
      },
    };

    await expect(listDshSessionCatalog(persistence, projectionCache)).resolves.toEqual([
      { createdAt: 10, id: "named", title: "Existing DSH title", updatedAt: 100 },
      { createdAt: 20, id: "untitled", updatedAt: 20 },
    ]);
    expect(cacheCalls).toEqual([
      { id: "named", inheritedEventCount: 0 },
      { id: "untitled", inheritedEventCount: 0 },
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
        snapshot(header("child", 10, { origin: "subagent", parentSession: "root" })),
        snapshot(header("fork", 20, { parentSession: "root" })),
      ],
    };
    const projectionCache: DshSessionProjectionCache = {
      cachedSnapshot: (listedHeader) => {
        cachedIds.push(listedHeader.id);
        return { values: { title: "Fork title" } };
      },
    };

    await expect(listDshSessionCatalog(persistence, projectionCache)).resolves.toEqual([
      {
        createdAt: 20,
        id: "fork",
        parentSession: "root",
        title: "Fork title",
        updatedAt: 20,
      },
    ]);
    expect(cachedIds).toEqual(["fork"]);
  });

  test("skips the cache for seeded sessions whose inherited cut is absent from list metadata", async () => {
    const cachedIds: unknown[] = [];
    const seeded = header("seeded", 450, { isSeeded: true, parentSession: "root" });
    const persistence: DshCatalogPersistence = {
      list: async () => [snapshot(seeded)],
    };
    const projectionCache: DshSessionProjectionCache = {
      cachedSnapshot: (listedHeader) => {
        cachedIds.push(listedHeader.id);
        return {
          values: {
            sessionListMetadata: { blank: false, lastPromptAt: 900 },
            title: "wrong",
          },
        };
      },
    };

    await expect(listDshSessionCatalog(persistence, projectionCache)).resolves.toEqual([
      { createdAt: 450, id: "seeded", parentSession: "root", updatedAt: 450 },
    ]);
    expect(cachedIds).toEqual([]);
  });

  test("uses the official predecessor title hint when the current cache row is unavailable", async () => {
    const persistence: DshCatalogPersistence = {
      list: async () => [snapshot(header("legacy-title", 100))],
    };
    const projectionCache: DshSessionProjectionCache = {
      cachedSnapshot: () => undefined,
      cachedPredecessorTitle: () => ({ values: { title: "Cached predecessor title" } }),
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
