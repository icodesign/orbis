# 在 WSL 中连接 Orbis 与 DSH

[English](./wsl-setup.md) | 简体中文

Orbis 会直接连接运行在 Linux 发行版内的 Remote DSH 监听服务。WSL 2 默认使用 NAT 网络，
因此与 Windows 宿主机处于同一局域网的手机无法直接访问 WSL 地址。推荐在 Windows 11 上
启用 WSL 镜像网络，并在 Hyper-V 防火墙中放行 Orbis 端口。

## 1. 启用镜像网络

在 Windows 中创建或编辑 `%UserProfile%\.wslconfig`：

```ini
[wsl2]
networkingMode=mirrored
```

在 PowerShell 中重启 WSL：

```powershell
wsl --shutdown
```

重新打开 Linux 发行版，然后检查网络模式：

```sh
wslinfo --networking-mode
```

正常情况下应输出 `mirrored`。

## 2. 在 Hyper-V 防火墙中放行 Orbis 监听端口

以管理员身份打开 PowerShell，为 Orbis 端口添加入站规则。默认端口为 `47000`；如果修改过
端口，请使用 **设置 → 插件 → Orbis → 高级设置** 中显示的端口。

```powershell
New-NetFirewallHyperVRule -Name "OrbisRemoteDSH" -DisplayName "Orbis Remote DSH" -Direction Inbound -VMCreatorId "{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}" -Protocol TCP -LocalPorts 47000
```

## 3. 确认连接路径

在 WSL 内启动 DSH Web，然后打开 **设置 → 插件 → Orbis**。设置卡片应显示：

- **宿主机：** `Windows · WSL（你的发行版）`
- **网络：** `镜像模式 · 局域网`

让手机与 Windows 电脑连接到同一个局域网，然后开始配对。

## 备选方案：在 WSL 内运行 Tailscale

如果无法使用镜像网络，可以在 WSL 发行版和手机上安装并运行 Tailscale。此时 Orbis 页面
应显示 `Tailscale 网络` 连接路径。只在 Windows 中安装 Tailscale 不会在 WSL 内创建插件
可以发布的 Tailnet 网络接口。

不要把 WSL 虚拟机的 `172.x.x.x` NAT 地址作为手动连接地址。该地址属于 WSL 私有虚拟网络，
处于局域网中的手机无法直接访问。

## 参考资料

- [使用 WSL 访问网络应用程序](https://learn.microsoft.com/zh-cn/windows/wsl/networking)
- [WSL 中的高级设置配置](https://learn.microsoft.com/zh-cn/windows/wsl/wsl-config)
- [配置 Hyper-V 防火墙](https://learn.microsoft.com/zh-cn/windows/security/operating-system-security/network-security/windows-firewall/hyper-v-firewall)
