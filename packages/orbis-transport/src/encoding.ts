import { OrbisTransportError } from "./errors";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64_CHUNK_SIZE = 0x8000;

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(
  value: string,
  label: string,
  expectedLength?: number,
): Uint8Array {
  if (
    value.length === 0 ||
    value.includes("=") ||
    value.length % 4 === 1 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw new OrbisTransportError("invalid_argument", `${label} is not canonical base64url`);
  }

  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  } catch {
    throw new OrbisTransportError("invalid_argument", `${label} is not valid base64url`);
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  if (expectedLength !== undefined && bytes.byteLength !== expectedLength) {
    throw new OrbisTransportError(
      "invalid_argument",
      `${label} must contain exactly ${expectedLength} bytes`,
    );
  }

  if (bytesToBase64Url(bytes) !== value) {
    throw new OrbisTransportError("invalid_argument", `${label} is not canonical base64url`);
  }

  return bytes;
}

export function toOwnedArrayBuffer(value: ArrayBufferLike | ArrayBufferView): ArrayBuffer {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
  }
  return new Uint8Array(value).slice().buffer;
}
