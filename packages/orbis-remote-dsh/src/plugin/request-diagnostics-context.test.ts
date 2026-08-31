import { describe, expect, it } from "vitest";

import {
  currentOrbisRemoteRequestDiagnostics,
  withOrbisRemoteRequestDiagnostics,
} from "./request-diagnostics-context";

describe("Remote request diagnostics context", () => {
  it("preserves request correlation across awaited DSH work without leaking it afterward", async () => {
    expect(currentOrbisRemoteRequestDiagnostics()).toBeUndefined();

    await withOrbisRemoteRequestDiagnostics(
      { method: "agent.v2/session.create", requestId: "request-123" },
      async () => {
        await Promise.resolve();
        expect(currentOrbisRemoteRequestDiagnostics()).toEqual({
          method: "agent.v2/session.create",
          requestId: "request-123",
        });
      },
    );

    expect(currentOrbisRemoteRequestDiagnostics()).toBeUndefined();
  });
});
