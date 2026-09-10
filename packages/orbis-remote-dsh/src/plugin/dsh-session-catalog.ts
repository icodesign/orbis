/** The stable metadata surface exposed by DSH's durable session listing. */
export interface DshCatalogHeader {
  readonly createdAt: number;
  readonly id: unknown;
  /** Whether the session has a fork-inherited event prefix. */
  readonly isSeeded: boolean;
  readonly origin?: "subagent";
  readonly parentSession?: unknown;
}

/** The V3 persistence observation returned by DSH's metadata-only list API. */
export interface DshCatalogSnapshot {
  readonly eventCount?: number;
  readonly header: DshCatalogHeader;
  readonly revision: unknown;
  readonly sizeBytes?: number;
}

export interface DshCatalogPersistence {
  list(): Promise<readonly DshCatalogSnapshot[]>;
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
    inheritedEventCount: number,
    keys?: readonly string[],
  ): DshProjectionSnapshot | undefined;
  /** Read a predecessor title when the current checkpoint uses an older schema. */
  cachedPredecessorTitle?(
    header: DshCatalogHeader,
    inheritedEventCount: number,
  ): DshProjectionSnapshot | undefined;
}

interface DshProjectionSnapshot {
  readonly values: Readonly<Record<string, unknown>>;
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
  const snapshots = (await persistence.list()).filter(({ header }) => header.origin !== "subagent");
  return await Promise.all(
    snapshots.map(async ({ header }) => {
      const projection = projectionForListing(projectionCache, header);
      const title = titleFromProjection(projection);
      return {
        createdAt: header.createdAt,
        id: header.id,
        ...(header.origin === undefined ? {} : { origin: header.origin }),
        ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
        ...(title === undefined ? {} : { title }),
        updatedAt: updatedAtFromProjection(header, projection),
      };
    }),
  );
}

function projectionForListing(
  projectionCache: DshSessionProjectionCache,
  header: DshCatalogHeader,
): DshProjectionSnapshot | undefined {
  // A cached record is bound to the session's exact inherited prefix length,
  // which a header-only listing does not carry. DSH Web skips the cache for a
  // seeded header rather than guessing a cut; Orbis makes the same call, so an
  // unseeded row stays a hit and a forked row degrades to no title.
  if (header.isSeeded) return undefined;
  try {
    return (
      projectionCache.cachedSnapshot(header, 0) ??
      projectionCache.cachedPredecessorTitle?.(header, 0)
    );
  } catch {
    // The cache is an acceleration layer. A corrupted or unavailable cache
    // row must not turn `sessions.list` into a transcript load or failure.
    return undefined;
  }
}

function titleFromProjection(projection: DshProjectionSnapshot | undefined): string | undefined {
  const value = projection?.values.title;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function updatedAtFromProjection(
  header: DshCatalogHeader,
  projection: DshProjectionSnapshot | undefined,
): number {
  const metadata = projection?.values.sessionListMetadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return header.createdAt;
  }
  const lastPromptAt = (metadata as { readonly lastPromptAt?: unknown }).lastPromptAt;
  return Number.isSafeInteger(lastPromptAt) && (lastPromptAt as number) >= 0
    ? Math.max(header.createdAt, lastPromptAt as number)
    : header.createdAt;
}
