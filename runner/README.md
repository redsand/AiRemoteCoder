# @ai-remote-coder/mcp-runner

Standalone MCP worker bridge for AiRemoteCoder.

## Usage

```bash
npx -y @ai-remote-coder/mcp-runner@latest \
  --gateway-url http://localhost:3100 \
  --token <AIREMOTECODER_MCP_TOKEN> \
  --runner-id "<hostname>:<project-path>" \
  --provider codex \
  --codex-mode app-server
```

Environment variables are also supported:

- `AIREMOTECODER_GATEWAY_URL`
- `AIREMOTECODER_MCP_TOKEN` (or `AIRC_MCP_TOKEN`)
- `AIREMOTECODER_PROVIDER`
- `AIREMOTECODER_RUNNER_ID` (stable per host+project identity)
- `AIREMOTECODER_CODEX_MODE` (`app-server`, `exec`, or legacy `interactive`)
- `AIREMOTECODER_EXEC_TEMPLATE` (required for non-codex providers)

## Codex transport

For Codex, `app-server` is the primary mode.

- `app-server`: preferred. Uses `codex app-server` for a persistent conversational thread with structured JSON-RPC messages.
- `exec`: fallback. Uses one-shot `codex exec` for each queued prompt.
- `interactive`: legacy fallback only. It relies on plain stdin piping and is not the recommended production path.
