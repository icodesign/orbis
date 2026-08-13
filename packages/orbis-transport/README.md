# `@orbis/transport`

Harness-neutral pairing, endpoint discovery, and end-to-end encrypted WebSocket transport for Orbis
clients and remote hosts.

The transport is independent of the private Orbis product application and can
be embedded by a host or client adapter.

## Cryptographic protocol

Every peer payload is protected above HTTPS/WSS with RFC 9180 HPKE:

- KEM: DHKEM(X25519, HKDF-SHA256)
- KDF: HKDF-SHA256
- AEAD: ChaCha20-Poly1305
- initial pairing: HPKE AuthPSK, combining both static X25519 identities with a one-time 256-bit PSK
- later connections: HPKE Auth, pinned to the two static X25519 public keys

The host proves possession of its pinned private key; the client proves possession of its private
key; the one-time PSK proves possession of the QR/manual invitation. A 12-digit safety number is
derived from the ordered client and host public keys for out-of-band comparison.

The pairing secret appears only in the short-lived `orbis://pair` invitation and the two endpoints'
memory. Pairing links pin the host public key, expiry, one bootstrap WebSocket endpoint, and requested
scopes. The full endpoint catalog is never trusted from a QR code or relay: the host sends it inside
the encrypted welcome. A host must atomically consume the PSK and persist the client key/scopes only
after the AuthPSK hello decrypts successfully.

The portable HPKE adapter injects pure-JavaScript SHA-256/HMAC/HKDF into the maintained hpke-js
state machine because React Native does not consistently expose WebCrypto HKDF. X25519 and
ChaCha20-Poly1305 remain hpke-js primitives. All identity and ephemeral entropy is supplied through
the mandatory `SecureRandom` seam; there is no weak-random fallback. A conformance test compares the
portable result byte-for-byte with the maintained WebCrypto-backed suite for identical inputs.

## Ownership

This package owns:

- strict optional HTTPS control-plane schemas and short-lived connection tickets;
- complete QR/manual bootstrap invitation and revisioned endpoint-manifest validation;
- client and multi-peer host WebSocket endpoints;
- concurrent-route activation, AuthPSK/Auth handshakes, encrypted request/response/cancel/event/ACK
  frames, replay/order checks, frame limits, and redacted errors;
- a harness router with method ownership and required-scope enforcement.

It does not own platform credential persistence, account login, app navigation, workspace policy,
or Pi/DeepSeek session semantics. Mobile stores its static private identity in SecureStore and only
display-safe pinned host metadata in SQLite. Host runtimes inject their own secure identity store,
paired-client store, relay tickets, and workspace authorization.

## Pairing and endpoint-race flow

1. A host creates a static identity, a one-time PSK, and a revisioned catalog containing every
   configured LAN, Tailnet, Tunnel, and relay endpoint.
2. The `orbis://pair` invitation carries one currently available bootstrap endpoint, the PSK, and the
   pinned host public key. It does not duplicate the full route catalog.
3. The first WebSocket completes AuthPSK. Only a successful decrypt allows the host to commit the
   client key and send its endpoint catalog in the encrypted welcome.
4. The client persists that catalog only when its `hostId` and `hostKeyId` match the pinned identity
   and its revision is monotonic.
5. Future reconnects use one shared `raceId` and release Auth handshakes in LAN, Tailnet, Tunnel,
   then relay preference stages. Each successful handshake remains provisional. The client activates
   the fastest one, waits for its encrypted activation ACK, and aborts/closes the losers and
   not-yet-started stages before agent traffic.

The blind relay sees route ids, handshake ids, timing, and encrypted frame sizes. It cannot read peer
descriptors, methods, parameters, results, prompts, responses, or agent events. LAN and Tunnel
providers use the same protocol without relay-specific behavior.

## Harness router

Pi and DSH adapters register independent leases with `OrbisRemoteHarnessRouter`. Every method must
declare required scopes. The router rejects an unauthorized static client key before calling the
harness handler; adapters do not duplicate authentication policy.

```ts
const router = new OrbisRemoteHarnessRouter();
const close = router.attachBroadcaster(hostConnection);

await router.open({
  harnessId: "example",
  methods: ["example.session.describe"],
  methodScopes: { "example.session.describe": [ORBIS_REMOTE_SCOPES.agentRead] },
  eventScopes: [ORBIS_REMOTE_SCOPES.agentRead],
  handleRequest: async () => ({ state: "idle" }),
});
```

## Operational constraints

- Public control/data URLs must be HTTPS/WSS. Plain WS is restricted to loopback, private LAN,
  `.local`, or Tailnet destinations.
- Tickets travel only in the WebSocket Upgrade `Authorization` header, never in a URL.
- The access-token provider receives the normalized destination `serverUrl` for every request; an
  application must refuse credentials for untrusted control-plane URLs.
- Mutations are not automatically retried.
- The encrypted host welcome advertises its receive-frame ceiling; the client sends against the
  smaller of that value and its local ceiling. `RemoteHostRequestContext.maxResponseBytes` is the
  remaining UTF-8 JSON budget for a host handler's `result` after response and encryption envelopes
  are reserved.
- An oversized plaintext is rejected before HPKE consumes its sequence. If a post-seal send cannot
  complete, that channel is terminated instead of emitting a later sequence.
- Reconnect remains application-owned because correct replay requires persisted event cursors.
- Durable events are ACKed only after the consumer persists them.
- Errors never retain response bodies, tokens, tickets, private seeds, or pairing secrets.

## Validation

```sh
pnpm --filter @orbis/transport run typecheck
pnpm --filter @orbis/transport run test
```
