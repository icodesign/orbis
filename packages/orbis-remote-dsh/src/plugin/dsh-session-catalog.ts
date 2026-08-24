import { stat } from "node:fs/promises";

/** The stable metadata surface exposed by DSH's durable session listing. */
export interface DshCatalogHeader {
  readonly createdAt: number;
  readonly id: unknown;
  readonly origin?: "subagent";
  readonly parentSession?: unknown;
}

export interface DshCatalogPersistence {
  list(): Promise<readonly DshCatalogHeader[]>;
  locate?(header: DshCatalogHeader): { readonly path: string } | undefined;
}

/** Structural return shape consumed by the Orbis-local-DSH adapter. */
export interface DshSessionCatalogEntry {
  readonly createdAt: number;
  readonly id: unknown;
  readonly origin?: "subagent";
  readonly parentSession?: unknown;
  readonly title?: string;
  readonly updatedAt: number;
}

/**
 * DSH Web's zero-I/O projection cache. Its title value may lag a newest event,
 * but it is bound to the listed header lifecycle and is never invented.
 */
export interface DshSessionProjectionCache {
  cachedSnapshot(
    header: DshCatalogHeader,
  ): { readonly values: Readonly<Record<string, unknown>> } | undefined;
}

/**
 * Lists durable DSH sessions without loading one transcript. `title` comes
 * only from the persisted projection snapshot, so a missing/stale cache row
 * degrades the display label but can never make catalog availability depend on
 * a historical log being projectable.
 */
export async function listDshSessionCatalog(
  persistence: DshCatalogPersistence,
  projectionCache: DshSessionProjectionCache,
): Promise<readonly DshSessionCatalogEntry[]> {
  const headers = (await persistence.list()).filter((header) => header.origin !== "subagent");
  return await Promise.all(
    headers.map(async (header) => {
      let updatedAt = header.createdAt;
      const path = persistence.locate?.(header)?.path;
      if (path !== undefined) {
        try {
          updatedAt = (await stat(path)).mtimeMs;
        } catch {
          // A concurrent cleanup can remove a materialized log after list().
          // The durable header remains a valid catalog row, ordered by creation.
        }
      }
      const title = titleFromProjectionCache(projectionCache, header);
      return {
        createdAt: header.createdAt,
        id: header.id,
        ...(header.origin === undefined ? {} : { origin: header.origin }),
        ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
        ...(title === undefined ? {} : { title }),
        updatedAt,
      };
    }),
  );
}

function titleFromProjectionCache(
  projectionCache: DshSessionProjectionCache,
  header: DshCatalogHeader,
): string | undefined {
  try {
    const value = projectionCache.cachedSnapshot(header)?.values.title;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    // The cache is an acceleration layer. A corrupted or unavailable cache
    // row must not turn `sessions.list` into a transcript load or failure.
    return undefined;
  }
}
