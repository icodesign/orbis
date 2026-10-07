import { Context } from "@deepseek-ai/cordis";
import { goalProjectionDefinition } from "@deepseek-ai/dsh-goal";
import { planProjectionDefinition, type PlanUnitState } from "@deepseek-ai/dsh-plan-mode";
import { SessionLogOffset, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import { apply as applyTodo } from "@deepseek-ai/dsh-tool-todo";
import type { TodoItem } from "@deepseek-ai/dsh-tool-todo";
import { UserQuestionService } from "@deepseek-ai/dsh-user-questions";

import type { DshSessionEvent, DshSessionProjectionValues } from "../adapter/dsh-types";

let todosDefinition: ProjectionDefinition<"todos", TodoItem[] | null>;
const questionContext = new Context();
const questionsRegistered = new Promise<ProjectionDefinition<"userQuestions">>((resolve) => {
  questionContext.provide("sessionProjections", {
    register: resolve,
  } as unknown as Context["sessionProjections"]);
});
new UserQuestionService(questionContext);
const questionsDefinition = await questionsRegistered;
await questionContext.fiber.dispose();
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
  let questions = questionsDefinition.init({} as SessionHeader, SessionLogOffset(0));
  for (const event of events) {
    const native = event as SessionEvent;
    plan = planProjectionDefinition.apply(plan, native);
    goal = goalProjectionDefinition.apply(goal, native);
    todos = todosDefinition.apply(todos, native);
    questions = questionsDefinition.apply(questions, native);
  }
  return {
    plan: planProjectionDefinition.wire.viewSchema.parse(planProjectionDefinition.wire.view(plan)),
    goal: goalProjectionDefinition.wire.viewSchema.parse(goalProjectionDefinition.wire.view(goal)),
    todos: todosDefinition.wire!.viewSchema.parse(todosDefinition.wire!.view(todos)),
    userQuestions: questionsDefinition.wire!.viewSchema.parse(
      questionsDefinition.wire!.view(questions),
    ),
  };
}
