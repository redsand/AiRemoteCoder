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
- `AIREMOTECODER_CLAUDE_PERMISSION_MODE` (defaults to `bypassPermissions` for the current Claude preview path)
- `AIREMOTECODER_GEMINI_APPROVAL_MODE` (defaults to `yolo` for the current Gemini preview path)
- `AIREMOTECODER_EXEC_TEMPLATE` (manual fallback for providers without native executors)

The helper automatically reports its current working directory to the gateway.
That directory is shown in the **Connected Hosts** UI so hosts can be
distinguished by project root.
The helper also persists provider resume state for the claimed run, so after a
gateway or helper restart it can reclaim the same run and continue when the
provider exposes a resumable session identifier.

## Codex transport

For Codex, `app-server` is the primary mode.

- `app-server`: preferred. Uses `codex app-server` for a persistent conversational thread with structured JSON-RPC messages.
  - Default approval policy is `never` so queued runs do not hang on unhandled approval prompts.
  - File-change and diff events are surfaced into the AiRemoteCoder **Changes** view.
- `exec`: fallback. Uses one-shot `codex exec` for each queued prompt.
- `interactive`: legacy fallback only. It relies on plain stdin piping and is not the recommended production path.

## Provider readiness

- `codex`: production-ready runner path
- `claude`: preview runner path using Claude CLI `--print --output-format stream-json`
  - Default permission mode is `bypassPermissions` for the current MVP debugging path.
  - The helper now prints Claude status/tool/stderr activity locally so a blocked turn is visible in the runner terminal.
  - Claude tool activity is normalized onto the same timeline-style tool start/finish events used by the UI for Codex so the run experience is provider-consistent.
- `gemini`: preview runner path using Gemini CLI `--output-format stream-json`
  - Default approval mode is `yolo` for the current Gemini preview path.
  - The helper now prints Gemini session/tool/result activity locally so blocked or quota-limited turns are visible in the runner terminal.
  - Gemini tool activity is normalized onto the same timeline-style tool start/finish events used by the UI for Codex and Claude.
- `opencode`: not production-ready in the runner yet
- `zenflow`: not production-ready in the runner yet
- `rev`: not production-ready in the runner yet

Claude and Gemini no longer require `AIREMOTECODER_EXEC_TEMPLATE`.
OpenCode, Zenflow, and Rev still use manual `AIREMOTECODER_EXEC_TEMPLATE` fallback until native executors land.
