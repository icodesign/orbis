import { Context } from "@deepseek-ai/cordis";
import { SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import { expect, test } from "vitest";

import { registerDshReadProjections } from "./dsh-read-projections";

test("native plan and todos survive without a preset and expose no host tools or prompts", async () => {
  const context = new Context();
  await context.plugin(SessionProjectionRegistry);
  const events = [
    { seq: 0, time: 0, type: "plan/mode", data: { active: true } },
    {
      seq: 1,
      time: 1,
      type: "todo/write",
      data: { todos: [{ content: "Native cold read", status: "completed" }] },
    },
  ] as unknown as readonly SessionEvent[];
  const header = { id: SessionId("cold"), version: 4, createdAt: 0 } as SessionHeader;
  const read = () =>
    context.sessionProjections.restore({}, events, SessionLogOffset(0), header, SessionLogOffset(0))
      .snapshot.values;
  const fiber = await context.plugin({
    inject: ["sessionProjections"],
    apply: registerDshReadProjections,
  });
  expect(read()).toMatchObject({
    plan: { active: true, pending: false },
    todos: [{ content: "Native cold read", status: "completed" }],
  });
  expect(context.get("tools")).toBeUndefined();
  expect(context.get("systemPrompt")).toBeUndefined();
  await fiber.dispose();
  expect(read()).toEqual({});
});
