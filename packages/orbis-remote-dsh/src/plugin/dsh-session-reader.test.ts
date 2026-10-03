import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionObservation } from "@deepseek-ai/dsh-session-query";
import { describe, expect, test, vi } from "vitest";

import { createDshSessionReader } from "./dsh-session-reader";

function reader(
  observeSession: Context["sessionQuery"]["observeSession"],
  list = vi.fn(async () => []),
) {
  return createDshSessionReader(
    { observeSession } as Context["sessionQuery"],
    { list } as unknown as Context["sessionPersistence"],
  );
}

describe("DSH session observation adapter", () => {
  test.each(["live", "prepared"] as const)("reads and releases a %s cut", async (source) => {
    const signal = new AbortController().signal;
    const header = { id: SessionId("session-1"), createdAt: 10, cwd: "/workspace" };
    const events = [{ seq: 0, time: 10, type: "user/message", data: {} }];
    const projections = { plan: { active: true, pending: false } };
    const dispose = vi.fn();
    const observeSession = vi.fn(
      async () =>
        ({
          source,
          header,
          events,
          projections: { values: projections },
          [Symbol.dispose]: dispose,
        }) as unknown as SessionObservation,
    );
    await expect(reader(observeSession).inspect("session-1", signal)).resolves.toEqual({
      meta: header,
      events,
      projections,
    });
    expect(observeSession).toHaveBeenCalledWith(SessionId("session-1"), { signal });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("reads native projections without materializing events and releases the lease", async () => {
    const dispose = vi.fn();
    const values = {
      modelSelection: { lastUsed: null, next: { model: "model", provider: "provider" } },
    };
    const observeSession = async () =>
      ({
        get events() {
          throw new Error("projection read must not expand the transcript");
        },
        projections: { values },
        [Symbol.dispose]: dispose,
      }) as unknown as SessionObservation;
    await expect(reader(observeSession).projections("session-1")).resolves.toBe(values);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("releases the lease when transcript materialization fails", async () => {
    const failure = new Error("read failed");
    const dispose = vi.fn();
    const observeSession = async () =>
      ({
        get events() {
          throw failure;
        },
        [Symbol.dispose]: dispose,
      }) as unknown as SessionObservation;
    await expect(reader(observeSession).inspect("broken")).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("rejects missing projections and releases the lease", async () => {
    const dispose = vi.fn();
    const observeSession = async () =>
      ({ [Symbol.dispose]: dispose }) as unknown as SessionObservation;
    await expect(reader(observeSession).projections("broken")).rejects.toMatchObject({
      code: "protocol",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("unwraps catalog headers without observing historical logs", async () => {
    const signal = new AbortController().signal;
    const header = { id: SessionId("historic"), cwd: "/workspace" };
    const list = vi.fn(async () => [{ header, revision: "revision:historic" }]) as never;
    const observeSession = vi.fn(async (): Promise<SessionObservation> => {
      throw new Error("must not observe");
    });
    await expect(reader(observeSession, list).list(signal)).resolves.toEqual([header]);
    expect(list).toHaveBeenCalledWith({ signal });
    expect(observeSession).not.toHaveBeenCalled();
  });
});
