import { describe, expect, it } from "vitest";

import { createRealProfileOverlay, realProfileProviderMode } from "./real-profile-e2e-provider";

const paths = {
  agentStatePath: "/fixture/agent-state.json",
  hostStatePath: "/fixture/host-state.json",
  logPath: "/fixture/debug.jsonl",
  replayFixturePath: "/package/fixtures/keyless.jsonl",
  replayModulePath: "/package/node_modules/dsh-llm-replay/lib/index.js",
  workspaceRoot: "/fixture/workspace",
};

describe("real-profile provider lane", () => {
  it("uses replay only when the credential is actually absent", () => {
    expect(realProfileProviderMode(undefined)).toBe("replay");
    expect(realProfileProviderMode("")).toBe("replay");
    expect(realProfileProviderMode("configured-key")).toBe("live");
    expect(realProfileProviderMode(" ")).toBe("live");
  });

  it("replaces only the LLM seam in keyless mode", () => {
    const overlay = createRealProfileOverlay({ ...paths, providerMode: "replay" });

    expect(overlay).toContain("- id: llm-deepseek\n");
    expect(overlay).toContain("- id: session-title-llm\n");
    expect(overlay).toContain("- id: orbis-e2e-llm-replay\n");
    expect(overlay).toContain("          - id: deepseek-official\n");
    expect(overlay).toContain("              - id: deepseek-v4-flash\n");
    expect(overlay).toContain("              - id: deepseek-v4-pro\n");
    expect(overlay).toContain("- id: orbis-remote\n");
    expect(overlay).toContain('    workspaceRoots:\n      - "/fixture/workspace"\n');
  });

  it("leaves the shipped provider composition intact in live mode", () => {
    const overlay = createRealProfileOverlay({ ...paths, providerMode: "live" });

    expect(overlay).not.toContain("llm-deepseek");
    expect(overlay).not.toContain("llm-replay");
    expect(overlay).toContain("- id: orbis-remote\n");
  });
});
