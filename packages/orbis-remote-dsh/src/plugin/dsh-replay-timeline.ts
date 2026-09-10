import { expandAssistantStream, type AssistantStreamRecord } from "@deepseek-ai/dsh-llm";

import type { DshAssistantStreamFrame } from "../adapter/dsh-types";
import type { OrbisDshRawEventReplayEvent } from "./raw-dsh-event-replayer";

export interface DshCapturedReplayEvent {
  readonly capturedAtMs: number;
  readonly eventTime: number;
  readonly event: OrbisDshRawEventReplayEvent;
}

export type DshReplayTimelineItem =
  | { readonly at: number; readonly kind: "event"; readonly event: OrbisDshRawEventReplayEvent }
  | { readonly at: number; readonly kind: "frame"; readonly frame: DshAssistantStreamFrame }
  | {
      readonly at: number;
      readonly kind: "end";
      readonly attemptId: string;
      readonly index: number;
      readonly eventType: "assistant/message" | "assistant/attempt";
      readonly seq: number;
    };

/** Expand V3 settlements into the original interleaved live and durable timeline. */
export function dshReplayTimeline(
  events: readonly DshCapturedReplayEvent[],
  replayId: string,
): readonly DshReplayTimelineItem[] {
  const timeline: DshReplayTimelineItem[] = [];
  for (const { event, eventTime, capturedAtMs } of events) {
    if (event.type !== "assistant/message" && event.type !== "assistant/attempt") {
      timeline.push({ at: capturedAtMs, kind: "event", event });
      continue;
    }
    const data = event.data as { turn?: unknown; step?: unknown; stream?: unknown };
    if (
      data === null ||
      typeof data !== "object" ||
      !Number.isSafeInteger(data.turn) ||
      !Number.isSafeInteger(data.step) ||
      !Array.isArray(data.stream)
    ) {
      throw new Error("The replay contains an invalid V3 assistant settlement");
    }
    const chunks = expandAssistantStream(data.stream as AssistantStreamRecord[]);
    if (chunks.some(({ time }) => time > eventTime))
      throw new Error("The replay contains a chunk after its settlement");
    const attemptId = `${replayId}:${event.seq}`;
    timeline.push({
      at: capturedAtMs + (chunks[0]?.time ?? eventTime) - eventTime,
      kind: "frame",
      frame: {
        type: "start",
        revision: 0,
        attemptId,
        turn: data.turn as number,
        step: data.step as number,
      },
    });
    for (const [index, { chunk, time }] of chunks.entries()) {
      timeline.push({
        at: capturedAtMs + time - eventTime,
        kind: "frame",
        frame: { type: "chunk", revision: 0, attemptId, index, time, chunk },
      });
    }
    timeline.push({ at: capturedAtMs, kind: "event", event });
    timeline.push({
      at: capturedAtMs,
      kind: "end",
      attemptId,
      index: chunks.length,
      eventType: event.type,
      seq: event.seq,
    });
  }
  // Stable sorting preserves durable order and emits a settlement before its end.
  return timeline.sort((left, right) => left.at - right.at);
}
