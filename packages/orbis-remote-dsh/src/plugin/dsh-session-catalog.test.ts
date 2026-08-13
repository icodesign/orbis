import { describe, expect, test } from "vitest";

import {
  listDshSessionCatalog,
  type DshCatalogPersistence,
  type DshSessionProjectionCache,
} from "./dsh-session-catalog";

describe("DSH session catalog", () => {
  test("reads display titles from the zero-I/O projection cache, never a transcript", async () => {
    let inspectCalls = 0;
    const persistence: DshCatalogPersistence & { inspect(): Promise<never> } = {
      inspect: async () => {
        inspectCalls += 1;
        throw new Error("catalog must not inspect a transcript");
      },
      list: async () => [
        { createdAt: 10, id: "named" },
        { createdAt: 20, id: "untitled" },
      ],
    };
    const projectionCache: DshSessionProjectionCache = {
      cachedSnapshot: (header) =>
        header.id === "named"
          ? { values: { title: "  Existing DSH title  " } }
          : { values: { title: null } },
    };

    await expect(listDshSessionCatalog(persistence, projectionCache)).resolves.toEqual([
      { createdAt: 10, id: "named", title: "Existing DSH title", updatedAt: 10 },
      { createdAt: 20, id: "untitled", updatedAt: 20 },
    ]);
    expect(inspectCalls).toBe(0);
  });

  test("keeps a catalog row when one cache lookup is unavailable", async () => {
    const persistence: DshCatalogPersistence = {
      list: async () => [{ createdAt: 10, id: "legacy" }],
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
});
