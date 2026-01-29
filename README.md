# Claude Code Connect-Back Gateway

A secure, mobile-friendly gateway for remotely monitoring and assisting Claude Code sessions.

```
# Claude Code Connect-Back Gateway

A secure, mobile-friendly gateway for remotely monitoring and assisting Claude Code sessions.

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

┌─────────────────┐         ┌─────────────────┐
│  Phone/Browser  │◄───────►│    Gateway      │
│    (UI)         │  HTTPS  │  (Fastify)      │
└─────────────────┘         └────────┬────────┘
                                     │
                            WebSocket│(Connect-back)
                                     │
                            ┌────────▼────────┐
                            │  Claude Runner  │
                            │  (wrapper)      │
                            │  + Claude Code  │
                            └─────────────────┘
```

## Features

- **Real-time Monitoring**: Stream Claude Code output to your phone
- **Command Execution**: Run allowlisted commands (tests, git operations)
- **Secure Authentication**: HMAC signatures, TOTP, Cloudflare Access
- **Connect-Back Only**: No inbound ports required on the Claude machine
- **Artifact Collection**: Download logs and diffs
- **Assist Sessions**: Optional tmate terminal sharing

## Quick Start

```bash
# Start the gateway
./run.sh

# Open https://localhost:3100, create admin account

# From the UI, create a new run and get the run-id/token

# On your Claude machine:
./wrapper/claude-runner start \
  --run-id <id> \
  --token <token> \
  --cmd "your prompt"
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
├── gateway/          # Fastify server (API + WebSocket)
├── wrapper/          # Claude Code runner (claude-runner CLI)
├── ui/               # React UI (mobile-friendly)
├── docs/             # Documentation
├── scripts/          # Utility scripts
├── .data/            # Runtime data (gitignored)
│   ├── db.sqlite     # SQLite database
│   ├── certs/        # TLS certificates
│   ├── artifacts/    # Uploaded files
│   └── runs/         # Local logs
├── run.sh            # Start gateway (Linux/macOS)
└── run.ps1           # Start gateway (Windows)
```

## Security

- TLS everywhere
- HMAC-signed wrapper requests
- Replay protection with nonces
- Allowlisted commands only
- Secret redaction in logs
- Argon2 password hashing
- Optional TOTP 2FA
- Cloudflare Access integration

See [SECURITY.md](docs/SECURITY.md) for the full threat model.

## Requirements

- Node.js 20+
- Claude Code CLI
- (Optional) cloudflared for remote access
- (Optional) tmate for assist sessions

## License

MIT
