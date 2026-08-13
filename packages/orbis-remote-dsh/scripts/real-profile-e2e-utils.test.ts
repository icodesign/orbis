import { expect, test } from "vitest";

import { waitFor } from "./real-profile-e2e-utils.ts";

test("waitFor returns the successful observed value", async () => {
  const status = { configuration: { autoDirectEndpoints: [] } };

  await expect(waitFor(async () => status, "direct pairing commit")).resolves.toBe(status);
});
