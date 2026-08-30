import { afterEach, expect, test, vi } from "vitest";

import { cancelRawDshEventReplay, startRawDshEventReplay } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("uploads the selected JSONL bytes directly to the loopback replay route", async () => {
  const file = new Blob(['{"kind":"header"}\n'], {
    type: "application/x-ndjson",
  }) as File;
  Object.defineProperty(file, "name", { value: "daily capture.jsonl" });
  const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(
        JSON.stringify({
          eventCount: 1,
          replayedEventCount: 0,
          state: "waiting",
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetch);

  await expect(startRawDshEventReplay(file)).resolves.toMatchObject({ state: "waiting" });

  expect(fetch).toHaveBeenCalledWith(
    "/orbis/replay",
    expect.objectContaining({
      body: file,
      cache: "no-store",
      method: "POST",
    }),
  );
  const init = fetch.mock.calls[0]![1] as RequestInit;
  expect(init.headers).toBeInstanceOf(Headers);
  expect((init.headers as Headers).get("content-type")).toBe("application/x-ndjson");
  expect((init.headers as Headers).get("x-orbis-replay-filename")).toBe("daily%20capture.jsonl");
});

test("cancels replay through its explicit lifecycle endpoint", async () => {
  const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(
        JSON.stringify({
          eventCount: 2,
          replayedEventCount: 1,
          state: "cancelled",
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetch);

  await expect(cancelRawDshEventReplay()).resolves.toMatchObject({ state: "cancelled" });
  expect(fetch).toHaveBeenCalledWith(
    "/orbis/replay",
    expect.objectContaining({ method: "DELETE" }),
  );
});
