# MCP Server Reference

The AiRemoteCoder MCP server exposes the control plane as a set of tools and
resources that AI agent runtimes can use directly.

**Endpoint:** `POST /mcp` (streamable HTTP)
**Auth:** `Authorization: Bearer <token>`

---

## Authentication

### Create a token

1. Open the gateway UI and navigate to **MCP** in the nav
2. Enter a label and select the scopes your agent needs
3. Click **Generate Token** — copy the token immediately (shown once)

Or via API (UI session required):
```
POST /api/mcp/tokens
Content-Type: application/json

{
  "label": "My Codex agent",
  "scopes": ["runs:read", "runs:write", "events:read", "artifacts:read"]
}
```

### Scopes

| Scope | Grants |
|-------|--------|
| `runs:read` | list_runs, get_run, get_run_diff, get_policy_snapshot, get_agent_capabilities |
| `runs:write` | create_run, resume_run, send_input |
| `runs:cancel` | cancel_run |
| `vnc:read` | get_vnc_status |
| `vnc:control` | start_vnc_stream, stop_vnc_stream |
| `sessions:read` | (reserved for future session-query tools) |
| `sessions:write` | send_input, interrupt_session |
| `events:read` | tail_logs |
| `artifacts:read` | list_artifacts, fetch_artifact, get_run_diff |
| `artifacts:write` | (reserved for agent artifact upload) |
| `approvals:read` | request_approval_status |
| `approvals:write` | create_approval_request |
| `approvals:decide` | approve_action, deny_action |
| `admin` | all of the above + list_mcp_tokens + get_vnc_tunnel_stats |

---

## Tools

### `healthcheck`
Returns gateway status. No auth required.

**Returns:** `{ status, timestamp, gateway, version, runs: { pending, running, … } }`

---

### `heartbeat`
Keep-alive ping. No auth required.

**Returns:** `{ ts: number, iso: string }`

---

### `list_runs`
List runs with optional filters.

**Scope:** `runs:read`

**Input:**
```json
{
  "status": "running",       // optional: pending|running|waiting_approval|done|failed|cancelled
  "worker_type": "claude",   // optional
  "limit": 50,               // 1–200, default 50
  "offset": 0
}
```

**Returns:** `{ runs: Run[], total, limit, offset }`

---

### `get_run`
Get full run details.

**Scope:** `runs:read`

**Input:**
```json
{ "run_id": "abc123", "include_events": false }
```

**Returns:** `{ run, state, events? }`

---

### `create_run`
Create a new pending run. A worker will claim it.

**Scope:** `runs:write`

**Input:**
```json
{
  "worker_type": "claude",       // claude|codex|gemini|opencode|zenflow|rev|hands-on|vnc
  "label": "Fix auth bug",       // optional
  "command": "fix the login…",   // optional initial prompt
  "repo_path": "/home/…/repo",   // optional working directory
  "tags": ["auth", "urgent"],    // optional
  "metadata": {}                 // optional
}
```

**Returns:** `{ run_id, status: "pending", capability_token }`

**Idempotency:** Not idempotent — each call creates a new run.

---

### `resume_run`
Resume a done/failed run by creating a new run that inherits state.

**Scope:** `runs:write`

**Input:**
```json
{ "run_id": "prev-run-id", "command": "continue…", "working_dir": "/override" }
```

**Returns:** `{ run_id, resumed_from, status: "pending", capability_token }`

---

### `cancel_run`
Request graceful stop.

**Scope:** `runs:cancel`

**Input:** `{ "run_id": "abc", "reason": "user cancelled" }`

**Returns:** `{ run_id, message }`

---

### `send_input`
Send text input to an active run's agent process.

**Scope:** `sessions:write`

**Input:** `{ "run_id": "abc", "input": "please summarize the changes" }`

**Returns:** `{ command_id, status: "queued" }`

---

### `interrupt_session`
Send interrupt (Ctrl-C equivalent) to the active process.

**Scope:** `sessions:write`

**Input:** `{ "run_id": "abc" }`

**Returns:** `{ command_id, status: "queued" }`

---

### `get_vnc_status`
Get VNC tunnel status for a VNC run.

**Scope:** `vnc:read`

**Input:** `{ "run_id": "abc" }`

**Returns:** `{ run_id, available, status, client_connected, viewer_connected, ws_url, stats }`

---

### `start_vnc_stream`
Queue VNC stream startup for a VNC run. This is a control-plane action; the
actual pixel stream remains on the VNC websocket path.

**Scope:** `vnc:control`

**Input:** `{ "run_id": "abc" }`

**Returns:** `{ run_id, command: "__START_VNC_STREAM__", command_id, ws_url }`

---

### `stop_vnc_stream`
Close an active VNC tunnel for a VNC run.

**Scope:** `vnc:control`

**Input:** `{ "run_id": "abc" }`

**Returns:** `{ run_id, message }`

---

### `get_vnc_tunnel_stats`
Get aggregate VNC tunnel stats (operator/admin diagnostic view).

**Scope:** `admin`

**Input:** `{}`

**Returns:** `{ active_tunnels, pending_tunnels, tunnels: [] }`

---

### `tail_logs`
Retrieve log events with cursor-based pagination for replay.

**Scope:** `events:read`

**Input:**
```json
{
  "run_id": "abc",
  "limit": 100,             // 1–1000
  "after_sequence": 42,     // replay from this cursor (exclusive)
  "types": ["stdout", "stderr"]  // optional type filter
}
```

**Returns:** `{ run_id, events: Event[], count, cursor, has_more }`

**Replay pattern:** On reconnect, pass `after_sequence` to receive only events
you haven't seen. The `cursor` in the response is the sequence number of the
last returned event — save it for the next call.

---

## UI behavior notes

- **Connected Hosts** now shows helper-reported project directory metadata when
  `airc-mcp-runner` is active for a project.
- **Pending runner-targeted runs** keep the helper startup command visible on
  the run detail page, so the operator can recover it even after dismissing the
  creation modal.
- **Run Command** queues a local allowlisted command for the helper to execute.
  It does not send that command as an agent prompt.
- **Send Prompt** still queues agent input for the active coding agent thread.
- **Changes** in run detail presents changed files and the latest captured diff
  per file using Codex app-server change events.
- For providers that do not emit native change/diff events, `airc-mcp-runner`
  now synthesizes a git-based change report after successful turns and uploads a
  diff artifact so the same **Changes** UI can still render file updates.

---

### `list_artifacts`
List artifacts from a run.

**Scope:** `artifacts:read`

**Input:** `{ "run_id": "abc" }`

**Returns:** `{ run_id, artifacts: [{ id, name, type, size, created_at }] }`

---

### `fetch_artifact`
Retrieve artifact content (text) or download URL (binary).

**Scope:** `artifacts:read`

**Input:** `{ "artifact_id": "xyz" }`

**Returns (text artifact):** `{ artifact_id, name, type, content: string }`

**Returns (binary):** `{ artifact_id, name, type, size, download_url }`

---

### `get_run_diff`
Get the most recent git diff artifact from a run.

**Scope:** `artifacts:read`

**Input:** `{ "run_id": "abc" }`

**Returns:** `{ run_id, artifact_id, diff: string }` or `{ diff: null, message }`

---

### `create_approval_request`
Gate an agent action on human approval.

**Scope:** `approvals:write`

**Input:**
```json
{
  "run_id": "abc",
  "description": "About to delete .git directory",
  "action": { "type": "delete", "path": ".git" },
  "timeout_seconds": 300,
  "provider_correlation_id": "my-internal-id"
}
```

**Returns:** `{ approval_request_id, status: "pending" }`

The run transitions to `waiting_approval`. The gateway broadcasts an
`approval_requested` event to WebSocket subscribers (phone/browser). Once a
human approves or denies via the UI or `approve_action`/`deny_action`, the run
resumes and a `__APPROVAL_RESOLVED__` command is delivered to the agent.

---

### `request_approval_status`
Poll an approval request.

**Scope:** `approvals:read`

**Input:** `{ "approval_request_id": "xyz" }`

**Returns:** Full ApprovalRequest record.

---

### `approve_action` / `deny_action`
Resolve an approval request.

**Scope:** `approvals:decide`

**Input:**
```json
{
  "approval_request_id": "xyz",
  "resolution": "looks safe, approved"
}
```

**Returns:** `{ request_id, decision, resolved_by, message }`

---

### `get_agent_capabilities`
Return capability matrix for all enabled provider adapters.

**Scope:** `runs:read`

**Returns:** `{ capabilities: { claude: AgentCapability, … }, enabledProviders }`

---

### `get_policy_snapshot`
Return current gateway policy.

**Scope:** `runs:read`

**Returns:** `{ allowlistedCommands, approvalTimeoutSeconds, maxArtifactSizeBytes, providers, … }`

---

## Resources

| URI | Description |
|-----|-------------|
| `run://{run_id}` | Full run record as JSON |
| `artifacts://{run_id}` | Artifact manifest for a run |
| `policy://current` | Current gateway policy snapshot |

---

## Error codes

| Code | Meaning |
|------|---------|
| `-32001` | Unauthorized — missing or invalid Bearer token |
| `-32002` | Session not found |
| `-32600` | Invalid request (e.g. first message not initialize) |
| Tool returns `isError: true` | Business-logic error (not found, scope denied, etc.) — see text |

---

## Connection examples

See `GET /api/mcp/config` or the UI at `/mcp` for provider-specific
connection snippets that are pre-filled with your gateway's URL.

### One-shot install snippets (copy/paste)

For every provider, use:

- `POST /api/mcp/setup/:provider` to generate token + snippet + copy/paste commands
- `POST /api/mcp/setup/:provider/install` if that provider supports file auto-install

Codex examples are AiRemoteCoder-only:

```bash
# shell token for this session
export AIREMOTECODER_MCP_TOKEN="<YOUR_MCP_TOKEN>"
# replace only airemotecoder block; keep other entries
mkdir -p ~/.codex
touch ~/.codex/config.toml
python - <<'PY'
from pathlib import Path
import re

path = Path.home() / ".codex" / "config.toml"
text = path.read_text(encoding="utf-8") if path.exists() else ""
prefix = "mcp_servers.airemotecoder"
out = []
skip = False

for line in text.splitlines():
    m = re.match(r"^\s*\[([^\]]+)\]\s*(?:[#;].*)?$", line)
    if m:
        table = m.group(1).strip()
        if table == prefix or table.startswith(prefix + "."):
            skip = True
            continue
        skip = False
    if not skip:
        out.append(line)

if out and out[-1] != "":
    out.append("")
out.extend([
    "[mcp_servers.airemotecoder]",
    "url = \"http://localhost:3100/mcp\"",
    "bearer_token_env_var = \"AIREMOTECODER_MCP_TOKEN\"",
    "",
])
path.write_text("\n".join(out), encoding="utf-8")
PY

# start MCP worker loop (Codex App Server primary mode)
export AIREMOTECODER_GATEWAY_URL="http://localhost:3100"
export AIREMOTECODER_PROVIDER="codex"
export AIREMOTECODER_CODEX_MODE="app-server"
export AIREMOTECODER_CODEX_APPROVAL_POLICY="never"
export AIREMOTECODER_RUNNER_ID="$(hostname):$PWD"
npx -y @ai-remote-coder/mcp-runner@latest --runner-id "$AIREMOTECODER_RUNNER_ID"
```

```powershell
# one-shot replace of airemotecoder block only
$env:AIREMOTECODER_MCP_TOKEN="<YOUR_MCP_TOKEN>"
$configDir = Join-Path $HOME ".codex"
$configPath = Join-Path $configDir "config.toml"
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
if (!(Test-Path $configPath)) { New-Item -ItemType File -Path $configPath | Out-Null }
$lines = Get-Content -Path $configPath
$prefix = "mcp_servers.airemotecoder"
$skip = $false
$out = New-Object System.Collections.Generic.List[string]
foreach ($line in $lines) {
  if ($line -match '^\s*\[([^\]]+)\]\s*(?:[#;].*)?$') {
    $table = $matches[1].Trim()
    if ($table -eq $prefix -or $table.StartsWith("$prefix.")) { $skip = $true; continue }
    if ($skip) { $skip = $false }
  }
  if (-not $skip) { [void]$out.Add($line) }
}
Set-Content -Path $configPath -Value $out -Encoding utf8
@'

[mcp_servers.airemotecoder]
url = "http://localhost:3100/mcp"
bearer_token_env_var = "AIREMOTECODER_MCP_TOKEN"
'@ | Add-Content -Path $configPath -Encoding utf8

# start MCP worker loop (Codex App Server primary mode)
$env:AIREMOTECODER_GATEWAY_URL="http://localhost:3100"
$env:AIREMOTECODER_PROVIDER="codex"
$env:AIREMOTECODER_CODEX_MODE="app-server"
$env:AIREMOTECODER_CODEX_APPROVAL_POLICY="never"
$env:AIREMOTECODER_RUNNER_ID="$env:COMPUTERNAME:$((Get-Location).Path)"
npx -y @ai-remote-coder/mcp-runner@latest --runner-id "$env:AIREMOTECODER_RUNNER_ID"
```

All generated setup commands are additive/update-only and scoped to
`airemotecoder`; they do not replace unrelated provider configuration.

### MCP Worker Loop (Codex-first)

Run this on the coding host after MCP token setup:

```bash
export AIREMOTECODER_GATEWAY_URL=http://localhost:3100
export AIREMOTECODER_MCP_TOKEN=<YOUR_MCP_TOKEN>
export AIREMOTECODER_PROVIDER=codex
export AIREMOTECODER_CODEX_MODE=app-server
export AIREMOTECODER_CODEX_APPROVAL_POLICY=never
export AIREMOTECODER_RUNNER_ID="$(hostname):$PWD"
npx -y @ai-remote-coder/mcp-runner@latest --runner-id "$AIREMOTECODER_RUNNER_ID"
```

`app-server` is the primary Codex transport. Set `AIREMOTECODER_CODEX_MODE=exec` to run one-shot `codex exec` for each prompt. `interactive` remains legacy fallback only.
Set `AIREMOTECODER_CODEX_APPROVAL_POLICY=never` for the current MVP path so turns do not block on app-server approval requests that are not yet bridged back into the UI.
For persistent install, run `npm install -g @ai-remote-coder/mcp-runner@latest` and start with `airc-mcp-runner`.

Claude now has a preview native runner path through `airc-mcp-runner`, so it does not require `AIREMOTECODER_EXEC_TEMPLATE`.
For Gemini/OpenCode/Zenflow/Rev the runner currently supports only manual `execTemplate` fallback:

```bash
export AIREMOTECODER_PROVIDER=<provider>
export AIREMOTECODER_EXEC_TEMPLATE="<provider-cli> ... {input}"
```

`{input}` is required and is replaced with the queued prompt payload.
This is not equivalent to the Codex app-server path and should not be treated as production-ready runner support yet.
Claude remains preview-only until its helper path is validated end to end.

Worker endpoints used:

- `POST /api/mcp/runs/claim`
- `GET /api/mcp/runs/:runId/commands`
- `POST /api/mcp/runs/:runId/commands/:commandId/ack`
- `POST /api/mcp/runs/:runId/events`

The worker loop supports bearer-token session resolution when `mcp-session-id`
is omitted by selecting the most recent active MCP session for that token.

Quick test:
```bash
curl -X POST https://your-gateway:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.0.1"}},"id":1}'
```

---

## Multi-Project Auto-Install Targets

MCP setup APIs support targeting different repositories/machines instead of a single gateway project root.

- `GET /api/mcp/project-targets` — list targets visible to current user
- `POST /api/mcp/project-targets` — create/update target `{ label, path, machineId? }`
- `DELETE /api/mcp/project-targets/:id` — remove target

Targeted setup/install calls accept:

- `projectTargetId` (preferred for saved targets)
- `projectPath` (one-off direct path)

Safety:

- Paths are restricted to allowlisted roots from `AIRC_PROJECT_ROOTS`.
- If a target has `machine_id`, requests must originate from the same trusted session device identity (server-issued, signed device cookie).

---

## Future note: MCP-only (no local runner)

This section is documentation-only for future exploration.

- MCP tools/resources/prompts do not provide a standardized, reliable server-push remote-exec channel on client hosts.
- Different agent clients may support local command execution differently, and many require explicit interactive user action.
- Because of that, AiRemoteCoder currently treats the local bridge runner (`@ai-remote-coder/mcp-runner`) as the production execution path for queued runs.

Possible future mode:

- A best-effort "MCP-only assist mode" where agents pull work by calling MCP tools from inside an active chat session.
- This may reduce setup friction, but it is not equivalent to the durability/replay/ack guarantees provided by the local bridge runner.
