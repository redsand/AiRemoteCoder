# Testing

AiRemoteCoder follows TDD. New behavior starts with a failing test, then the
minimum implementation, then refactor.

## Core commands

```bash
# All workspaces
npm test

# MVP path
npm run test:mvp

# Individual workspaces
npm test -w gateway
npm test -w runner
npm test -w ui

# Builds
npm run build -w gateway
npm run build -w runner
npm run build -w ui
```

## Coverage priorities

### Gateway

- MCP auth, token scope, and session access
- MCP tool handlers
- run creation/claim/poll/ack/event ingestion
- approval workflow transactions
- database helpers
- UI auth/session routes

### Runner

- claim/poll/ack loop
- provider executor lifecycle
- Codex app-server thread/turn handling
- error propagation and retry behavior
- runner-id targeting

### UI

- MCP setup/install flows
- provider list and runner command generation
- MCP-first navigation and run creation affordances

## Required MCP coverage

Every MCP change must cover:

- unauthenticated rejection
- wrong-scope rejection
- success path
- invalid input / not-found path

Approval changes must also cover rollback so state transition plus command
enqueue cannot partially apply.

## Test types

- `*.test.ts`: unit tests
- `*.integration.test.ts`: full HTTP/in-memory DB integration
- `*.e2e.test.ts`: end-to-end server behavior

## Useful focused commands

```bash
npx vitest run gateway/src/mcp/plugin.test.ts
npx vitest run gateway/src/mcp/server.test.ts
npx vitest run gateway/src/routes/runs.test.ts
npx vitest run gateway/src/routes/mcp-setup.test.ts
npx vitest run runner/src/worker.test.ts
```

## MVP release gate

Before calling the MCP path release-ready, run:

```bash
npm run test:mvp
npm run build
```

The expected MVP lane is gateway + runner + UI only.
