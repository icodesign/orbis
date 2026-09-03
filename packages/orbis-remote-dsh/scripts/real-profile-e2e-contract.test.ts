import { describe, expect, it } from "vitest";

import {
  assertReviewedDshModelObservationContract,
  readDshModelObservation,
  REVIEWED_DSH_VERSION,
} from "./real-profile-e2e-contract";

describe("DSH real-profile model observation contract", () => {
  it("reviews rc.1 as the current model projection contract", () => {
    expect(REVIEWED_DSH_VERSION).toBe("0.1.2-rc.1");
    expect(() => assertReviewedDshModelObservationContract("0.1.2-rc.1")).not.toThrow();
    expect(() => assertReviewedDshModelObservationContract("0.1.2-alpha.5")).toThrow(
      "no reviewed model-observation contract",
    );
  });

  it("reads the selected model from the session projection", () => {
    expect(
      readDshModelObservation(
        {
          items: [
            {
              sessionId: "other-session",
              projections: { values: { modelSelection: { next: { model: "other" } } } },
            },
            {
              sessionId: "selected-session",
              projections: {
                values: { modelSelection: { next: { provider: "deepseek", model: "v4" } } },
              },
            },
          ],
        },
        "selected-session",
      ),
    ).toEqual({ provider: "deepseek", model: "v4" });
  });
});
