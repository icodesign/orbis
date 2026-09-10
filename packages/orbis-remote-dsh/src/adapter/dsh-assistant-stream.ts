import {
  AssistantStreamAccumulator,
  expandAssistantStream,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";

import type { DshAssistantStreamFrame } from "./dsh-types";

/** Retains only the active attempt so a newly attached observer gets its complete prefix. */
export class DshAssistantStreamBuffer {
  private start?: Extract<DshAssistantStreamFrame, { type: "start" }>;
  private stream = new AssistantStreamAccumulator();
  private index = 0;
  private revision = 0;

  accept(frame: DshAssistantStreamFrame): void {
    if (frame.revision <= this.revision) return;
    if (frame.type === "start") {
      this.start = frame;
      this.stream = new AssistantStreamAccumulator();
      this.index = 0;
    } else if (frame.type === "end") {
      this.start = undefined;
      this.stream = new AssistantStreamAccumulator();
    } else if (this.start !== undefined) {
      if (
        frame.attemptId !== this.start.attemptId ||
        frame.index !== this.index ||
        frame.revision !== this.revision + 1
      ) {
        this.start = undefined;
        this.stream = new AssistantStreamAccumulator();
      } else {
        this.stream.push({ time: frame.time, chunk: frame.chunk as StreamChunk });
        this.index += 1;
      }
    }
    this.revision = frame.revision;
  }

  snapshot(): readonly DshAssistantStreamFrame[] {
    const start = this.start;
    if (start === undefined) return [];
    return [
      start,
      ...expandAssistantStream(this.stream.snapshot()).map(
        ({ time, chunk }, index): DshAssistantStreamFrame => ({
          type: "chunk",
          attemptId: start.attemptId,
          revision: start.revision + index + 1,
          index,
          time,
          chunk,
        }),
      ),
    ];
  }
}
