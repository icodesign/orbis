# @orbisapp/remote-dsh

## 0.5.0

### Minor Changes

- 05c2a37: Add `next_run` prompt delivery and queued-input withdrawal. A prompt sent while the session is busy can be held by the plugin and started as a new run once the active run completes, and a held input can be withdrawn before it starts. The driver advertises both through the `prompt.next_run` and `prompt.queue.withdraw` capabilities.
  
  Fix sessions failing to open or sync when an assistant message contains an empty text or reasoning block. DeepSeek models at low reasoning effort return an empty reasoning block that carries only a replay signature; such blocks are now skipped instead of rejecting the whole session.

## 0.4.0

### Minor Changes

- 7276d2e: Support DeepSeek Harness 0.2.0-rc.2 and its V4 session format. Project native tool results and dynamic tool changes, read cached titles for ordinary and forked sessions, and rebase developer-event references during replay. Update the bundled Settings icon to the current DSH export.
  
  Use the session controller's revisions consistently for remote events and snapshots. Raw replay now requires recording format version 2 with Session format 4.
  
  Read live and cold sessions through native observations and use native work-state projections. Keep plan/todo read units available before Web presets open an Agent; preserve Orbis enqueue timestamps and protocol revisions.
  
  Requires the supported DSH 0.2 release line; older 0.1 hosts are no longer supported.

## 0.3.0

### Minor Changes

- 65d2666: Support DeepSeek Harness 0.1.5-rc.1, including its new session format and streaming API. Preserve streamed responses across retries and reconnects, restore system messages from session history, and update event replay for the new format.
  
  Requires DeepSeek Harness 0.1.5-rc.1 or newer within the supported 0.1 release line. Earlier DSH versions are no longer supported by this plugin release.

## 0.2.9

### Upgrade Notes

The version only supports DeepSeek Harness 0.1.2-rc.1+ and iOS app 0.1.0 (Build 25+).

### Patch Changes

- c0a5281: Show why Orbis could not start instead of blaming the network. The settings page rendered a fixed "check the network connection" message for every access failure, so an incompatible DSH build reported itself as a network problem and retrying could never help. The status banner and the turn on/off actions now surface the real reason, keeping the generic wording only for a failure that carries no message.
- 78cff32: Support DeepSeek Harness 0.1.2-rc.1. Upstream published rc.1 as a version bump of 0.1.2-alpha.5 with no functional change, so this moves the dependency graph, the reviewed acceptance pin, and the documented compatibility gate onto rc.1.

## 0.2.8

### Upgrade Notes

The version only supports DeepSeek Harness 0.1.2-alpha.5+ and iOS app 0.1.0 (Build 25+).

### New Features

- Support DeepSeek Harness 0.1.2-alpha.5.

### Patch Changes

- 2ed4730: Support DeepSeek Harness 0.1.2-alpha.5. The Session log is now read through `snapshotEvents()` and `eventAt()` after alpha.4 removed the `events` getter, and the durable projection cache is consulted with the lineage cut its identity is bound to.
  
  Run the complete real-profile prompt, durable-usage, reconnect, and restart acceptance without provider credentials through DSH's official deterministic LLM replay adapter, while preserving the credentialed live-provider canary.

## 0.2.7

### Upgrade Notes

The version only supports DeepSeek Harness 0.1.2-alpha.2+ and iOS app 0.1.0 (Build 25+).

### New Features

- Support DeepSeek Harness 0.1.2-alpha.2 and 0.1.2-alpha.3.
- Add support-safe Remote Diagnostics export.

### Patch Changes

- 448e7ae: Start Orbis remote access on first install with the system host name and default port, without requiring an initial settings save.
  
  Show a temporary checkmark and copied label on the pairing-link button after copying succeeds.
- 8c09dab: Add a one-click, support-safe diagnostics export to the DSH plugin settings page. Correlate recent
  Remote requests and original DSH failures by request ID while omitting credentials, endpoints,
  pairing material, prompts, transcripts, tool payloads, and raw event recordings.
- 448e7ae: Avoid advertising unreachable WSL NAT addresses in pairing links. The plugin settings page now shows the host machine, WSL networking mode, reachable phone routes, and a localized link to the English or Simplified Chinese WSL connection guide.
- 8c09dab: Fix Remote DSH startup on Windows by avoiding POSIX group and other permission checks against Node's synthesized Windows file mode.
- 448e7ae: Support DeepSeek Harness 0.1.2-alpha.3 across the Host session, permission, error, client slot, and prompt-reference contracts.
  
  Run the complete real-profile prompt, durable-usage, reconnect, and restart acceptance without provider credentials through DSH's official deterministic LLM replay adapter, while preserving the credentialed live-provider canary.

## 0.2.6

### Patch Changes

- 6bf755a: feat: add prompt reference token support for dsh
- f37bf3d: fix(perf): improved performance when opening and streaming sessions

## 0.2.5

### Patch Changes

- d71800d: Update the Orbis DSH plugin to the DSH 0.1.1-rc.2 SDK and extend the Orbis v2 bridge with capability-gated image upload/download, file and session prompt-reference completion, Ask User question responses, plan-mode selection, and read-only subagent listings. Project DSH plan-mode, goal/todo, and question state plus run-activity and presence signals into canonical Orbis snapshots and events; preserve interrupted assistant messages as aborted entries; and expand disposable real-profile smoke coverage for the new protocol paths.

## 0.2.4

### Patch Changes

- eff04d3: Improve permissions/approvals

## 0.2.3

### Patch Changes

- 267a2c5: Added permission/approval in protocol

## 0.2.2

### Patch Changes

- b9a8aad: Build and test the plugin against the public DSH SDK without requiring a Harness checkout.
- 449a937: Add about section in plugin settings ui

## 0.2.1

### Patch Changes

- 5c85142: Added folder creation

## 0.2.0

### Minor Changes

- 18abc66: Initial beta

## 1.0.0

### Major Changes

- 41ef1ed: Initial beta release
