# Connect Orbis to DSH running in WSL

English | [简体中文](./wsl-setup.zh.md)

Orbis connects directly to the Remote DSH listener running inside your Linux distribution. WSL 2
uses NAT networking by default, so a phone on the Windows host's LAN cannot reach the WSL address.
The recommended setup is WSL mirrored networking on Windows 11, with the Orbis port allowed through
the Hyper-V firewall.

## 1. Enable mirrored networking

Create or edit `%UserProfile%\.wslconfig` on Windows:

```ini
[wsl2]
networkingMode=mirrored
```

Restart WSL from PowerShell:

```powershell
wsl --shutdown
```

Open the distribution again and verify its network mode:

```sh
wslinfo --networking-mode
```

It should print `mirrored`.

## 2. Allow the Orbis listener through the Hyper-V firewall

Open PowerShell as Administrator and add an inbound rule for the Orbis port. The default port is
`47000`; use the port shown under **Settings → Plugins → Orbis → Advanced settings** if you changed
it.

```powershell
New-NetFirewallHyperVRule -Name "OrbisRemoteDSH" -DisplayName "Orbis Remote DSH" -Direction Inbound -VMCreatorId "{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}" -Protocol TCP -LocalPorts 47000
```

## 3. Confirm the connection path

Start DSH Web inside WSL and open **Settings → Plugins → Orbis**. The setup card should show:

- **Host machine:** `Windows · WSL (your distribution)`
- **Network:** `Mirrored · Local network`

Connect the phone and Windows computer to the same local network, then start pairing.

## Alternative: Tailscale inside WSL

If mirrored networking is unavailable, install and run Tailscale inside the WSL distribution and on
the phone. The Orbis page should then include `Tailscale network` as a reachable path. Installing
Tailscale only on Windows does not create a Tailnet interface inside WSL for the plugin to advertise.

Do not use the WSL VM's `172.x.x.x` NAT address as a manual endpoint. It belongs to the private WSL
virtual network and is not directly reachable from a phone on the LAN.

## References

- [Accessing network applications with WSL](https://learn.microsoft.com/windows/wsl/networking)
- [Advanced settings configuration in WSL](https://learn.microsoft.com/windows/wsl/wsl-config)
- [Configure Hyper-V firewall](https://learn.microsoft.com/windows/security/operating-system-security/network-security/windows-firewall/hyper-v-firewall)
