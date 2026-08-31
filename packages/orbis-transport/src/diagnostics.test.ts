import { describe, expect, test } from "vitest";

import {
  createRemoteDiagnosticsEnvelope,
  fingerprintRemoteDiagnosticsValue,
  redactStoredRemoteServer,
  remoteDiagnosticsFileName,
  serializeRemoteDiagnostics,
} from "./diagnostics";

describe("remote diagnostics", () => {
  test("creates the versioned envelope used by iOS and the DSH plugin", () => {
    const envelope = createRemoteDiagnosticsEnvelope(
      {
        correlation: { requestIds: ["request-123"] },
        environment: { platform: "ios" },
        logs: { entries: [] },
        redaction: { omitted: [], profile: "support-safe-v1", truncated: [] },
        retention: { maxEntries: 10 },
        source: "ios",
        status: { connection: { state: "offline" } },
        versions: { protocol: "2" },
        window: { from: "2026-08-31T00:00:00.000Z", to: "2026-08-31T00:00:00.000Z" },
      },
      "2026-08-31T00:00:00.000Z",
    );

    expect(envelope).toMatchObject({
      capturedAt: "2026-08-31T00:00:00.000Z",
      format: "orbis.remote-diagnostics",
      formatVersion: 1,
      source: "ios",
    });
  });

  test("redacts server URLs, key material, and stable IDs while retaining route metadata", () => {
    const server = redactStoredRemoteServer({
      enabled: true,
      endpointRevision: 7,
      endpoints: [
        { kind: "lan", url: "ws://192.168.4.20:47000/orbis" },
        { kind: "tunnel", url: "wss://private.example.com/orbis", expiresAt: "2026-09-01" },
      ],
      harnesses: [{ capabilities: ["agent:read"], id: "dsh", version: "0.2.6" }],
      hostKeyId: "private-host-key-id",
      hostPublicKey: "private-public-key",
      id: "private-host-id",
      lastSeenAt: 2,
      name: "Private Workstation",
      pairedAt: 1,
      permissionMode: "all",
      platform: "windows",
      scopes: ["host:connect"],
      status: "online",
      updatedAt: 3,
    });
    const serialized = JSON.stringify(server);

    expect(server.endpoints).toMatchObject([
      {
        fingerprint: fingerprintRemoteDiagnosticsValue(
          "private-public-key\u0000ws://192.168.4.20:47000/orbis",
        ),
        kind: "lan",
      },
      { kind: "tunnel" },
    ]);
    expect(server.hostFingerprint).toBe(fingerprintRemoteDiagnosticsValue("private-host-id"));
    expect(server.hostKeyFingerprint).toMatch(/^sha256:/u);
    expect(serialized).not.toContain("192.168.4.20");
    expect(serialized).not.toContain("private.example.com");
    expect(serialized).not.toContain("private-public-key");
    expect(serialized).not.toContain("private-host-id");
    expect(serialized).not.toContain("Private Workstation");
  });

  test("serializes errors, bigint values, circular values, and secret keys safely", () => {
    const error = Object.assign(new Error("connect https://private.example.com"), {
      token: "private-token",
    });
    const circular: { self?: unknown } = {};
    circular.self = circular;

    const parsed = JSON.parse(
      serializeRemoteDiagnostics({
        circular,
        count: 2n,
        error,
        hostPublicKey: "private-public-key",
        invitation: "orbis://pair/private-secret",
        path: "C:\\private\\workspace\\project.ts",
        token: "private-token",
      }),
    ) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      circular: { self: "[Circular]" },
      count: "2",
      error: { message: "connect <URL>", token: "[REDACTED]" },
      hostPublicKey: "[REDACTED]",
      invitation: "[REDACTED]",
      path: "<PATH>",
      token: "[REDACTED]",
    });
  });

  test("creates a portable source and fingerprint file name", () => {
    expect(remoteDiagnosticsFileName("ios", "sha256:abc/host:1", "2026-08-31T03:00:00.000Z")).toBe(
      "orbis-ios-diagnostics-sha256-abc-host-1-2026-08-31T03-00-00-000Z.json",
    );
    expect(remoteDiagnosticsFileName("dsh-plugin", undefined, "2026-08-31T03:00:00.000Z")).toBe(
      "orbis-dsh-plugin-diagnostics-2026-08-31T03-00-00-000Z.json",
    );
  });
});
