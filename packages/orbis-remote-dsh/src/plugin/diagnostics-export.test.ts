import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { OrbisDshDiagnosticsExporter } from "./diagnostics-export";
import { OrbisDshFileLogger } from "./file-logger";
import type { OrbisDshStatus } from "./host-service";

const CAPTURED_AT = new Date("2026-08-31T10:00:00.000Z");

function status(): OrbisDshStatus {
  return {
    configuration: {
      autoDirectEndpoints: [{ kind: "lan", url: "ws://192.168.4.20:47000/orbis" }],
      directPort: 47_000,
      endpointRevision: 7,
      endpoints: [{ kind: "lan", url: "ws://192.168.4.20:47000/orbis" }],
      hostId: "private-host-id",
      hostName: "Private Windows Workstation",
      ready: true,
      suggestedHostName: "Private Windows Workstation",
    },
    connection: {
      error: "connect ws://192.168.4.20:47000/orbis token=private-token",
      state: "connected",
    },
    devices: [
      {
        connected: false,
        deviceId: "private-device-id",
        deviceName: "Private iPhone",
        error: "Bearer private-bearer",
        keyId: "private-key-id",
        lastConnectedAt: "2026-08-31T09:59:00.000Z",
        pairedAt: "2026-08-31T09:00:00.000Z",
        publicKey: "private-public-key",
        scopeMode: "all",
        scopes: ["host:connect"],
        version: "2",
      },
    ],
    hostEnvironment: {
      hostMachine: "windows",
      isWsl: true,
      networkingMode: "nat",
      wslDistribution: "Ubuntu",
    },
    pairing: {
      expiresAt: "2026-08-31T10:05:00.000Z",
      invitation: "orbis://pair/private-secret",
      pairingId: "private-pairing-id",
      phase: "awaiting-device",
      transport: "lan",
    },
  };
}

describe("OrbisDshDiagnosticsExporter", () => {
  it("exports recent rotated and current logs without support-unsafe host data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-diagnostics-export-"));
    const path = join(directory, "server.jsonl");
    const rotated = [
      JSON.stringify({
        at: "2026-08-31T09:45:00.000Z",
        component: "orbis-dsh-server",
        event: "remote.request.started",
        level: "debug",
        peerDeviceId: "private-device-id",
        requestId: "request-123",
      }),
      JSON.stringify({
        at: "2026-08-31T08:00:00.000Z",
        event: "old.event",
        requestId: "old-request",
      }),
    ].join("\n");
    const current = [
      JSON.stringify({
        at: "2026-08-31T09:59:00.000Z",
        event: "remote.request.failed",
        errorCode: "unavailable",
        errorMessage:
          "connect ws://192.168.4.20:47000/orbis Bearer private-bearer from C:\\private\\workspace\\project.ts",
        method: "agent.v2/session.create",
        peerKeyId: "private-key-id",
        requestId: "request-123",
      }),
      JSON.stringify({
        at: "2026-08-31T09:59:30.000Z",
        event: "dsh.operation.failed",
        errorCode: "gateway/internal",
        errorMessage: "provider echoed a private user prompt",
        errorName: "RemoteError",
        errorStack: "private stack with prompt contents",
        method: "agent.v2/session.create",
        requestId: "request-123",
      }),
    ].join("\n");
    await writeFile(`${path}.1`, `${rotated}\n`, "utf8");
    await writeFile(path, `${current}\n`, "utf8");

    const logger = new OrbisDshFileLogger(path);
    try {
      const artifact = await new OrbisDshDiagnosticsExporter({
        logger,
        now: () => CAPTURED_AT,
        status: async () => status(),
      }).export();
      const bundle = JSON.parse(artifact.json) as Record<string, unknown>;

      expect(artifact.filename).toMatch(/^orbis-dsh-plugin-diagnostics-.+\.json$/u);
      expect(bundle).toMatchObject({
        format: "orbis.remote-diagnostics",
        formatVersion: 1,
        source: "dsh-plugin",
        correlation: {
          requestIds: ["request-123"],
          latestFailure: {
            code: "unavailable",
            method: "agent.v2/session.create",
            requestId: "request-123",
          },
        },
        retention: { rotatedFileRead: true },
      });
      expect(artifact.json).toContain("request-123");
      expect(artifact.json).toContain("sha256:");
      expect(artifact.json).toContain("errorMessageBytes");
      expect(artifact.json).not.toContain("old-request");
      expect(artifact.json).not.toContain("private-host-id");
      expect(artifact.json).not.toContain("Private Windows Workstation");
      expect(artifact.json).not.toContain("private-device-id");
      expect(artifact.json).not.toContain("Private iPhone");
      expect(artifact.json).not.toContain("private-key-id");
      expect(artifact.json).not.toContain("private-public-key");
      expect(artifact.json).not.toContain("private-pairing-id");
      expect(artifact.json).not.toContain("private-secret");
      expect(artifact.json).not.toContain("private-bearer");
      expect(artifact.json).not.toContain("private user prompt");
      expect(artifact.json).not.toContain("private stack");
      expect(artifact.json).not.toContain("192.168.4.20");
      expect(artifact.json).not.toContain("ws://");
      expect(artifact.json).not.toContain("private\\workspace");
    } finally {
      await logger.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
