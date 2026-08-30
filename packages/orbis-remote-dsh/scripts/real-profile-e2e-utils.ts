const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;

export interface DshWebSession {
  origin: string;
  cookie?: string;
}

type FetchImplementation = typeof fetch;

/**
 * Exchange the one-time alpha launch token for the browser session cookie.
 * Older reviewed DSH builds expose a plain loopback URL and need no exchange.
 */
export async function authenticateDshWeb(
  launchUrl: string,
  fetchImplementation: FetchImplementation = fetch,
): Promise<DshWebSession> {
  const url = new URL(launchUrl);
  if (!url.searchParams.has("token")) return { origin: url.origin };

  const response = await fetchImplementation(url, { redirect: "manual" });
  if (response.status !== 303) {
    throw new Error(`DSH Web token exchange returned HTTP ${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0]?.trim();
  if (!cookie) throw new Error("DSH Web token exchange did not return a session cookie");
  return { origin: url.origin, cookie };
}

/** Send a request through the authenticated DSH browser session. */
export function fetchDshWeb(
  session: DshWebSession,
  path: string,
  init: RequestInit = {},
  fetchImplementation: FetchImplementation = fetch,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (session.cookie) headers.set("cookie", session.cookie);
  return fetchImplementation(`${session.origin}${path}`, { ...init, headers });
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/**
 * Poll until the predicate returns a truthy value, preserving that value for
 * callers that need the observed state rather than just completion.
 */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  label: string,
  timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `${label} did not complete within ${timeoutMs}ms${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
  );
}
