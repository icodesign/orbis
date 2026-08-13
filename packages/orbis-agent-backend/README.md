# `@orbis/orbis-agent-backend`

Pure TypeScript contract for Orbis agent execution. It separates the execution
location (`AgentBackend`) from the harness driver (`AgentHarnessDriver`), so one
local or remote backend may expose Pi, DSH, and future drivers concurrently.

It owns:

- stable product session identity plus a backend/driver/native-session locator;
- driver capabilities/availability, session/runtime commands, and display-safe domain errors;
- canonical durable session events, server-assigned delivery cursors, and the
  deterministic `AgentSessionProjection` reducer;
- an in-memory fake backend in the `@orbis/orbis-agent-backend/testkit` export
  for consumer contract tests.

It does not own React, Expo, TanStack Query, a network transport, Pi, DSH, or
credential/cache persistence. An integration layer will implement those seams.

## Validation

```sh
pnpm --filter @orbis/orbis-agent-backend run typecheck
pnpm --filter @orbis/orbis-agent-backend run test
```
