export const KEYLESS_REPLAY_TEXT = "ORBIS_KEYLESS_E2E_OK";

export type RealProfileProviderMode = "live" | "replay";

export interface RealProfileOverlayOptions {
  readonly agentStatePath: string;
  readonly hostStatePath: string;
  readonly logPath: string;
  readonly providerMode: RealProfileProviderMode;
  readonly replayFixturePath: string;
  readonly replayModulePath: string;
  readonly workspaceRoot: string;
}

/** Keep malformed configured credentials on the live lane so they fail visibly. */
export function realProfileProviderMode(apiKey: string | undefined): RealProfileProviderMode {
  return apiKey === undefined || apiKey.length === 0 ? "replay" : "live";
}

/** Build the disposable profile overlay shared by initial boot and restart. */
export function createRealProfileOverlay(options: RealProfileOverlayOptions): string {
  const lines =
    options.providerMode === "replay"
      ? [
          "- id: llm-deepseek",
          '  name: "@deepseek-ai/dsh-llm-deepseek"',
          "  disabled: true",
          "- id: session-title-llm",
          '  name: "@deepseek-ai/dsh-session-title-first-prompt-llm"',
          "  disabled: true",
          "- insert:",
          "    - id: orbis-e2e-llm-replay",
          `      name: ${JSON.stringify(options.replayModulePath)}`,
          "      config:",
          `        file: ${JSON.stringify(options.replayFixturePath)}`,
          "        providers:",
          "          - id: deepseek-official",
          '            name: "DeepSeek Replay"',
          "            models:",
          "              - id: deepseek-v4-flash",
          "                contextWindow: 128000",
          "              - id: deepseek-v4-pro",
          "                contextWindow: 128000",
        ]
      : [];
  lines.push(
    "- id: orbis-remote",
    "  config:",
    `    statePath: ${JSON.stringify(options.hostStatePath)}`,
    `    agentStatePath: ${JSON.stringify(options.agentStatePath)}`,
    `    logPath: ${JSON.stringify(options.logPath)}`,
    "    workspaceRoots:",
    `      - ${JSON.stringify(options.workspaceRoot)}`,
    "",
  );
  return lines.join("\n");
}
