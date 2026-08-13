# `@orbis/remote-agent-node-store`

This package contains the host-side file stores for the remote agent protocol.
The DSH host and the mobile v2 path use `NodeFileRemoteAgentV2HostStore`:

- host identity and opaque `hostRevision`;
- session `cursor → entryId` indexes only;
- bounded idempotency admissions and their JSON receipts.

It never stores transcript payloads, per-device ACK watermarks, or a replay
event log. DSH's native `sessionPersistence` remains the transcript authority.

```ts
import { NodeFileRemoteAgentV2HostStore } from "@orbis/remote-agent-node-store";

const store = new NodeFileRemoteAgentV2HostStore({
  hostId: "host-a",
  hostKeyId: "sha256:host-static-key",
  path: "/var/lib/orbis/agent-state.v2.json",
});
```

The v2 state file is bound to `hostId` and the host's static public-key
fingerprint, atomically replaced through a synced owner-only temporary file,
and rejected if its permissions grant group/world access. A host-key rotation
therefore requires explicit state migration or cleanup. It is a
**single-host-process** store: do not share one path across independently
running host processes.

The file contains no transcript payload or tool output. Permissions limit ordinary local exposure but are
not payload encryption; deployment must rely on the host OS/account storage policy (for example, encrypted
disk and an isolated service account). Private device identity, pairing secrets, relay tickets, and account
credentials do not belong in this file.
