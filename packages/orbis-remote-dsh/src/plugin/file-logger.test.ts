import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import { OrbisDshFileLogger, orbisDshErrorFields } from "./file-logger";

describe("OrbisDshFileLogger", () => {
  test("writes owner-only JSONL and redacts sensitive values", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-dsh-log-"));
    const path = join(root, "nested", "server.jsonl");
    try {
      const logger = new OrbisDshFileLogger(path);
      await logger.start();
      logger.info("server.started", {
        accessToken: "provider-token",
        hostId: "host-1",
      });
      logger.error(
        "remote.request.failed",
        orbisDshErrorFields(new Error("Bearer bearer-secret token=private-secret")),
      );
      await logger.close();

      const contents = await readFile(path, "utf8");
      const records = contents
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        component: "orbis-dsh-server",
        event: "server.started",
        hostId: "host-1",
        accessToken: "[REDACTED]",
      });
      expect(records[1]?.errorMessage).toBe("Bearer [REDACTED] token=[REDACTED]");
      expect(orbisDshErrorFields(new Error("prompt content"), { includeMessage: false })).toEqual({
        errorName: "Error",
        errorMessageBytes: 14,
      });
      expect(contents).not.toContain("provider-token");
      expect(contents).not.toContain("bearer-secret");
      expect(contents).not.toContain("private-secret");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rotates bounded logs and keeps oversized records valid JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-dsh-log-"));
    const path = join(root, "server.jsonl");
    try {
      const logger = new OrbisDshFileLogger(path, { maxBytes: 1_024 });
      await logger.start();
      logger.info("before.rotation", { detail: "x".repeat(600) });
      logger.info("after.rotation", { detail: "x".repeat(600) });
      const oversizedFields = Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [`detail${index}`, "y".repeat(4_096)]),
      );
      logger.warn("oversized.record", oversizedFields);
      await logger.close();

      const backup = await readFile(`${path}.1`, "utf8");
      const current = await readFile(path, "utf8");
      expect(backup).toContain('"event":"before.rotation"');
      expect(current).toContain('"event":"after.rotation"');
      expect(current).toContain('"event":"oversized.record"');
      for (const line of [...backup.trim().split("\n"), ...current.trim().split("\n")]) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      expect(current).toContain('"fieldsTruncated":true');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
