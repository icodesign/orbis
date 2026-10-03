import { describe, expect, test } from "vitest";

import { DshSessionEntryProjector, runFinishForDshEvent } from "./dsh-projection";

function toolResult(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    seq: 1,
    time: 10,
    type: "tool/result",
    data: {
      turn: 1,
      step: 1,
      message: {
        id: "result-1",
        role: "tool",
        source: { kind: "tool", callId: "call-1" },
        toolCallId: "call-1",
        content,
        ...extra,
      },
    },
  };
}

describe("DSH V4 projection contract", () => {
  test.each([
    { content: [] },
    {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    },
  ])("projects direct result content, including empty and multiple blocks: %j", ({ content }) => {
    const projector = new DshSessionEntryProjector();
    projector.project({
      seq: 0,
      time: 0,
      type: "tool/call",
      data: {
        callId: "call-1",
        name: "read",
        arguments: '{"path":"demo.txt"}',
        turn: 1,
        step: 1,
      },
    });
    expect(projector.project(toolResult(content))).toMatchObject({
      kind: "tool",
      id: "tool-call-1",
      name: "read",
      input: { path: "demo.txt" },
      content,
      output: content,
      status: "success",
    });
  });

  test("preserves image metadata and the message-level error flag", () => {
    const image = {
      type: "image",
      attachment: {
        attachmentId: "image-1",
        bytes: 3,
        height: 1,
        width: 1,
        mediaType: "image/png",
      },
    };
    expect(
      new DshSessionEntryProjector().project(toolResult([image], { isError: true })),
    ).toMatchObject({
      status: "error",
      content: [{ type: "image_reference", attachmentId: "image-1" }],
    });
  });

  test("rejects mismatched call identity and obsolete V3 wrappers", () => {
    const projector = new DshSessionEntryProjector();
    expect(() => projector.project(toolResult([], { toolCallId: "another-call" }))).toThrow(
      "not paired",
    );
    expect(() => projector.project(toolResult([], { role: "user" }))).toThrow("not paired");
  });

  test("keeps developer changes as scoped context with their native header reference", () => {
    const projector = new DshSessionEntryProjector();
    projector.project({ seq: 0, time: 0, type: "turn/start", data: { turn: 1 } });
    projector.project({ seq: 1, time: 0, type: "step/start", data: { turn: 1, step: 1 } });
    const data = {
      turn: 1,
      step: 1,
      headerSeq: 2,
      message: {
        role: "developer",
        source: { kind: "tool-update" },
        content: [
          { type: "tool-addition", toolName: "read" },
          { type: "tool-removal", toolName: "write" },
        ],
      },
    };
    expect(projector.project({ seq: 3, time: 0, type: "developer/message", data })).toMatchObject({
      kind: "context",
      origin: "inject",
      label: "Tools",
      scope: { runId: "turn-1", stepId: "1" },
      content: [
        { type: "text", text: "Added tool: read" },
        { type: "text", text: "Removed tool: write" },
      ],
      _meta: { dsh: { kind: "tool-update" }, dshDeveloper: data },
    });
  });

  test("reads a fork-closed turn without inventing a failed run", () => {
    expect(
      runFinishForDshEvent({
        seq: 1,
        time: 0,
        type: "turn/end",
        data: {
          turn: 1,
          reason: { kind: "forked" },
        },
      }),
    ).toMatchObject({ outcome: "completed" });
  });
});
