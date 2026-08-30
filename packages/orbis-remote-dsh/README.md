# Orbis DSH Remote

`@orbisapp/remote-dsh` is the DeepSeek Harness Web bundle for the Orbis remote
DSH host. It lives entirely in this repository, does not modify the DeepSeek
Harness source tree, and contains the DSH adapter, remote host composition,
plugin lifecycle, and Web settings client as internal modules of one package.

The bundle adds **Settings → Plugins → Orbis** to DSH Web. It owns pairing, trusted
devices, DSH-registered workspace access, and the dedicated Orbis listener.
It attaches each accepted transport connection to `OrbisRemoteDshHost`; v2
methods become reachable only after the peer completes the `orbis.hello`
handshake. The host advertises the canonical v2 protocol rather than legacy
`dsh.*` methods or raw DSH events:

- `orbis.models.list`, `orbis.sessions.list`, `orbis.sessions.create`,
  `orbis.sessions.sync`, `orbis.sessions.entries`,
  `orbis.sessions.prompt`, `orbis.sessions.update`, and `orbis.sessions.cancel`;
- replayable terminal `entry.appended` events with host-assigned cursors,
  transient deltas, and ordered session-state updates;
- DSH `sessionPersistence` and the native harness runtime as catalog/transcript
  authority, with the node state storing only host identity, cursor indexes,
  and idempotency claims. There is no host transcript copy, ACK journal, or
  retention overlay.

The initial release supports two automatically discovered connection paths:

- **LAN:** private IPv4 addresses are discovered automatically on the standalone
  WebSocket listener (default port `47000`).
- **Tailnet:** Tailscale-style CGNAT IPv4 addresses are discovered automatically
  on that same listener.

Both paths carry the same authenticated encrypted protocol. Pairing uses one
available address. After authenticating the host, the encrypted welcome
publishes the current LAN and Tailnet addresses.

Direct `ws://` invitations are restricted to private/LAN, loopback, `.local`,
or Tailscale-style CGNAT addresses. A public direct endpoint must use WSS; the
bundle does not expose DSH Web as a remote endpoint and does not perform NAT
traversal.

## Local installation

```sh
cd public
pnpm install
pnpm run serve:dsh
```

The public workspace uses pnpm for every package. The public DSH SDK is used as
the build-time development dependency, while the generated plugin keeps DSH
imports external and receives the matching peer packages from the selected DSH
profile at runtime. The shared Orbis protocol packages are workspace
dependencies and are bundled into the plugin at build time. No DSH source
checkout is needed for a normal build or local Web run.

For the individual steps, run them from `public/`:

```sh
pnpm --filter @orbisapp/remote-dsh run build
pnpm --filter @orbisapp/remote-dsh exec dsh plugin --profile web add link:$PWD/packages/orbis-remote-dsh
DSH_TELEMETRY_DISABLED=1 pnpm --filter @orbisapp/remote-dsh exec dsh web
```

Adapter and host tests do not require the DSH SDK:

```sh
pnpm --filter @orbisapp/remote-dsh run check:core
```

For a local smoke check before installing the profile link:

```sh
pnpm install
pnpm --filter @orbisapp/remote-dsh run check
pnpm --filter @orbisapp/remote-dsh exec dsh plugin --profile web add link:$PWD/packages/orbis-remote-dsh
pnpm --filter @orbisapp/remote-dsh exec dsh plugin --profile web why @orbisapp/remote-dsh
```

The package also provides a one-command local Web launcher. It installs and builds
the bundle, installs it into the persistent DSH `web` profile, prints the active
profile dependency, and starts DSH Web on `127.0.0.1:3080`:

```sh
pnpm run serve:dsh
```

The launcher reuses `~/.dsh/profiles/web` and creates the workspace root in a
disposable temporary directory. It uses the package-local public DSH CLI by default.
Use `--dsh` to select a local Harness checkout, an exact GitHub tag or commit, or an
npm dist-tag/exact version:

```sh
pnpm run serve:dsh --dsh local:/path/to/deepseek-harness
pnpm run serve:dsh --dsh github:tag:dsh-v0.1.2-alpha.1
pnpm run serve:dsh --dsh github:commit:cd5ef8148158c3a752a658978873241fdf8e2bbc
pnpm run serve:dsh --dsh npm:latest
pnpm run serve:dsh --dsh-bin /path/to/dsh
pnpm run serve:dsh --port 3090 --keep
pnpm run serve:dsh --home "$DSH_HOME"
pnpm run serve:dsh --workspace-root /path/to/workspace
```

`local:` and both `github:` selectors run the selected checkout's frozen pnpm
install and full build before starting the resulting CLI. GitHub checkouts are
temporary and detached at the requested tag or commit. `npm:` installs the resolved
`@deepseek-ai/dsh` release into an isolated temporary directory, so selecting a DSH
does not rewrite this workspace's dependencies. `--keep` retains generated DSH
checkouts/installations as well as the temporary workspace. `ORBIS_DSH` accepts the
same selector syntax; `ORBIS_DSH_BIN` remains the executable override.
Selecting a source does not add cross-release compatibility behavior: the selected
DSH must satisfy the plugin's current peer and runtime contract.

Before refreshing the local plugin link, the launcher runs the active pnpm in
the existing Web profile. This safely realigns a profile created by an older
pnpm store version. It also removes the former development package names
`@orbis/dsh-orbis-remote` and `@orbis/remote-dsh`, so obsolete and current Orbis
bundles cannot load together. The launcher uses the public DSH CLI's normal profile installation
path. The default package-local source does not need a Harness checkout; explicit
`local:` and `github:` sources prepare and own their selected checkout as described above.

Open `http://127.0.0.1:3080`, then choose **Settings → Plugins → Orbis**. Stop the
launcher with Ctrl-C. DSH Web must remain on `127.0.0.1`; the Orbis data-plane
listener binds all network interfaces separately.

### Raw event recording for local E2E

The `serve:dsh` launcher enables a development-only recorder in the Orbis settings page. Choose
**Start recording** before an E2E action, **Stop recording** when the action is complete, and then
**Export JSONL**. The file contains the native Cordis `session/event` stream in arrival order before
the Orbis adapter projects or coalesces it. Recordings are stored with owner-only permissions under
`$DSH_HOME/orbis/recordings` and the HTTP export remains behind the loopback management fence.

To exercise the real mobile path again, choose an exported `.jsonl` file in the adjacent **Replay
raw DSH events** control. The plugin creates a fresh real DSH session and announces it through the
normal remote catalog. Open that new session in the Orbis app; replay waits for the app's live sync
before appending the captured native events on their original relative timeline. Those appends pass
through the normal DSH session log, Orbis adapter, coalescer, encrypted transport, mobile sync, and
UI. Replay currently accepts one native session per file and requires the recording's first native
sequence to match a fresh session boundary, so a partial mid-session capture fails explicitly rather
than producing a corrupt transcript. Recording and replay cannot run simultaneously.

Raw recordings are intentionally not redacted. They can contain prompts, model output, tool
arguments and results, workspace paths, and provider metadata. Treat every export as sensitive test
data and do not commit it as a fixture without reviewing its contents. The normal plugin runtime does
not expose the recorder; it is present only when `ORBIS_DSH_RAW_EVENT_RECORDING=1` is set on the DSH
server process. Set that variable to `0` when launching `serve:dsh` to test the production-disabled
surface.

`dsh plugin --profile web why @orbisapp/remote-dsh` prints the active local
package. Re-running `add` refreshes the profile link to the current build while
keeping the Harness-owned peer packages visible; a package version bump is not
required during local development.

Open the address printed by `dsh web`, choose **Settings → Plugins → Orbis**, and
save the computer name. The connection port is available under Advanced
Settings, while LAN and Tailnet addresses are discovered automatically. Turn on
remote access, create a pairing code, then scan it from Orbis on the phone. The
bundle restores remote access whenever `dsh web` starts.

Keep DSH Web on its default loopback host (`127.0.0.1`). Its privileged Orbis
management API refuses non-loopback origins and Host headers. The direct
transport listener is a separate, encrypted data-plane server and has no
management routes.

## Mobile DSH E2E

Plain `ws://` is permitted only for private LAN/Tailnet/local destinations.
Every candidate must complete the pinned host handshake before it can connect.

1. Start DSH Web locally: `DSH_TELEMETRY_DISABLED=1 dsh web`. Keep its Web
   listener on `127.0.0.1`.
2. In **Settings → Plugins → Orbis**, save the host name and port `47000`. LAN and Tailnet
   addresses are discovered automatically; do not advertise `127.0.0.1` or
   `localhost` to a physical phone. Turn on remote access and allow inbound TCP
   `47000` through the desktop firewall when using direct routes.
3. Build a fresh Orbis custom development client, not only a Metro refresh.
   iOS source configuration declares `NSAllowsLocalNetworking` and the local
   network usage description; grant the resulting iOS prompt on first use.
4. Keep the phone on the same local network or connect both devices through
   Tailscale, scan the pairing QR (or enter it manually), verify the safety
   number, and pair.
5. In Orbis, open **Remote**, tap the enabled DSH server, choose an existing
   DSH session, and submit a text prompt. DSH workspace creation remains in
   DSH Web for mobile because `orbis.sessions.create` requires an opaque
   registered `workspaceRef`.

On open, Orbis renders its encrypted per-host cache first and makes exactly one
`once` snapshot/replay refresh. It retains `live` delivery only for the session
where this phone submitted an unfinished run; navigating to another session or
away from the chat removes only the UI observer, never cancels that DSH run.

The present mobile configuration intentionally does not enable broad Android
cleartext traffic. Therefore validate this plain-LAN `ws://` path on iOS; an
Android deployment needs a reviewed secure endpoint policy (for example WSS)
before it can claim the same physical-device flow.

## State and credentials

- The host private identity uses DSH credentials under
  `ORBIS_DSH_HOST_IDENTITY_V1`.
- Only non-secret host configuration and paired public keys are stored in
  `$DSH_HOME/orbis/dsh-remote-host.v2.json` with owner-only permissions.
- The host-owned v2 cursor replica is separate:
  `$DSH_HOME/orbis/dsh-remote-agent.v2.json`. It contains session entry-id
  indexes and idempotency claims only; it is not the DSH transcript authority,
  does not store event payloads or ACKs, and owner-only permissions are not
  payload-level at-rest encryption.
- A pairing secret lives in memory only for its active invitation and is never
  written to disk.
- Server diagnostics are written as owner-only JSONL to
  `$DSH_HOME/orbis/dsh-remote-debug.jsonl` (override with plugin `logPath`); the
  file rolls to `.1` at 8 MiB. Entries include lifecycle, peer, request method,
  request id, session identity, duration, and redacted error metadata, but never
  prompt content, transcript payloads, pairing secrets, access tokens, or
  response bodies.

## Workspace and session semantics

DSH's registered workspace service is the authority for new remote sessions.
A paired client can browse configured server roots with `orbis.workspaces.browse`
and convert a selected opaque folder ref into a registered workspace with
`orbis.workspaces.register`. Responses never contain absolute server paths.
The plugin's optional `workspaceRoots` array controls the exposed roots and
defaults to the browse directory picker's Home location. Every request resolves symlinks
and rechecks containment before listing or registration.

A new `orbis.sessions.create` request must pass its opaque workspace id as
`workspaceRef`; it never accepts a filesystem path:

```json
{ "driverId": "dsh", "workspaceRef": "registered-workspace-id" }
```

The host resolves that ID through `ctx.workspace`, uses the registry's
canonical directory, and attaches the created session to the workspace. A
paired client cannot supply a filesystem path. Existing sessions are discovered
and projected through `ctx.sessionPersistence`, so they keep their persisted
DSH cwd and do not depend on current Orbis host configuration.

`orbis.sessions.list` remains a lightweight catalog read: it returns durable header
timestamps plus the title in DSH Web's persisted projection cache when one is
available. A missing or stale cache row only omits that display label; the
catalog never opens a historical transcript just to list it.

Closing a mobile page or an encrypted socket only detaches the remote observer;
it never cancels/disposes a DSH run. Only plugin/host shutdown closes the
owned DSH controllers.

## Real DSH profile E2E (explicit opt-in)

The package includes a repeatable LAN-only runner at
`scripts/real-profile-e2e.ts`. It creates a disposable DSH home, profile
plugin link, workspace, loopback web port, direct transport port, and state
files; provisions an opaque workspace through DSH Web's real
`/api/workspace.create` RPC; then performs direct AuthPSK pairing followed by
authenticated reconnects through `OrbisRemoteAgentV2Connection`.

The runner covers driver/session discovery, opaque `workspaceRef` create/list,
snapshot sync, model catalog discovery and selection through DSH's shared
session gateway, short prompts, cursor-index reconnect replay, idempotent
writes, state permissions/no-secret assertions, and a full DSH Web restart. It
does not assert provider-generated text and it never uses a fake backend or transport.
Replay is bounded by the native DSH transcript and the persisted entry-id
index; the host does not maintain a second event log.

```sh
# from this package; without a provider key this still runs the real
# profile/pairing/model-selection smoke and skips only prompt/replay phases
ORBIS_DSH_REAL_E2E=1 pnpm run e2e:real

# provider credentials extend the same fixture through real prompt/replay phases
ORBIS_DSH_REAL_E2E=1 DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" pnpm run e2e:real

# fail instead of skip when dsh/provider prerequisites are absent
ORBIS_DSH_REAL_E2E=1 ORBIS_DSH_REAL_E2E_STRICT=1 pnpm run e2e:real
```

Useful controls are `ORBIS_DSH_BIN`, `ORBIS_DSH_E2E_ROOT` (a parent for the
new disposable fixture), and `ORBIS_DSH_E2E_KEEP=1` (preserve the fixture for
local forensics). The runner
always sets an isolated `DSH_HOME`, binds DSH Web to `127.0.0.1`, and removes
the ambient Orbis identity environment variable. The disposable runner
discovers the local LAN endpoint. The runner never touches
the mobile app or its integration tests.

The compatibility gate checks `dsh --version` (expected `0.1.0-rc.6`), the
launcher `--patch` flag, and Web's `--host`/`--port` flags before creating a fixture. Set
`ORBIS_DSH_EXPECTED_VERSION` only for another explicitly reviewed DSH
profile; an unreviewed or missing CLI is a clear skip by default and a
failure in strict mode.

Host identity rotation is exercised only inside the disposable fixture: the
runner stops DSH Web, removes the isolated `$DSH_HOME/.env` identity, verifies
that an old pinned client is rejected, and verifies that a newly paired client
cannot open the old host-key-bound delivery state. It restores that fixture
file before cleanup. Production rotation still requires an explicit migration
API; the runner never deletes or mutates a user's profile.
