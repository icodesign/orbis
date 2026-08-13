# Orbis

English | [简体中文](./README.zh.md)

Orbis is a remote control client for Deepseek Harness (DSH).

The Orbis plugin provides device pairing, end-to-end encrypted transport, and real-time
updates across multiple devices.

![Screenshots](./assets/orbis-screenshots.webp)

## Getting Started

1. Download the Orbis app. It is currently in beta. [Join Test](https://tally.so/r/A7RjzN)
2. Install the Orbis plugin into DSH.

```sh
dsh plugin --profile web add @orbisapp/remote-dsh  // available once published after the public beta
```

3. Configure the plugin and pair your device from the DSH web plugin page.

## Development

Install dependencies at the repository root, then use a single command to build the plugin,
install it into your local DSH Web profile, and start the test page:

```sh
pnpm install
ORBIS_DSH_HARNESS_DIR=/path/to/deepseek-harness pnpm run serve:dsh
```

The page is served at `http://127.0.0.1:3080` by default. Pass flags to change the port or
point at a specific test directory:

```sh
pnpm run serve:dsh --port 3090
pnpm run serve:dsh --workspace-root /path/to/workspace
pnpm run serve:dsh --help
```

## Testing

```sh
pnpm run check:core   # typecheck + tests for everything that builds from this repository alone
pnpm run check:dsh    # also typechecks the plugin and client entry points, needs a DSH checkout
```

CI runs `check:core` on every push and every pull request, and again before a release.
`check:dsh` is a local command: it typechecks against `@deepseek-ai/*` sources, which are only
available from a DSH checkout pointed at by `ORBIS_DSH_HARNESS_DIR`.

## Releasing

Releases are driven by [Changesets](https://github.com/changesets/changesets). Ship every
user-visible change with a changeset and commit it alongside the change:

```sh
pnpm changeset
```

The five workspace packages form one fixed version group, because `@orbisapp/remote-dsh` inlines the
other four at build time. A changeset for any of them versions and releases all five together.
Only `@orbisapp/remote-dsh` is published to npm; the rest are private and are versioned only.

Every push to `main` runs the tests and then opens or updates a **Version packages** pull request
that applies the pending changesets and writes the changelogs. Merging that pull request builds the
bundle and publishes `@orbisapp/remote-dsh` to npm.

To release by hand from a clean checkout of `main`:

```sh
pnpm install
pnpm run version:packages   # apply changesets, then commit the result
pnpm run release            # build the bundle and publish to npm
```

## License

[Apache-2.0](./LICENSE)
