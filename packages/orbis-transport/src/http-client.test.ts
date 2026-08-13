import { describe, expect, test } from "vitest";

import { OrbisTransportError } from "./errors";
import {
  OrbisTransportClient,
  type FetchImplementation,
  type TransportOperationOptions,
} from "./http-client";
import {
  ORBIS_TRANSPORT_PROTOCOL_VERSION,
  ORBIS_TRANSPORT_SUBPROTOCOL,
  type ApprovedPairingStatus,
  type PairingChallenge,
  type PairingStatus,
  type RemoteHost,
} from "./protocol";

const NOW = Date.parse("2026-08-09T00:00:00.000Z");
const FUTURE = "2026-08-09T00:10:00.000Z";

const host: RemoteHost = {
  id: "host-1",
  name: "Build Mac",
  platform: "darwin-arm64",
  status: "online",
  publicKeyFingerprint: "sha256:host-key",
  lastSeenAt: "2026-08-09T00:00:00.000Z",
  harnesses: [
    { id: "pi", version: "0.83.0", capabilities: ["sessions"] },
    { id: "deepseek", version: "internal", capabilities: ["sessions"] },
  ],
};

const challenge: PairingChallenge = {
  pairingId: "pairing-1",
  pollingToken: "pairing-polling-token-at-least-sixteen",
  userCode: "ABCD-EFGH",
  verificationUri: "https://remote.example/pair",
  expiresAt: FUTURE,
  intervalSeconds: 1,
};

const approved: ApprovedPairingStatus = {
  status: "approved",
  host,
  credential: {
    accessToken: "approved-access-token",
    refreshToken: "approved-refresh-token",
    expiresAt: FUTURE,
  },
  peer: {
    publicKey: "client-public-key",
    keyId: "sha256:client-key",
    scopes: ["host:connect"],
  },
};

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function asFetch(
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): FetchImplementation {
  return implementation as FetchImplementation;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

function requestBody(init: RequestInit | undefined): unknown {
  expect(typeof init?.body).toBe("string");
  return JSON.parse(init?.body as string);
}

function expectTransportError(
  error: unknown,
  code: OrbisTransportError["code"],
): asserts error is OrbisTransportError {
  expect(error).toBeInstanceOf(OrbisTransportError);
  expect((error as OrbisTransportError).code).toBe(code);
}

describe("OrbisTransportClient security and HTTP behavior", () => {
  test("requires HTTPS unless insecure development transport is explicit", () => {
    expect(
      () =>
        new OrbisTransportClient({
          baseUrl: "http://remote.example",
          fetch: asFetch(async () => jsonResponse({})),
        }),
    ).toThrow(OrbisTransportError);

    expect(
      new OrbisTransportClient({
        baseUrl: "http://127.0.0.1:8787/api",
        allowInsecureHttp: true,
        fetch: asFetch(async () => jsonResponse({})),
      }).baseUrl,
    ).toBe("http://127.0.0.1:8787/api/");
  });

  test("initiates pairing without leaking authentication into an unauthenticated route", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const client = new OrbisTransportClient({
      baseUrl: "https://remote.example/api/",
      accessTokenProvider: async () => "must-not-be-used",
      fetch: asFetch(async (input, init) => {
        capturedUrl = requestUrl(input);
        capturedInit = init;
        return jsonResponse(challenge);
      }),
    });

    const result = await client.initiatePairing({
      pairingId: "pairing-1",
      hostId: "host-1",
      hostName: "Build Mac",
      platform: "darwin-arm64",
      publicKey: "host-public-key",
      pairingSecretVerifier: "pairing-secret-verifier-at-least-32-bytes",
      requestedScopes: ["host:connect"],
    });

    expect(result).toEqual(challenge);
    expect(capturedUrl).toBe("https://remote.example/api/v1/pairings");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.redirect).toBe("error");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-orbis-protocol-version")).toBe(String(ORBIS_TRANSPORT_PROTOCOL_VERSION));
    expect(requestBody(capturedInit)).toEqual({
      pairingId: "pairing-1",
      hostId: "host-1",
      hostName: "Build Mac",
      platform: "darwin-arm64",
      publicKey: "host-public-key",
      pairingSecretVerifier: "pairing-secret-verifier-at-least-32-bytes",
      requestedScopes: ["host:connect"],
    });
  });

  test("obtains an access token per authenticated request and applies protocol defaults", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let tokenCalls = 0;
    const client = new OrbisTransportClient({
      baseUrl: "https://remote.example/",
      accessTokenProvider: async ({ signal, serverUrl }) => {
        expect(signal.aborted).toBe(false);
        expect(serverUrl).toBe("https://remote.example/");
        tokenCalls += 1;
        return `access-${tokenCalls}`;
      },
      fetch: asFetch(async (input, init) => {
        const url = requestUrl(input);
        requests.push({ url, init });
        if (url.endsWith("/v1/hosts")) {
          return jsonResponse([host]);
        }
        return jsonResponse({
          ticket: "short-lived-ticket",
          expiresAt: FUTURE,
          websocketUrl: "wss://remote.example/connect",
          protocol: ORBIS_TRANSPORT_SUBPROTOCOL,
          host,
        });
      }),
    });

    await client.listHosts();
    await client.createConnectionTicket({
      hostId: "host-1",
      deviceId: "device-1",
      role: "client",
    });

    expect(tokenCalls).toBe(2);
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer access-1");
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe("Bearer access-2");
    expect(requestBody(requests[1]?.init)).toEqual({
      hostId: "host-1",
      deviceId: "device-1",
      role: "client",
      protocolVersion: ORBIS_TRANSPORT_PROTOCOL_VERSION,
    });
  });

  test("uses only the server polling token on host status and cancellation calls", async () => {
    const requests: RequestInit[] = [];
    const client = new OrbisTransportClient({
      baseUrl: "https://remote.example/",
      fetch: asFetch(async (_input, init) => {
        requests.push(init ?? {});
        return requests.length === 1
          ? jsonResponse({ status: "pending", expiresAt: FUTURE })
          : new Response(null, { status: 204 });
      }),
    });

    await client.getPairingStatus(challenge);
    await client.cancelPairing(challenge);

    expect(new Headers(requests[0]?.headers).get("authorization")).toBe(
      `Pairing ${challenge.pollingToken}`,
    );
    expect(new Headers(requests[1]?.headers).get("authorization")).toBe(
      `Pairing ${challenge.pollingToken}`,
    );
    expect(requests[1]?.method).toBe("DELETE");
  });

  test("accepts either a JSON acknowledgement or a 204 for control mutations", async () => {
    const responses = [jsonResponse({ ok: true }), new Response(null, { status: 204 })];
    const client = new OrbisTransportClient({
      baseUrl: "https://remote.example/",
      accessTokenProvider: async () => "access-token",
      fetch: asFetch(async () => responses.shift() as Response),
    });

    expect(
      await client.approvePairing("pairing-1", {
        scopes: ["host:connect"],
        clientPublicKey: "client-public-key",
        clientKeyId: "sha256:client-key",
      }),
    ).toBeUndefined();
    expect(await client.rejectPairing("pairing-1")).toBeUndefined();
  });

  test("returns typed redacted HTTP errors without retaining the response body", async () => {
    const leakedValue = "sensitive-server-body-value";
    const client = new OrbisTransportClient({
      baseUrl: "https://remote.example/",
      accessTokenProvider: async () => "access-token",
      fetch: asFetch(async () =>
        jsonResponse(
          {
            error: {
              code: "rate_limited",
              message: leakedValue,
              retryable: true,
              retryAfterMs: 2500,
            },
          },
          429,
        ),
      ),
    });

    try {
      await client.listHosts();
      throw new Error("Expected listHosts to fail");
    } catch (error) {
      expectTransportError(error, "http");
      expect(error.status).toBe(429);
      expect(error.serverCode).toBe("rate_limited");
      expect(error.retryable).toBe(true);
      expect(error.retryAfterMs).toBe(2500);
      expect(error.message).not.toContain(leakedValue);
      expect(JSON.stringify(error)).not.toContain(leakedValue);
      expect(error.cause).toBeUndefined();
    }
  });

  test("classifies 401 as authentication and rejects malformed success bodies as protocol errors", async () => {
    const responses = [
      jsonResponse({ error: { code: "token_expired" } }, 401),
      jsonResponse({ not: "a host list" }),
    ];
    const client = new OrbisTransportClient({
      baseUrl: "https://remote.example/",
      accessTokenProvider: async () => "access-token",
      fetch: asFetch(async () => responses.shift() as Response),
    });

    await client.listHosts().then(
      () => {
        throw new Error("Expected authentication error");
      },
      (error) => expectTransportError(error, "authentication"),
    );
    await client.listHosts().then(
      () => {
        throw new Error("Expected protocol error");
      },
      (error) => expectTransportError(error, "protocol"),
    );
  });

  test("enforces response size and request timeout", async () => {
    const oversized = new OrbisTransportClient({
      baseUrl: "https://remote.example/",
      accessTokenProvider: async () => "access-token",
      maxResponseBytes: 8,
      fetch: asFetch(async () => new Response('"九十九"')),
    });
    await oversized.listHosts().then(
      () => {
        throw new Error("Expected size error");
      },
      (error) => expectTransportError(error, "protocol"),
    );

    const timedOut = new OrbisTransportClient({
      baseUrl: "https://remote.example/",
      accessTokenProvider: async () => "access-token",
      requestTimeoutMs: 5,
      fetch: asFetch(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
    });
    await timedOut.listHosts().then(
      () => {
        throw new Error("Expected timeout");
      },
      (error) => expectTransportError(error, "timeout"),
    );
  });

  test("rejects a declared oversized response before buffering its body", async () => {
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const client = new OrbisTransportClient({
      baseUrl: "https://remote.example/",
      accessTokenProvider: async () => "access-token",
      maxResponseBytes: 64,
      fetch: asFetch(async () => new Response(body, { headers: { "Content-Length": "4096" } })),
    });
    await client.listHosts().then(
      () => {
        throw new Error("Expected size error");
      },
      (error) => expectTransportError(error, "protocol"),
    );
    expect(bodyCancelled).toBe(true);
  });

  test("stops streaming an oversized body at the byte cap and cancels the reader", async () => {
    let pulled = 0;
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 50) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(new TextEncoder().encode("chunk-"));
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const client = new OrbisTransportClient({
      baseUrl: "https://remote.example/",
      accessTokenProvider: async () => "access-token",
      maxResponseBytes: 16,
      fetch: asFetch(async () => new Response(body)),
    });
    await client.listHosts().then(
      () => {
        throw new Error("Expected size error");
      },
      (error) => expectTransportError(error, "protocol"),
    );
    expect(bodyCancelled).toBe(true);
    // The cap was hit after a few chunks; the full 300-byte body was never buffered.
    expect(pulled).toBeLessThan(10);
  });

  test("keeps an oversized error body classified as an HTTP error without parsing it", async () => {
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":{"code":"rate_limited","message":"'));
        controller.enqueue(new TextEncoder().encode("secret-body-value"));
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const client = new OrbisTransportClient({
      baseUrl: "https://remote.example/",
      accessTokenProvider: async () => "access-token",
      maxResponseBytes: 24,
      fetch: asFetch(async () => new Response(body, { status: 429 })),
    });
    await client.listHosts().then(
      () => {
        throw new Error("Expected HTTP error");
      },
      (error) => {
        expectTransportError(error, "http");
        expect(error.status).toBe(429);
        expect(error.serverCode).toBeUndefined();
        expect(JSON.stringify(error)).not.toContain("secret-body-value");
      },
    );
    expect(bodyCancelled).toBe(true);
  });

  test("validates inputs before invoking fetch", async () => {
    let fetchCalls = 0;
    const client = new OrbisTransportClient({
      baseUrl: "https://remote.example/",
      fetch: asFetch(async () => {
        fetchCalls += 1;
        return jsonResponse({});
      }),
    });

    expect(() =>
      client.initiatePairing({
        pairingId: "pairing-1",
        hostId: "host-1",
        hostName: "",
        platform: "darwin",
        publicKey: "key",
        pairingSecretVerifier: "too-short",
        requestedScopes: [],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
      }),
    );
    expect(fetchCalls).toBe(0);
  });

  test("rejects an invalid bearer credential before constructing request headers", async () => {
    let fetchCalls = 0;
    const client = new OrbisTransportClient({
      baseUrl: "https://remote.example/",
      accessTokenProvider: async () => "token\r\nInjected: value",
      fetch: asFetch(async () => {
        fetchCalls += 1;
        return jsonResponse([host]);
      }),
    });

    await client.listHosts().then(
      () => {
        throw new Error("Expected invalid credential rejection");
      },
      (error) => expectTransportError(error, "authentication"),
    );
    expect(fetchCalls).toBe(0);
  });
});

describe("OrbisTransportClient pairing polling", () => {
  function pollingClient(
    statuses: PairingStatus[],
    nowRef: { value: number },
    intervals: number[],
  ) {
    return new OrbisTransportClient({
      baseUrl: "https://remote.example/",
      now: () => nowRef.value,
      sleep: async (milliseconds, signal) => {
        if (signal.aborted) {
          throw signal.reason;
        }
        intervals.push(milliseconds);
        nowRef.value += milliseconds;
      },
      fetch: asFetch(async () => jsonResponse(statuses.shift())),
    });
  }

  test("honors server poll intervals and returns approved credentials without storing them", async () => {
    const now = { value: NOW };
    const intervals: number[] = [];
    const client = pollingClient(
      [{ status: "pending", expiresAt: FUTURE, intervalSeconds: 2 }, approved],
      now,
      intervals,
    );

    const result = await client.waitForPairing(challenge);

    expect(result).toEqual(approved);
    expect(intervals).toEqual([1000, 2000]);
  });

  test("surfaces rejected, expired, and caller-cancelled states distinctly", async () => {
    const now = { value: NOW };
    const rejectedClient = pollingClient([{ status: "rejected" }], now, []);
    await rejectedClient.waitForPairing(challenge).then(
      () => {
        throw new Error("Expected rejection");
      },
      (error) => {
        expectTransportError(error, "pairing_terminal");
        expect(error.serverCode).toBe("pairing_rejected");
      },
    );

    const expiringChallenge: PairingChallenge = {
      ...challenge,
      expiresAt: new Date(NOW + 1000).toISOString(),
    };
    const expiryNow = { value: NOW };
    const expiryIntervals: number[] = [];
    const expiredClient = pollingClient([], expiryNow, expiryIntervals);
    await expiredClient.waitForPairing(expiringChallenge).then(
      () => {
        throw new Error("Expected expiry");
      },
      (error) => {
        expectTransportError(error, "pairing_terminal");
        expect(error.serverCode).toBe("pairing_expired");
      },
    );
    expect(expiryIntervals).toEqual([1000]);

    const controller = new AbortController();
    controller.abort();
    const cancelledClient = pollingClient([], { value: NOW }, []);
    await cancelledClient.waitForPairing(challenge, { signal: controller.signal }).then(
      () => {
        throw new Error("Expected cancellation");
      },
      (error) => expectTransportError(error, "aborted"),
    );
  });

  test("distinguishes a caller timeout from server-side pairing expiry", async () => {
    const client = new OrbisTransportClient({
      baseUrl: "https://remote.example/",
      now: () => NOW,
      sleep: async (_milliseconds, signal) =>
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      fetch: asFetch(async () => jsonResponse({ status: "pending", expiresAt: FUTURE })),
    });

    const options: TransportOperationOptions = { timeoutMs: 5 };
    await client.waitForPairing(challenge, options).then(
      () => {
        throw new Error("Expected timeout");
      },
      (error) => expectTransportError(error, "timeout"),
    );
  });
});
