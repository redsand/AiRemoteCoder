# Quickstart

AiRemoteCoder is an MCP-first gateway with a local helper, `airc-mcp-runner`,
for durable execution on each host/project.

## Prerequisites

- Node.js 20+
- npm
- A supported local coding environment
  - Codex is the only production-ready runner path today

## Start the app locally

```bash
npm install
npm run build
npm run dev
```

Default URLs:

- UI: `http://localhost:3000` during Vite dev
- Gateway: `http://localhost:3100`
- MCP endpoint: `http://localhost:3100/mcp`

## First-time setup

1. Open the UI.
2. Complete the auth setup flow to create the first admin user.
3. Open the MCP page.
4. Generate an MCP token.
5. Copy the provider setup snippet for your coding environment.
6. If you want production runner execution, use Codex first.

## Codex setup

The UI provides copy/paste setup commands that:

1. Update only the `airemotecoder` MCP block in local Codex config.
2. Install `airc-mcp-runner`.

The setup snippet does not start the runner. The runner command is shown when a
new run is created.

## Creating a run

1. Create a new run in the UI.
2. Copy the generated `airc-mcp-runner --runner-id ...` command.
3. Run that command in the target project directory.
4. Watch the run move from `pending` to `running`.

## Validation

```bash
npm test -w gateway
npm test -w runner
npm test -w ui
npm run build -w gateway
npm run build -w runner
npm run build -w ui
npm run test:mvp
```

## Supported model

- Human control: UI/session auth
- Agent control: MCP server
- Local execution bridge: `airc-mcp-runner`

The old client/wrapper registration flow is no longer supported.
