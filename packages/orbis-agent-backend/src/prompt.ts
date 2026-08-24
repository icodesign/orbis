import type { AgentPromptInput } from "./backend";
import { AgentBackendError } from "./errors";
import type { AgentPromptContentBlock } from "./events";
import { agentTimestamp } from "./identifiers";

const MAX_PROMPT_TEXT_LENGTH = 65_536;
const MAX_IMAGE_NAME_LENGTH = 512;

function invalid(message: string): never {
  throw new AgentBackendError("invalid_argument", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROMPT_TEXT_LENGTH) {
    return invalid(`${label} is invalid`);
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 0x7f || (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
      return invalid(`${label} is invalid`);
    }
  }
  return value;
}

function nonEmpty(value: unknown, label: string, maxLength = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim()
  ) {
    return invalid(`${label} is invalid`);
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return invalid(`${label} is invalid`);
  }
  return value;
}

function base64(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 === 1 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    return invalid(`${label} is invalid`);
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const significantEnd = value.endsWith("==")
    ? value.length - 2
    : value.endsWith("=")
      ? value.length - 1
      : value.length;
  const trailingIndex = alphabet.indexOf(value[significantEnd - 1] ?? "");
  if (value.endsWith("==") && (trailingIndex < 0 || (trailingIndex & 0x0f) !== 0)) {
    return invalid(`${label} is not canonical base64`);
  }
  if (
    value.endsWith("=") &&
    !value.endsWith("==") &&
    (trailingIndex < 0 || (trailingIndex & 0x03) !== 0)
  ) {
    return invalid(`${label} is not canonical base64`);
  }
  return value;
}

function promptBlock(value: unknown): AgentPromptContentBlock {
  const input = record(value, "Prompt content block");
  if (input.type === "text") {
    return { text: text(input.text, "Prompt text"), type: "text" };
  }
  if (input.type === "image") {
    return {
      data: base64(input.data, "Prompt image data"),
      mimeType: nonEmpty(input.mimeType, "Prompt image MIME type"),
      ...(input.name === undefined
        ? {}
        : { name: nonEmpty(input.name, "Prompt image name", MAX_IMAGE_NAME_LENGTH) }),
      type: "image",
    };
  }
  return invalid("Prompt content block type is invalid");
}

/** Validate the narrow prompt surface before a backend driver receives it. */
export function validateAgentPromptInput(value: unknown): AgentPromptInput {
  const input = record(value, "Prompt input");
  if (!Array.isArray(input.content) || input.content.length === 0) {
    return invalid("Prompt content is required");
  }
  const content = input.content.map(promptBlock);
  if (!content.some((block) => block.type === "image" || block.text.trim().length > 0)) {
    return invalid("Prompt content must not be empty");
  }
  return {
    content,
    ...(input.delivery === undefined
      ? {}
      : input.delivery === "steer" || input.delivery === "follow_up"
        ? { delivery: input.delivery }
        : invalid("Prompt delivery is invalid")),
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: nonEmpty(input.idempotencyKey, "Prompt idempotency key", 1024) }),
  };
}

export function validateAgentAttachmentReadResult(value: unknown) {
  const input = record(value, "Attachment read result");
  const result = {
    attachmentId: nonEmpty(input.attachmentId, "Attachment id", 1024),
    data: base64(input.data, "Attachment data"),
    mimeType: nonEmpty(input.mimeType, "Attachment MIME type"),
    ...(input.name === undefined
      ? {}
      : { name: nonEmpty(input.name, "Attachment name", MAX_IMAGE_NAME_LENGTH) }),
    ...(input.bytes === undefined
      ? {}
      : { bytes: positiveInteger(input.bytes, "Attachment bytes") }),
    ...(input.width === undefined
      ? {}
      : { width: positiveInteger(input.width, "Attachment width") }),
    ...(input.height === undefined
      ? {}
      : { height: positiveInteger(input.height, "Attachment height") }),
  };
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid(`${label} is invalid`);
  return value as number;
}
