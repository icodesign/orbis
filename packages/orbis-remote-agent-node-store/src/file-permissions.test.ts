import { describe, expect, test } from "vitest";

import { hasSharedFileMode } from "./file-permissions";

describe("hasSharedFileMode", () => {
  test("detects Unix group and other permission bits", () => {
    expect(hasSharedFileMode(0o100600, "linux")).toBe(false);
    expect(hasSharedFileMode(0o100640, "linux")).toBe(true);
    expect(hasSharedFileMode(0o100604, "darwin")).toBe(true);
  });

  test("does not interpret the synthesized Windows mode as a DACL", () => {
    expect(hasSharedFileMode(0o100666, "win32")).toBe(false);
  });
});
