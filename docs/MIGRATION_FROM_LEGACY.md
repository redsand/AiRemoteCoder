# Migrating from Legacy Wrapper Mode

## Background

The legacy subprocess/stdio wrapper was the original control path:

```
Wrapper → spawn(claude, {stdio: pipe}) → read stdout/stderr → POST /api/ingest/event
UI → POST /api/runs/:id/commands → Wrapper polls → write to process.stdin
```

It works, but the brittleness of piped terminal output and 2-second command polling
makes it unreliable as a production control plane.

The new MCP path replaces this with a structured protocol where agents speak
JSON-RPC over HTTP/SSE to the gateway's MCP server.

**The legacy path is still active by default** — both paths coexist until you
choose to disable the legacy wrapper.

---

## Migration steps

### Step 1: Deploy the new release

Everything still works. No configuration change required.

### Step 2: Generate an MCP token

Navigate to **MCP** in the gateway UI, or:

```bash
curl -X POST https://your-gateway:3100/api/mcp/tokens \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session>" \
  -d '{"label": "My agent", "scopes": ["runs:read","runs:write","runs:cancel","sessions:read","sessions:write","events:read","artifacts:read"]}'
```

Copy the returned `token` value — it is shown only once.

### Step 3: Configure your agent runtime

#### Claude Code
Add to `.claude/mcp.json` in your project or `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "airemotecoder": {
      "type": "http",
      "url": "https://your-gateway:3100/mcp",
      "headers": { "Authorization": "Bearer <YOUR_MCP_TOKEN>" }
    }
  }
}
```

#### Codex
```bash
export MCP_SERVER_URL=https://your-gateway:3100/mcp
export MCP_SERVER_TOKEN=<YOUR_MCP_TOKEN>
codex --mcp-server $MCP_SERVER_URL
```

#### Gemini CLI
```json
{
  "mcpServers": {
    "airemotecoder": {
      "httpUrl": "https://your-gateway:3100/mcp",
      "headers": { "Authorization": "Bearer <YOUR_MCP_TOKEN>" }
    }
  }
}
```

#### OpenCode
OpenCode has native MCP support:
```json
{
  "mcp": {
    "servers": [{
      "name": "airemotecoder",
      "type": "http",
      "url": "https://your-gateway:3100/mcp",
      "headers": { "Authorization": "Bearer <YOUR_MCP_TOKEN>" }
    }]
  }
}
```

#### Rev
Rev support is via adapter shim (native MCP verification pending):
```bash
export AIRC_MCP_URL=https://your-gateway:3100/mcp
export AIRC_MCP_TOKEN=<YOUR_MCP_TOKEN>
```

### Step 4: Validate

Use the `healthcheck` tool to confirm connectivity:
```bash
curl -X POST https://your-gateway:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"healthcheck","arguments":{}},"id":1}'
```

Run a real task through the new path and confirm events, artifacts, and any
approval requests flow correctly through the UI.

### Step 5: Disable legacy wrappers (when ready)

Once your agents are reliably using the MCP path:

```env
AIRC_LEGACY_WRAPPERS_ENABLED=false
```

This prevents new legacy wrapper connections. Existing runs in flight will
complete normally.

### Step 6: Stop deploying wrapper processes

The `ai-runner` wrapper CLI processes on agent machines can be decommissioned
once legacy mode is disabled.

---

## Feature comparison

| Feature | Legacy wrapper | MCP path |
|---------|---------------|----------|
| Command delivery latency | ~2 seconds (polling) | Real-time |
| Approval gates | None (manual pattern matching) | Structured, gated |
| Provider isolation | None (all wrappers share base runner) | Full adapter separation |
| Resume/checkpoint | File-based, fragile | Structured checkpoint + ResumeToken |
| Event replay on reconnect | No | Yes (cursor-based) |
| Multi-provider support | Manual env configuration | Adapter registry |
| Observability | Log parsing | Structured event types |

---

## What is NOT changed

- The React UI — works identically
- WebSocket event streaming to the browser/phone
- HMAC-signed wrapper authentication (for any remaining wrapper processes)
- Artifact upload and download
- Run, session, and event database schemas (additive changes only)
- All existing REST API routes

---

## Rollback

If you need to roll back to legacy-only mode:

```env
AIRC_MCP_ENABLED=false
AIRC_LEGACY_WRAPPERS_ENABLED=true
```

Restart the gateway. All legacy wrappers resume as before.
The MCP endpoint will return 404.
