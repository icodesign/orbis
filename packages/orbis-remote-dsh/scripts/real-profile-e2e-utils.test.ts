import { expect, test, vi } from "vitest";

import { authenticateDshWeb, fetchDshWeb, waitFor } from "./real-profile-e2e-utils.ts";

test("leaves the reviewed pre-token DSH Web URL unchanged", async () => {
  const fetchImplementation = vi.fn();

  await expect(authenticateDshWeb("http://127.0.0.1:3210", fetchImplementation)).resolves.toEqual({
    origin: "http://127.0.0.1:3210",
  });
  expect(fetchImplementation).not.toHaveBeenCalled();
});

test("exchanges an alpha launch token and authenticates later requests", async () => {
  const fetchImplementation = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 303,
        headers: { "set-cookie": "dsh_session=signed; HttpOnly; SameSite=Strict" },
      }),
    )
    .mockResolvedValueOnce(new Response("{}", { status: 200 }));

  const session = await authenticateDshWeb(
    "http://127.0.0.1:3210/?token=one-time-secret",
    fetchImplementation,
  );
  await fetchDshWeb(session, "/orbis/status", {}, fetchImplementation);

  expect(session).toEqual({
    origin: "http://127.0.0.1:3210",
    cookie: "dsh_session=signed",
  });
  expect(fetchImplementation).toHaveBeenNthCalledWith(
    1,
    new URL("http://127.0.0.1:3210/?token=one-time-secret"),
    { redirect: "manual" },
  );
  const authenticatedInit = fetchImplementation.mock.calls[1]?.[1];
  expect(fetchImplementation.mock.calls[1]?.[0]).toBe("http://127.0.0.1:3210/orbis/status");
  expect(new Headers(authenticatedInit?.headers).get("cookie")).toBe("dsh_session=signed");
});

test.each([
  [new Response(null, { status: 401 }), "returned HTTP 401"],
  [new Response(null, { status: 303 }), "did not return a session cookie"],
])("rejects an invalid alpha token exchange", async (response, message) => {
  await expect(
    authenticateDshWeb(
      "http://127.0.0.1:3210/?token=one-time-secret",
      vi.fn().mockResolvedValue(response),
    ),
  ).rejects.toThrow(message);
});

test("waitFor returns the successful observed value", async () => {
  const status = { configuration: { autoDirectEndpoints: [] } };

  await expect(waitFor(async () => status, "direct pairing commit")).resolves.toBe(status);
});
