import type { Context } from "@deepseek-ai/cordis";
import { planProjectionDefinition } from "@deepseek-ai/dsh-plan-mode";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import * as TodoTool from "@deepseek-ai/dsh-tool-todo";
import ToolRuntime from "@deepseek-ai/dsh-tools";

/** Keep native read units available before any Web preset has opened an Agent. */
export async function registerDshReadProjections(context: Context): Promise<void> {
  context.sessionProjections.register(planProjectionDefinition);
  // Todo exposes its projection through its tool plugin. Compose that native
  // owner in private services: only its shared projection reaches the host.
  // Preset tools, prompts, and their todo policy retain their own ownership.
  const readContext = context.isolate("systemPrompt").isolate("tools");
  await readContext.plugin(SystemPrompt);
  await readContext.plugin(ToolRuntime);
  await readContext.plugin(TodoTool, { allowParallelInProgress: true });
}
