import { describe, expect, test } from "vitest";

import { peerDescriptorSchema } from "./protocol";

describe("peerDescriptorSchema", () => {
  test("accepts a user-facing device name without changing the stable id", () => {
    expect(
      peerDescriptorSchema.parse({
        deviceId: "sha256:client",
        deviceName: "Lance's iPhone",
        role: "client",
        version: "1.0.0",
      }),
    ).toEqual({
      deviceId: "sha256:client",
      deviceName: "Lance's iPhone",
      role: "client",
      version: "1.0.0",
    });
  });

  test("keeps legacy descriptors valid while older clients reconnect", () => {
    expect(
      peerDescriptorSchema.parse({
        deviceId: "sha256:legacy-client",
        role: "client",
        version: "1.0.0",
      }),
    ).toEqual({
      deviceId: "sha256:legacy-client",
      role: "client",
      version: "1.0.0",
    });
  });
});
