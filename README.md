# AI Remote Coder

A secure, mobile-friendly gateway for remotely monitoring and controlling AI coding agents. Supports multiple agent types (Claude, Ollama, Codex, Gemini, Rev, VNC, hands-on) via a connect-back architecture — no inbound ports required on agent machines.

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
                            WebSocket│ (connect-back)
                                     │
                  ┌──────────────────┼──────────────────┐
                  │                  │                   │
         ┌────────▼─────┐  ┌────────▼─────┐  ┌────────▼─────┐
         │    Claude    │  │ Ollama/Codex │  │  VNC /       │
         │    Runner    │  │ Gemini / Rev │  │  Hands-On    │
         └──────────────┘  └──────────────┘  └──────────────┘
                           (wrapper agents)
```

## Features

- **Real-time Monitoring**: Stream agent output to your phone via WebSocket
- **Multi-Agent Support**: Claude, Ollama, Codex, Gemini, Rev, VNC, and hands-on workers
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
# Start the gateway
./run.sh

# Open https://localhost:3100 and create an admin account

# In a second terminal, start the agent listener:
ai-runner listen

# From the UI, create a new run — the listener picks it up automatically
```

You can also manage runs from the CLI directly:

```bash
ai-runner login
ai-runner list
ai-runner resume <runId>    # resume a previous run
```

## Remote Access

For phone access via Cloudflare Tunnel:

```bash
./scripts/cloudflare-tunnel.sh
```

## Documentation

- [Quickstart Guide](docs/QUICKSTART.md)
- [DigitalOcean Deployment](docs/DIGITALOCEAN.md)
- [Security Model](docs/SECURITY.md)
- [Operations Guide](docs/OPERATIONS.md)
- [Claude Code Integration](docs/CLAUDE_CODE.md)
- [Testing Guide](docs/TESTING.md)

## Project Structure

```
├── gateway/          # Fastify server (REST API + WebSocket hub)
├── wrapper/          # Agent runner (ai-runner CLI, multi-worker)
├── ui/               # React UI (mobile-friendly)
├── .claude/          # Claude Code hooks (event streaming, safety gates)
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
- HMAC-signed wrapper requests with per-run capability tokens
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
- Claude Code CLI (optional — only needed for the Claude worker type)
- `cloudflared` (optional — for Cloudflare Tunnel remote access)
- `tmate` (optional — for assist sessions)

## License

MIT
