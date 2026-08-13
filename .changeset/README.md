# Changesets

Every user-visible change needs a changeset. Run `pnpm changeset` at the repository root, pick the
bump type, and commit the generated markdown file together with your change.

The five workspace packages are a **fixed group**: `@orbisapp/remote-dsh` is a single bundle that
inlines `@orbisapp/transport`, `@orbisapp/orbis-agent-backend`, `@orbisapp/remote-agent-protocol` and
`@orbisapp/remote-agent-node-store` at build time. A changeset for any one of them therefore versions
and releases all five together, so a change in bundled code can never ship under an unchanged
`@orbisapp/remote-dsh` version. Only `@orbisapp/remote-dsh` is published to npm; the other four are
private and get version bumps and changelog entries only.

See the [changesets documentation](https://github.com/changesets/changesets) for the full CLI.
