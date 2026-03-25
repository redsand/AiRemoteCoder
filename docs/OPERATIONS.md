# Operations Guide

This document describes the supported runtime model for AiRemoteCoder.

## Runtime components

- `gateway/`: Fastify server, MCP server, REST API, WebSocket hub, SQLite state
- `ui/`: human control surface
- `runner/`: `airc-mcp-runner`, the local execution bridge

## Control flow

1. A user creates a run in the UI.
2. Gateway persists the run and any pending commands.
3. A host-local `airc-mcp-runner` claims the run using an MCP bearer token and `runner_id`.
4. The runner executes locally and streams normalized events back to the gateway.
5. The UI reads run state, events, approvals, and artifacts from the gateway.

## Supported endpoints

### Authentication

- `GET /api/auth/status`
- `POST /api/auth/setup`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `GET /api/auth/me`

### MCP admin/operator

- `GET /api/mcp/config`
- `GET /api/mcp/tokens`
- `POST /api/mcp/tokens`
- `GET /api/mcp/sessions`
- `GET /api/mcp/setup/status`

### Run control

- `POST /api/runs`
- `GET /api/runs`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/events`
- `POST /api/runs/:runId/input`
- `POST /api/runs/:runId/command`
- `POST /api/runs/:runId/stop`
- `POST /api/runs/:runId/release`
- `DELETE /api/runs/:runId`

### Runner APIs

- `POST /api/mcp/runs/claim`
- `GET /api/mcp/runs/:runId/commands`
- `POST /api/mcp/runs/:runId/commands/:commandId/ack`
- `POST /api/mcp/runs/:runId/events`

### Health

- `GET /health`

## Runner deployment

Install the helper:

```bash
npm install -g @ai-remote-coder/mcp-runner@latest
```

Then:

1. Configure the coding tool to use AiRemoteCoder MCP.
2. Create a run in the UI.
3. Copy the generated runner command for that host/project.
4. Run it in the project directory.

Required environment in the generated command:

- `AIREMOTECODER_GATEWAY_URL`
- `AIREMOTECODER_MCP_TOKEN`
- `AIREMOTECODER_PROVIDER`
- `AIREMOTECODER_RUNNER_ID`

Provider-specific mode variables may also be included.

Today, only Codex is a production-ready runner target. Other providers may still connect to MCP and use setup flows, but the helper does not yet provide native persistent executors for them.

## Operational checks

```bash
curl http://localhost:3100/health
npm test -w gateway
npm test -w runner
npm test -w ui
npm run build -w gateway
npm run build -w runner
npm run build -w ui
npm run test:mvp
```

## Failure handling

### Run stays pending

Check:

- the run has the expected `mcpRunnerId`
- the helper was started with the same `--runner-id`
- the token is valid
- the helper points at the gateway base URL, not `/mcp`

### Runner returns 401

Check `AIREMOTECODER_MCP_TOKEN`.

### Codex stdin/TTY error

Use the app-server-backed runner path. Do not rely on plain interactive stdin mode.

## Security model

- MCP tokens are scoped bearer credentials
- UI actions require session auth and role checks
- runs are claimed by explicit runner identity
- approval transitions are transactional
- logs/events are redacted before storage and broadcast

See [SECURITY.md](./SECURITY.md) for the full threat model.
