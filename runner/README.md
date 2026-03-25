# @ai-remote-coder/mcp-runner

Standalone MCP worker bridge for AiRemoteCoder.

## Usage

```bash
npx -y @ai-remote-coder/mcp-runner@latest \
  --gateway-url http://localhost:3100 \
  --token <AIREMOTECODER_MCP_TOKEN> \
  --runner-id "<hostname>:<project-path>" \
  --provider codex \
  --codex-mode app-server \
  --codex-approval-policy never
```

Environment variables are also supported:

- `AIREMOTECODER_GATEWAY_URL`
- `AIREMOTECODER_MCP_TOKEN` (or `AIRC_MCP_TOKEN`)
- `AIREMOTECODER_PROVIDER`
- `AIREMOTECODER_RUNNER_ID` (stable per host+project identity)
- `AIREMOTECODER_CODEX_MODE` (`app-server`, `exec`, or legacy `interactive`)
- `AIREMOTECODER_CODEX_APPROVAL_POLICY` (defaults to `never` for the current MVP path)
- `AIREMOTECODER_EXEC_TEMPLATE` (manual fallback only for non-codex providers)

The helper automatically reports its current working directory to the gateway.
That directory is shown in the **Connected Hosts** UI so hosts can be
distinguished by project root.

## Codex transport

For Codex, `app-server` is the primary mode.

- `app-server`: preferred. Uses `codex app-server` for a persistent conversational thread with structured JSON-RPC messages.
  - Default approval policy is `never` so queued runs do not hang on unhandled approval prompts.
  - File-change and diff events are surfaced into the AiRemoteCoder **Changes** view.
- `exec`: fallback. Uses one-shot `codex exec` for each queued prompt.
- `interactive`: legacy fallback only. It relies on plain stdin piping and is not the recommended production path.

## Provider readiness

- `codex`: production-ready runner path
- `claude`: not production-ready in the runner yet
- `gemini`: not production-ready in the runner yet
- `opencode`: not production-ready in the runner yet
- `zenflow`: not production-ready in the runner yet
- `rev`: not production-ready in the runner yet

Non-Codex providers currently require a manual `AIREMOTECODER_EXEC_TEMPLATE` and do not yet have native persistent executors.
