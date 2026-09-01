import { resolve } from "node:path";

/** The published package name is also the identity used by DSH profile links. */
export const ORBIS_DSH_PACKAGE_NAME = "@orbisapp/remote-dsh" as const;

/** Build the named pnpm link spec accepted by DSH's plugin installer. */
export function createDshPluginLinkSpec(packageDirectory: string): string {
  return `${ORBIS_DSH_PACKAGE_NAME}@link:${resolve(packageDirectory)}`;
}
