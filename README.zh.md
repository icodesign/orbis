# Orbis

[English](./README.md) | 简体中文

Orbis 是一个适配 Deepseek Harness (DSH) 远程控制客户端端软件。

Orbis 插件包含设备配对、端到端加密传输、多端实时更新等功能。

![Screenshots](./assets/orbis-screenshots.webp)

## 如何使用

1. 下载 Orbis app. 目前在 beta 测试中。[iOS: 加入 TesFlight](https://testflight.apple.com/join/3Nqcbpns)。 Android: 正在进行中。
2. 安装 Orbis 插件到 DSH。

```sh
npx @deepseek-ai/dsh plugin --profile web add @orbisapp/remote-dsh@latest
```

3. 在 DSH web 插件页面（设置 - 插件 - Orbis tab）配置相关信息以及配对。

## 开发测试

在仓库根目录安装依赖，然后通过一条命令构建插件、安装到本地 DSH Web profile
并启动测试页面：

```sh
pnpm install
pnpm run serve:dsh
```

默认页面地址为 `http://127.0.0.1:3080`。可以通过参数修改端口或使用指定的测试目录：

```sh
pnpm run serve:dsh --port 3090
pnpm run serve:dsh --workspace-root /path/to/workspace
pnpm run serve:dsh --help
```

## 测试

```sh
pnpm run check:core   # 仅依赖本仓库即可完成的类型检查与测试
pnpm run check:dsh    # 使用公开 DSH SDK 检查插件与客户端入口
```

CI 在每次 push、每个 PR 以及发布前都会运行 `check:core`。`check:dsh` 直接使用 workspace
安装的公开 `@deepseek-ai/*` SDK 包。

## 发布

发布流程基于 [Changesets](https://github.com/changesets/changesets)。每个对用户可见的改动都要
附带一个 changeset，并和改动一起提交：

```sh
pnpm changeset
```

Changesets 会维护一个包含全部待发布 changeset 的草稿发布 PR。在继续累积改动期间保持该 PR
为打开状态；准备发布完整版本时，检查合并后的版本号和 changelog，将 PR 标记为可审核并合并，
随后自动发布。不会影响已发布包的改动不需要 changeset。

## 社群

微信交流群

![Wechat group](./assets/wechat-group.webp)

## 许可证

[Apache-2.0](./LICENSE)
