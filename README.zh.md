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

仓库中的五个包组成一个固定版本组（fixed group），因为 `@orbisapp/remote-dsh` 在构建时会把另外四个
包打进产物。因此任意一个包的 changeset 都会让五个包一起升版本、一起发布。其中只有
`@orbisapp/remote-dsh` 会发布到 npm，其余四个是私有包，只升版本不发布。

每次推送到 `main` 都会先跑测试，然后创建或更新一个 **Version packages** PR，其中应用了待发布的
changeset 并生成 changelog。合并该 PR 即会构建产物，并把 `@orbisapp/remote-dsh` 发布到 npm。

如果需要手动发布，在干净的 `main` 检出上执行：

```sh
pnpm install
pnpm run version:packages   # 应用 changeset，然后提交结果
pnpm run release            # 构建产物并发布到 npm
```

## 许可证

[Apache-2.0](./LICENSE)
