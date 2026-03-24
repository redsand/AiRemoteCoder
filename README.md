# AI Remote Coder

A secure, mobile-friendly gateway for remotely monitoring and controlling AI coding agents.

AiRemoteCoder is now **MCP-first**:
- MCP control plane (`/mcp`) is the primary agent-facing interface
- The existing secure UI/API/WebSocket channel is the primary human-facing interface
- Legacy subprocess wrappers remain available only as compatibility mode during migration

## Setup

1. Install dependencies:
   ```bash
   npm run setup
   ```

2. Run in development mode:
   ```bash
   npm run dev
   ```

   This starts both the gateway and UI servers concurrently.

3. Build for production:
   ```bash
   npm run build
   ```

4. Start production server:
   ```bash
   npm run start
   ```

5. Run tests:
   ```bash
   npm run test
   ```

6. MVP MCP test lane (recommended):
   ```bash
   npm run test:mvp
   ```

## Available Scripts

- `npm run setup` - Install dependencies and build all workspaces
- `npm run dev` - Start gateway and UI in development mode
- `npm run dev:gateway` - Start only the gateway in development mode
- `npm run dev:ui` - Start only the UI in development mode
- `npm run build` - Build all workspaces for production
- `npm run start` - Start the production server
- `npm run test` - Run all tests
- `npm run prune` - Prune old data from the database

## Architecture

```
┌─────────────────┐         ┌─────────────────┐
│  Phone/Browser  │◄───────►│    Gateway      │◄──►  SQLite DB
│    (UI)         │  HTTPS  │  (Fastify)      │     (.data/)
└─────────────────┘         └────────┬────────┘
                                     │
                             MCP HTTP│ + SSE
                                     │
                  ┌──────────────────┼──────────────────┐
                  │                  │                   │
         ┌────────▼─────┐  ┌────────▼─────┐  ┌────────▼─────┐
         │ Claude/Codex │  │ Gemini/Open- │  │ Rev / Zenflow│
         │ MCP client   │  │ Code MCP     │  │ MCP adapter  │
         └──────────────┘  └──────────────┘  └──────────────┘
```

## Features

- **MCP Control Plane (Primary)**: Provider-neutral JSON-RPC control over HTTP/SSE
- **Secure Human Channel (Primary)**: Existing UI + `/api/*` + WebSocket for approvals, status, artifacts
- **Real-time Monitoring**: Stream normalized run/session events to your phone/browser
- **Multi-Agent Support**: Claude, Codex, Gemini, OpenCode, Zenflow, Rev, VNC, and hands-on
- **Command Execution**: Run allowlisted commands (tests, git operations) from the UI
- **Secure Authentication**: HMAC-signed requests, session auth, optional TOTP 2FA, Cloudflare Access
- **Connect-Back Only**: Agents initiate outbound connections — no inbound ports required
- **Artifact Collection**: Upload and download files and diffs from agent runs
- **VNC Remote Desktop**: Full remote desktop access as a fallback for manual intervention
- **Run Resume**: Resume stopped or failed runs, preserving working directory and session state
- **Worker Pool**: Run multiple agents concurrently with configurable limits
- **Role-Based Access**: Admin, operator, and viewer roles for the web UI
- **Secret Redaction**: Automatic scrubbing of API keys, tokens, and certificates from logs

## Quick Start

```bash
npm run setup
npm run dev
```

Then:
1. Open `http://localhost:3100`
2. Complete auth/setup
3. Go to **MCP** page
4. Generate provider setup commands/snippets for your project
5. Run your coding agent (Claude/Codex/Gemini/OpenCode/Zenflow/Rev) in that project
6. Create and control runs from the UI

Legacy wrapper mode (deprecated) remains available during migration. See `docs/MIGRATION_FROM_LEGACY.md`.

## MCP Setup (Codex example)

```bash
export AIREMOTECODER_MCP_TOKEN=<YOUR_MCP_TOKEN>
mkdir -p ~/.codex
touch ~/.codex/config.toml
python - <<'PY'
from pathlib import Path
import re
path = Path.home()/".codex"/"config.toml"
text = path.read_text(encoding="utf-8") if path.exists() else ""
prefix = "mcp_servers.airemotecoder"
out, skip = [], False
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
```

The MCP page provides copy/paste one-shot Bash and PowerShell commands that replace only the `airemotecoder` MCP block and keep all other config intact.

## MCP Worker Mode (Codex-first)

After MCP setup, start the worker loop on the coding host:

```bash
export AIREMOTECODER_GATEWAY_URL=http://localhost:3100
export AIREMOTECODER_MCP_TOKEN=<YOUR_MCP_TOKEN>
export AIREMOTECODER_PROVIDER=codex
export AIREMOTECODER_CODEX_MODE=interactive
npm run worker:mcp -w gateway
```

This loop claims MCP runs, polls queued commands, executes prompts via a persistent Codex interactive session, acknowledges commands, and streams events/lifecycle markers back to the gateway.
Set `AIREMOTECODER_CODEX_MODE=exec` to use one-shot `codex exec` per prompt.

For non-Codex providers, supply an explicit execution template:

```bash
export AIREMOTECODER_PROVIDER=gemini
export AIREMOTECODER_EXEC_TEMPLATE="gemini run {input}"
npm run worker:mcp -w gateway
```

## Remote Access

For phone access via Cloudflare Tunnel:

```bash
./scripts/cloudflare-tunnel.sh
```

## Documentation

- [MCP Architecture](docs/MCP_ARCHITECTURE.md)
- [MCP Server Reference](docs/MCP_SERVER.md)
- [Migration From Legacy Wrappers](docs/MIGRATION_FROM_LEGACY.md)
- [Quickstart Guide](docs/QUICKSTART.md)
- [DigitalOcean Deployment](docs/DIGITALOCEAN.md)
- [Security Model](docs/SECURITY.md)
- [Operations Guide](docs/OPERATIONS.md)
- [Testing Guide](docs/TESTING.md)

## Project Structure

```
├── gateway/          # Fastify server (MCP server + REST API + WebSocket + SQLite)
├── wrapper/          # Deprecated wrapper compatibility path
├── ui/               # React UI (mobile-friendly)
├── docs/             # Documentation
├── scripts/          # Utility scripts (startup, certs, tunnels, pruning)
├── .data/            # Runtime data (gitignored)
│   ├── db.sqlite     # SQLite database
│   ├── certs/        # TLS certificates
│   ├── artifacts/    # Uploaded files
│   └── runs/         # Local run logs
├── run.sh            # Start gateway (Linux/macOS)
└── run.ps1           # Start gateway (Windows)
```

## Security

- TLS everywhere (auto-generated self-signed certs for development)
- Scoped MCP bearer tokens and per-tool authorization
- HMAC-signed wrapper requests (legacy compatibility path)
- Replay protection via nonces (10-minute expiry)
- Allowlisted commands only (extensible via `EXTRA_ALLOWED_COMMANDS`)
- Secret redaction in all log streams
- Argon2id password hashing
- Optional TOTP 2FA
- Cloudflare Access integration for zero-trust remote access
- Role-based authorization (admin / operator / viewer)
- Audit logging of security-relevant events

See [SECURITY.md](docs/SECURITY.md) for the full threat model.

## Requirements

- Node.js 20+
- Python 3 + pip (required for VNC remote desktop support)
- Any supported MCP-capable agent runtime (Claude Code, Codex, Gemini CLI, OpenCode, Zenflow; Rev via adapter)
- `cloudflared` (optional — for Cloudflare Tunnel remote access)
- `tmate` (optional — for assist sessions)

## License

MIT
