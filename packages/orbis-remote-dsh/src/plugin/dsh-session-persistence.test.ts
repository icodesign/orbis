import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { describe, expect, test, vi } from "vitest";

import { createDshSessionPersistence } from "./dsh-session-persistence";

function contextPersistence(
  open: Context["sessionPersistence"]["open"],
  list: Context["sessionPersistence"]["list"],
): Context["sessionPersistence"] {
  return { open, list } as Context["sessionPersistence"];
}

describe("DSH session persistence adapter", () => {
  test("opens a read handle, reads the complete log, and closes it", async () => {
    const signal = new AbortController().signal;
    const header = { id: SessionId("session-1"), cwd: "/workspace" };
    const events = [{ seq: 0, time: 10, type: "user/message", data: {} }];
    const read = vi.fn(async () => ({ eventState: "owned", events }));
    const close = vi.fn(async () => undefined);
    const handle = { header, read, close };
    const open: Context["sessionPersistence"]["open"] = async (id, access, options) => {
      expect(id).toBe(SessionId("session-1"));
      expect(access).toBe("read");
      expect(options).toEqual({ signal });
      return handle as never;
    };
    const list: Context["sessionPersistence"]["list"] = async () => [];
    const adapter = createDshSessionPersistence(contextPersistence(open, list));

    await expect(adapter.inspect("session-1", signal)).resolves.toEqual({ meta: header, events });
    expect(read).toHaveBeenCalledWith(undefined, undefined, { signal });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("unwraps headers from the DSH list snapshots", async () => {
    const signal = new AbortController().signal;
    const first = { id: SessionId("first"), cwd: "/first" };
    const second = { id: SessionId("second"), cwd: "/second" };
    const list: Context["sessionPersistence"]["list"] = vi.fn(async (options) => {
      expect(options).toEqual({ signal });
      return [
        { header: first, revision: "revision:first" },
        { header: second, revision: "revision:second" },
      ] as never;
    });
    const open: Context["sessionPersistence"]["open"] = async () => {
      throw new Error("list must not open a session");
    };
    const adapter = createDshSessionPersistence(contextPersistence(open, list));

    await expect(adapter.list(signal)).resolves.toEqual([first, second]);
    expect(list).toHaveBeenCalledWith({ signal });
  });

  test("closes the read handle when reading fails", async () => {
    const failure = new Error("read failed");
    const read = vi.fn(async () => {
      throw failure;
    });
    const close = vi.fn(async () => undefined);
    const handle = {
      header: { id: SessionId("broken") },
      read,
      close,
    };
    const open: Context["sessionPersistence"]["open"] = async () => handle as never;
    const list: Context["sessionPersistence"]["list"] = async () => [];
    const adapter = createDshSessionPersistence(contextPersistence(open, list));

    await expect(adapter.inspect("broken")).rejects.toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
