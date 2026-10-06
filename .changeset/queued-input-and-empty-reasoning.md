---
"@orbisapp/remote-dsh": minor
---

Add `next_run` prompt delivery and queued-input withdrawal. A prompt sent while the session is busy can be held by the plugin and started as a new run once the active run completes, and a held input can be withdrawn before it starts. The driver advertises both through the `prompt.next_run` and `prompt.queue.withdraw` capabilities.

Fix sessions failing to open or sync when an assistant message contains an empty text or reasoning block. DeepSeek models at low reasoning effort return an empty reasoning block that carries only a replay signature; such blocks are now skipped instead of rejecting the whole session.
