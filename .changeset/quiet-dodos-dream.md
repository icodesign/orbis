---
"@orbisapp/remote-dsh": patch
---

Fix Remote DSH startup on Windows by avoiding POSIX group and other permission checks against Node's synthesized Windows file mode.
