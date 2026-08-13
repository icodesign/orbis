import { expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentDeliveryCursor, createAgentSessionRef } from "@orbisapp/orbis-agent-backend";

import { NodeFileRemoteAgentV2HostStore } from "./v2-node-file-host-store";

async function expectRejection(operation: () => Promise<unknown>, expected: object): Promise<void> {
  let error: unknown;
  try {
    await operation();
  } catch (candidate) {
    error = candidate;
  }
  expect(error).toMatchObject(expected);
}

test("v2 node store persists only cursor indexes and idempotency admissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbis-remote-agent-v2-store-"));
  const path = join(directory, "state.json");
  const ref = createAgentSessionRef({
    backendId: "remote:host-a",
    driverId: "dsh",
    nativeSessionId: "session-a",
    sessionId: "session-a",
  });
  try {
    const store = new NodeFileRemoteAgentV2HostStore({
      hostId: "host-a",
      hostKeyId: "sha256:host-key",
      path,
    });
    expect(await store.readHostRevision()).toBe("1");
    await store.initializeSession(ref, [{ cursor: agentDeliveryCursor(1), entryId: "entry-1" }]);
    expect(await store.claimIdempotency("prompt-1")).toEqual({ kind: "claimed" });
    await store.completeIdempotency("prompt-1", { accepted: true });

    const restarted = new NodeFileRemoteAgentV2HostStore({
      hostId: "host-a",
      hostKeyId: "sha256:host-key",
      path,
    });
    expect(await restarted.readSessionIndex(ref)).toMatchObject({
      entries: [{ cursor: 1, entryId: "entry-1" }],
    });
    expect(await restarted.claimIdempotency("prompt-1")).toEqual({
      kind: "accepted",
      result: { accepted: true },
    });
    const contents = await readFile(path, "utf8");
    expect(contents).toContain('"entryId":"entry-1"');
    expect(contents).not.toContain("assistant");
    expect(contents).not.toContain("transcript");

    const rotated = new NodeFileRemoteAgentV2HostStore({
      hostId: "host-a",
      hostKeyId: "sha256:rotated",
      path,
    });
    await expectRejection(() => rotated.readHostRevision(), { code: "protocol" });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("v2 idempotency admissions expire without retaining a transcript log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbis-remote-agent-v2-ttl-"));
  const path = join(directory, "state.json");
  let now = 1_000;
  try {
    const store = new NodeFileRemoteAgentV2HostStore({
      hostId: "host-a",
      hostKeyId: "sha256:host-key",
      idempotencyTtlMs: 1_000,
      now: () => now,
      path,
    });
    expect(await store.claimIdempotency("prompt-1")).toEqual({ kind: "claimed" });
    await store.completeIdempotency("prompt-1", { accepted: true });
    now += 1_000;
    expect(await store.claimIdempotency("prompt-1")).toEqual({ kind: "claimed" });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
