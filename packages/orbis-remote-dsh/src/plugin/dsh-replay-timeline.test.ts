import { expect, test } from "vitest";

import { dshReplayTimeline } from "./dsh-replay-timeline";

test("replays compact V3 chunks around interleaved durable events and settles last", () => {
  const timeline = dshReplayTimeline(
    [
      {
        capturedAtMs: 100,
        eventTime: 100,
        event: { seq: 0, type: "step/start", data: { turn: 1, step: 1 } },
      },
      {
        capturedAtMs: 125,
        eventTime: 125,
        event: { seq: 1, type: "agent/inbox/spliced", data: {} },
      },
      {
        capturedAtMs: 150,
        eventTime: 150,
        event: {
          seq: 2,
          type: "assistant/message",
          surfaceOp: "append",
          data: {
            turn: 1,
            step: 1,
            stream: [
              { type: "text-chunks", time0: 110, index: 0, texts: ["hello", " world"], dt: [20] },
            ],
          },
        },
      },
    ],
    "replay",
  );
  expect(timeline.map(({ at, kind }) => [at, kind])).toEqual([
    [100, "event"],
    [110, "frame"],
    [110, "frame"],
    [125, "event"],
    [130, "frame"],
    [150, "event"],
    [150, "end"],
  ]);
  expect(timeline[4]).toMatchObject({
    frame: { index: 1, chunk: { type: "text-delta", text: " world" } },
  });
  expect(timeline.at(-1)).toMatchObject({ attemptId: "replay:2", seq: 2, index: 2 });
});

test("refuses malformed streams before starting replay", () => {
  expect(() =>
    dshReplayTimeline(
      [
        {
          capturedAtMs: 10,
          eventTime: 10,
          event: {
            seq: 0,
            type: "assistant/attempt",
            data: {
              turn: 1,
              step: 1,
              stream: [{ type: "text-chunks", time0: 1, index: 0, texts: ["a", "b"], dt: [] }],
            },
          },
        },
      ],
      "replay",
    ),
  ).toThrow();
});
