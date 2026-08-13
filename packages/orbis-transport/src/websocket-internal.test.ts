import { describe, expect, test } from "vitest";

import { OrbisTransportError } from "./errors";
import { validateDirectSocketUrl } from "./websocket-internal";

function accepts(url: string): void {
  expect(() => validateDirectSocketUrl(url)).not.toThrow();
}

function rejectsInsecure(url: string): void {
  try {
    validateDirectSocketUrl(url);
    throw new Error("Expected validateDirectSocketUrl to reject the URL");
  } catch (error) {
    expect(error).toBeInstanceOf(OrbisTransportError);
    expect((error as OrbisTransportError).code).toBe("insecure_transport");
  }
}

describe("direct socket URL address classification", () => {
  test("allows plain ws for loopback, private, and link-local addresses", () => {
    accepts("ws://127.0.0.1:8080/orbis");
    accepts("ws://localhost:8080/orbis");
    accepts("ws://10.0.0.5:8080/orbis");
    accepts("ws://172.16.4.2:8080/orbis");
    accepts("ws://192.168.1.50:8080/orbis");
    accepts("ws://100.64.0.9:8080/orbis");
    accepts("ws://169.254.10.20:8080/orbis");
    accepts("ws://[::1]:8080/orbis");
    accepts("ws://[fd00::1]:8080/orbis");
    accepts("ws://[fdaa:bbcc::1]:8080/orbis");
    accepts("ws://[fe80::1]:8080/orbis");
    accepts("ws://[feb0::1]:8080/orbis");
    accepts("ws://[::ffff:192.168.1.5]:8080/orbis");
    accepts("ws://my-mac.local:8080/orbis");
  });

  test("requires wss for public hostnames, including fc/fd-prefixed domains", () => {
    rejectsInsecure("ws://fcloud.io:8080/orbis");
    rejectsInsecure("ws://fc.example.com:8080/orbis");
    rejectsInsecure("ws://fd.mydomain.org:8080/orbis");
    rejectsInsecure("ws://8.8.8.8:8080/orbis");
    rejectsInsecure("ws://200.1.2.3:8080/orbis");
    rejectsInsecure("ws://[2001:db8::1]:8080/orbis");
    rejectsInsecure("ws://[::ffff:8.8.8.8]:8080/orbis");
  });

  test("does not widen plain ws past the exact loopback, link-local, and CGNAT ranges", () => {
    rejectsInsecure("ws://126.255.255.255:8080/orbis");
    rejectsInsecure("ws://128.0.0.0:8080/orbis");
    rejectsInsecure("ws://100.63.255.255:8080/orbis");
    rejectsInsecure("ws://100.128.0.0:8080/orbis");
    rejectsInsecure("ws://169.253.255.255:8080/orbis");
    rejectsInsecure("ws://169.255.0.0:8080/orbis");
  });

  test("still accepts the same endpoint over wss regardless of address", () => {
    accepts("wss://fcloud.io:8443/orbis");
    accepts("wss://fc.example.com:8443/orbis");
    accepts("wss://192.168.1.50:8443/orbis");
  });
});
