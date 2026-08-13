# Orbis

Orbis 是一个适配 Deepseek Harness (DSH) 远程控制客户端端软件。

Orbis 插件包含设备配对、端到端加密传输、多端实时更新等功能。

![Screenshots](./assets/orbis-screenshots.webp)

## 如何使用

1. 下载 Orbis app。
2. 安装 Orbis 插件到 DSH。

```sh
dsh plugin --profile web add @orbis/remote-dsh  // 公测后发布才可用
```

3.

## 开发测试

在仓库根目录安装依赖，然后通过一条命令构建插件、安装到本地 DSH Web profile
并启动测试页面：

```sh
pnpm install
ORBIS_DSH_HARNESS_DIR=/path/to/deepseek-harness pnpm run serve:dsh
```

默认页面地址为 `http://127.0.0.1:3080`。可以通过参数修改端口或使用指定的测试目录：

```sh
pnpm run serve:dsh --port 3090
pnpm run serve:dsh --workspace-root /path/to/workspace
pnpm run serve:dsh --help
```
