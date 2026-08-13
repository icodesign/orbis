import { Address4, Address6 } from "ip-address";

import { isValidHeaderCredential } from "./credential";
import { OrbisTransportError } from "./errors";

export const OPEN_READY_STATE = 1;

export function defaultCreateId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new OrbisTransportError(
      "invalid_argument",
      "This runtime must inject createId because crypto.randomUUID is unavailable",
    );
  }
  return globalThis.crypto.randomUUID();
}

export function validateSocketUrl(
  value: string,
  ticket: string,
  allowInsecureWebSocket: boolean,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OrbisTransportError("protocol", "The connection ticket contained an invalid URL");
  }
  if (url.protocol !== "wss:" && !(allowInsecureWebSocket && url.protocol === "ws:")) {
    throw new OrbisTransportError("insecure_transport", "The Orbis data plane requires WSS");
  }
  if (url.username || url.password || url.hash) {
    throw new OrbisTransportError(
      "protocol",
      "The WebSocket URL must not contain credentials or a fragment",
    );
  }
  if (value.includes(ticket) || value.includes(encodeURIComponent(ticket))) {
    throw new OrbisTransportError(
      "protocol",
      "The connection ticket must not be embedded in the WebSocket URL",
    );
  }
  return url;
}

// These are the only IPv4 destination ranges that may carry a direct
// WebSocket without TLS. `Address4.isPrivate()` intentionally excludes
// loopback, link-local, and CGNAT, all of which are local-network routes that
// direct mode explicitly supports.
const PRIVATE_DIRECT_IPV4_SUBNETS = [
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
] as const;
const PRIVATE_DIRECT_IPV6_SUBNETS = ["::1/128", "fc00::/7", "fe80::/10"] as const;

function isPrivateIpv4Address(hostname: string): boolean {
  if (!Address4.isValid(hostname)) {
    return false;
  }
  const address = new Address4(hostname);
  return PRIVATE_DIRECT_IPV4_SUBNETS.some((subnet) => address.isInSubnet(new Address4(subnet)));
}

function isPrivateIpv6Address(hostname: string): boolean {
  if (!Address6.isValid(hostname)) {
    return false;
  }
  const address = new Address6(hostname);
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) follows the IPv4 classification. The
  // WHATWG URL parser normalizes the embedded IPv4 to hex groups, so `is4()`
  // (which only matches dotted decimal) cannot be relied on; use the /96 prefix.
  if (address.isInSubnet(new Address6("::ffff:0:0/96"))) {
    return isPrivateIpv4Address(address.to4().correctForm());
  }
  return PRIVATE_DIRECT_IPV6_SUBNETS.some((subnet) => address.isInSubnet(new Address6(subnet)));
}

function isPrivateDirectHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized.endsWith(".local")) {
    return true;
  }
  return isPrivateIpv4Address(normalized) || isPrivateIpv6Address(normalized);
}

/**
 * Direct peers may use plain WebSocket only on a local or private network.
 * The payload and pairing remain HPKE-authenticated end-to-end, but this keeps
 * unauthenticated cleartext WebSocket metadata off the public internet. A
 * public direct endpoint must provide WSS.
 */
export function validateDirectSocketUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OrbisTransportError("invalid_argument", "The direct WebSocket URL is invalid");
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new OrbisTransportError(
      "insecure_transport",
      "A direct endpoint must use WebSocket or secure WebSocket",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new OrbisTransportError(
      "invalid_argument",
      "The direct WebSocket URL must not contain credentials, a query, or a fragment",
    );
  }
  if (url.protocol === "ws:" && !isPrivateDirectHostname(url.hostname)) {
    throw new OrbisTransportError("insecure_transport", "A public direct endpoint must use WSS");
  }
  return url;
}

export function validateTicketCredential(ticket: string): void {
  if (!isValidHeaderCredential(ticket, 16_384)) {
    throw new OrbisTransportError("protocol", "The connection ticket is not a valid credential");
  }
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function validateTicketLifetime(
  expiresAt: string,
  now: number,
  maxTicketLifetimeMs: number,
): void {
  if (!Number.isFinite(maxTicketLifetimeMs) || maxTicketLifetimeMs <= 0) {
    throw new OrbisTransportError(
      "invalid_argument",
      "maxTicketLifetimeMs must be a positive number",
    );
  }
  const ticketLifetimeMs = Date.parse(expiresAt) - now;
  if (ticketLifetimeMs <= 0) {
    throw new OrbisTransportError("authentication", "The connection ticket has expired");
  }
  if (ticketLifetimeMs > maxTicketLifetimeMs) {
    throw new OrbisTransportError(
      "authentication",
      "The connection ticket lifetime exceeds the allowed maximum",
    );
  }
}
