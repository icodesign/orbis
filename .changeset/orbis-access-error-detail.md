---
"@orbisapp/remote-dsh": patch
---

Show why Orbis could not start instead of blaming the network. The settings page rendered a fixed "check the network connection" message for every access failure, so an incompatible DSH build reported itself as a network problem and retrying could never help. The status banner and the turn on/off actions now surface the real reason, keeping the generic wording only for a failure that carries no message.
