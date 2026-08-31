const POSIX_SHARED_PERMISSION_MASK = 0o077;

/**
 * Reports Unix group/other permission bits only on platforms where Node exposes them.
 * Windows `Stats.mode` is synthesized from file attributes and does not represent the DACL.
 */
export function hasSharedFileMode(
  mode: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32" && (mode & POSIX_SHARED_PERMISSION_MASK) !== 0;
}
