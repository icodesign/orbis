import type { Context } from "@deepseek-ai/cordis";
import { goalProjectionDefinition } from "@deepseek-ai/dsh-goal";
import { planProjectionDefinition, type PlanUnitState } from "@deepseek-ai/dsh-plan-mode";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import { apply as applyTodo } from "@deepseek-ai/dsh-tool-todo";
import type { TodoItem } from "@deepseek-ai/dsh-tool-todo";

import type { DshSessionEvent, DshSessionProjectionValues } from "../adapter/dsh-types";

let todosDefinition: ProjectionDefinition<"todos", TodoItem[] | null>;
applyTodo(
  {
    sessionProjections: {
      register: (definition: typeof todosDefinition) => {
        todosDefinition = definition;
      },
    },
    tools: { register: () => {} },
  } as unknown as Context,
  { allowParallelInProgress: false },
);

/** Fixtures use upstream domain folds, never a second Orbis implementation. */
export function nativeWorkStateValues(
  events: readonly DshSessionEvent[],
): DshSessionProjectionValues {
  let plan: PlanUnitState = planProjectionDefinition.init();
  let goal: Parameters<typeof goalProjectionDefinition.apply>[0] = goalProjectionDefinition.init();
  let todos: TodoItem[] | null = null;
  for (const event of events) {
    const native = event as SessionEvent;
    plan = planProjectionDefinition.apply(plan, native);
    goal = goalProjectionDefinition.apply(goal, native);
    todos = todosDefinition.apply(todos, native);
  }
  return {
    plan: planProjectionDefinition.wire.viewSchema.parse(planProjectionDefinition.wire.view(plan)),
    goal: goalProjectionDefinition.wire.viewSchema.parse(goalProjectionDefinition.wire.view(goal)),
    todos: todosDefinition.wire!.viewSchema.parse(todosDefinition.wire!.view(todos)),
  };
}
