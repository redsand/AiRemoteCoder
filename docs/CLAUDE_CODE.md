# Claude Code Integration

## Overview

The claude-runner wrapper launches Claude Code and provides:
- Real-time output streaming to the gateway
- Command execution from the UI
- Artifact upload (logs, diffs)
- Optional tmate assist sessions

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      claude-runner                           │
│                                                              │
│  ┌──────────────────┐    ┌──────────────────────────────┐  │
│  │   Claude Code    │───►│   Output Capture             │  │
│  │   (subprocess)   │    │   - stdout/stderr            │  │
│  └──────────────────┘    │   - Markers (start/finish)   │  │
│                          └──────────────────────────────┘  │
│                                     │                       │
│                                     ▼                       │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Gateway Client                           │  │
│  │   - HMAC-signed requests                             │  │
│  │   - Event streaming (POST /api/ingest/event)         │  │
│  │   - Command polling (GET /api/runs/:id/commands)     │  │
│  │   - Artifact upload (POST /api/ingest/artifact)      │  │
│  └──────────────────────────────────────────────────────┘  │
│                                     │                       │
│                                     ▼                       │
│                            Gateway Server                    │
└─────────────────────────────────────────────────────────────┘
```

## Starting a Run

### From UI
1. Click "New Run" in the UI
2. Optionally enter a Claude command/prompt
3. Copy the run-id and capability token

### Start Wrapper
```bash
cd /path/to/your/project

./wrapper/claude-runner start \
  --run-id <run-id> \
  --token <token> \
  --cmd "your prompt here" \
  --cwd /optional/working/dir
```

### Environment Variables
The wrapper reads from `.env`:
```env
GATEWAY_URL=https://localhost:3100
HMAC_SECRET=<must match gateway>
ALLOW_SELF_SIGNED=true
CLAUDE_COMMAND=claude
```

## Event Types

### stdout
Standard output from Claude Code.
```json
{"type": "stdout", "data": "...", "sequence": 1}
```

### stderr
Error output from Claude Code.
```json
{"type": "stderr", "data": "...", "sequence": 2}
```

### marker
Lifecycle events.
```json
{"type": "marker", "data": "{\"event\":\"started\",\"command\":\"...\"}"}
{"type": "marker", "data": "{\"event\":\"finished\",\"exitCode\":0}"}
```

### info
Informational messages (command execution, etc.).
```json
{"type": "info", "data": "Executing command: npm test"}
```

### error
Error messages.
```json
{"type": "error", "data": "Command failed: ..."}
```

### assist
Assist session URL.
```json
{"type": "assist", "data": "{\"type\":\"tmate\",\"url\":\"ssh ...\"}"}
```

## Allowlisted Commands

Commands that can be sent from the UI:

| Command | Description |
|---------|-------------|
| `npm test` | Run npm tests |
| `npm run test` | Run npm test script |
| `pnpm test` | Run pnpm tests |
| `yarn test` | Run yarn tests |
| `pytest` | Run Python tests |
| `pytest -v` | Run Python tests (verbose) |
| `go test ./...` | Run Go tests |
| `cargo test` | Run Rust tests |
| `git diff` | Show unstaged changes |
| `git diff --cached` | Show staged changes |
| `git status` | Show working tree status |
| `git log --oneline -10` | Show recent commits |
| `ls -la` | List files |
| `pwd` | Show current directory |

### Adding Custom Commands
In `.env`:
```env
EXTRA_ALLOWED_COMMANDS=make build,make test,./custom-script.sh
```

## Artifact Types

### Automatic Uploads
- `claude.log` - Full session log (uploaded on completion)
- `latest.diff` - Git diff output (when `git diff` command runs)

### File Types
- `.log` - Log files
- `.txt` - Text files
- `.json` - JSON files
- `.diff` / `.patch` - Diff/patch files
- `.md` - Markdown files

## Secret Redaction

Output is scanned for secrets before transmission:

- API keys: `api_key=xxx`, `apiKey: xxx`
- Tokens: `token=xxx`, `Bearer xxx`
- Passwords: `password=xxx`
- OpenAI: `sk-...`
- GitHub: `ghp_...`, `ghs_...`
- NPM: `npm_...`
- Private keys: `-----BEGIN ... KEY-----`

Matches are replaced with `[REDACTED]`.

## Assist Sessions

For hands-on terminal access using tmate:

### Start Assist Session
```bash
./wrapper/claude-runner assist \
  --run-id <run-id> \
  --token <token>
```

### How It Works
1. Wrapper spawns tmate in background
2. tmate generates SSH URL
3. URL posted to gateway as `assist` event
4. UI displays clickable session URL
5. You can SSH in from any device

### Requirements
- tmate installed (`brew install tmate` or `apt install tmate`)
- Optional: `~/.tmate.conf` for custom settings

## Error Handling

### Exit Codes
- `0` - Success
- `1` - General error
- Other - Claude Code specific exit codes

### Automatic Retry
The wrapper does not automatically retry on failure. Create a new run instead.

### Graceful Stop
When stop is requested:
1. SIGINT sent to Claude Code
2. 10-second grace period
3. SIGKILL if still running

## Debugging

### Verbose Output
```bash
./wrapper/claude-runner start --run-id xxx --token xxx 2>&1 | tee debug.log
```

### Test Gateway Connection
```bash
./wrapper/claude-runner test-connection
```

### Show Configuration
```bash
./wrapper/claude-runner info
```

### Local Log Files
Logs are written to `.data/runs/<run-id>/claude.log` before upload.

## V2 Plans: Rev Integration

Future versions will support rev as an additional runner type:

```
./rev-runner start \
  --run-id <run-id> \
  --token <token> \
  --cmd "rev command"
```

The architecture is designed to support multiple runner types:
- Same gateway API
- Same authentication model
- Runner-specific event handling
- Runner-specific command allowlists

Integration will be added as a separate runner module without modifying existing Claude Code support.
