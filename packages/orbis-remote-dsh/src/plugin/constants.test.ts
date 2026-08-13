import { expect, test } from "vitest";

import { ORBIS_DSH_DRIVER_VERSION, ORBIS_DSH_HARNESS_ID } from "./constants";

test("advertises the stable DSH harness identity", () => {
  expect(ORBIS_DSH_HARNESS_ID).toBe("dsh");
  expect(ORBIS_DSH_DRIVER_VERSION).toBe("0.1.0");
});
