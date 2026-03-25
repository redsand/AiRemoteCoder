# @ai-remote-coder/mcp-runner

Standalone MCP worker bridge for AiRemoteCoder.

## Usage

```bash
npx -y @ai-remote-coder/mcp-runner@latest \
  --gateway-url http://localhost:3100 \
  --token <AIREMOTECODER_MCP_TOKEN> \
  --runner-id "<hostname>:<project-path>" \
  --provider codex \
  --codex-mode interactive
```

Environment variables are also supported:

- `AIREMOTECODER_GATEWAY_URL`
- `AIREMOTECODER_MCP_TOKEN` (or `AIRC_MCP_TOKEN`)
- `AIREMOTECODER_PROVIDER`
- `AIREMOTECODER_RUNNER_ID` (stable per host+project identity)
- `AIREMOTECODER_CODEX_MODE` (`interactive` or `exec`)
- `AIREMOTECODER_EXEC_TEMPLATE` (required for non-codex providers)
