import { describe, expect, it } from "vitest";

import { parseDshSelection } from "./serve-dsh-source";

describe("parseDshSelection", () => {
  it("keeps the package-local CLI as the default", () => {
    expect(parseDshSelection(undefined, undefined)).toEqual({ kind: "default" });
  });

  it("parses every supported source kind", () => {
    expect(parseDshSelection("local:../deepseek-harness", undefined, "/work/orbis")).toEqual({
      kind: "local",
      directory: "/work/deepseek-harness",
    });
    expect(parseDshSelection("github:tag:dsh-v0.1.2-rc.1", undefined)).toEqual({
      kind: "github-tag",
      tag: "dsh-v0.1.2-rc.1",
    });
    expect(
      parseDshSelection("github:commit:dd6322d604e00eec1ba5e0c8541159906a21094a", undefined),
    ).toEqual({
      kind: "github-commit",
      commit: "dd6322d604e00eec1ba5e0c8541159906a21094a",
    });
    expect(parseDshSelection("npm:next", undefined)).toEqual({
      kind: "npm",
      selector: "next",
    });
    expect(parseDshSelection("bin:dsh", undefined)).toEqual({
      kind: "binary",
      command: "dsh",
    });
  });

  it("retains --dsh-bin as an explicit binary selector", () => {
    expect(parseDshSelection(undefined, "/opt/dsh")).toEqual({
      kind: "binary",
      command: "/opt/dsh",
    });
  });

  it("rejects ambiguous and malformed selectors", () => {
    expect(() => parseDshSelection("npm:latest", "dsh")).toThrow(
      "--dsh and --dsh-bin are mutually exclusive",
    );
    expect(() => parseDshSelection("github:commit:main", undefined)).toThrow(
      "invalid DSH GitHub commit",
    );
    expect(() => parseDshSelection("npm:^0.1.0", undefined)).toThrow(
      "invalid DSH npm tag or version",
    );
    expect(() => parseDshSelection("github:branch:main", undefined)).toThrow(
      "unsupported DSH selector",
    );
  });
});
