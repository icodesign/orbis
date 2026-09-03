---
"@orbisapp/remote-dsh": patch
---

Support DeepSeek Harness 0.1.2-alpha.5. The Session log is now read through `snapshotEvents()` and `eventAt()` after alpha.4 removed the `events` getter, and the durable projection cache is consulted with the lineage cut its identity is bound to.

Run the complete real-profile prompt, durable-usage, reconnect, and restart acceptance without provider credentials through DSH's official deterministic LLM replay adapter, while preserving the credentialed live-provider canary.
