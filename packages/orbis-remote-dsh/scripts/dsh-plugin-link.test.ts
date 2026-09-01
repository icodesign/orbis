import { describe, expect, it } from "vitest";

import { createDshPluginLinkSpec, ORBIS_DSH_PACKAGE_NAME } from "./dsh-plugin-link";

describe("createDshPluginLinkSpec", () => {
  it("uses one published package identity with an absolute link target", () => {
    expect(createDshPluginLinkSpec("/work/orbis/packages/orbis-remote-dsh")).toBe(
      `${ORBIS_DSH_PACKAGE_NAME}@link:/work/orbis/packages/orbis-remote-dsh`,
    );
  });

  it("normalizes a relative package directory without dropping the package name", () => {
    expect(createDshPluginLinkSpec("packages/orbis-remote-dsh")).toBe(
      `${ORBIS_DSH_PACKAGE_NAME}@link:${process.cwd()}/packages/orbis-remote-dsh`,
    );
  });
});
