# MCP Control Plane — Architecture Overview

## Why this exists

AiRemoteCoder previously controlled AI agents exclusively through subprocess
spawning and piped stdio. Commands were sent by writing to process stdin; output
was captured from stdout/stderr buffers and streamed to the gateway. This works,
but it is inherently fragile:

- Output parsing depends on terminal line formats that change between agent versions
- Command delivery has up to 2-second latency (HTTP polling)
- Approval interception requires watching for specific stdout markers
- Resume means spawning a new process and hoping the agent can re-attach
- Every provider requires bespoke buffer-parsing logic

The MCP control plane replaces this fragile substrate with a structured,
provider-neutral protocol while preserving all existing functionality during
the transition.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                       AiRemoteCoder Gateway                         │
│                                                                     │
│  ┌─────────────────────────┐   ┌──────────────────────────────────┐ │
│  │    HUMAN INTERFACE      │   │      MCP CONTROL PLANE           │ │
│  │    (unchanged)          │   │      (new, additive)             │ │
│  │                         │   │                                  │ │
│  │  React UI  (HTTPS)      │   │  POST /mcp                       │ │
│  │  WebSocket /ws          │   │  GET  /mcp  (SSE)                │ │
│  │  REST API  /api/        │   │  DELETE /mcp                     │ │
│  └────────────┬────────────┘   └────────────┬─────────────────────┘ │
│               │                             │                       │
│               └──────────────┬──────────────┘                       │
│                              │                                      │
│              ┌───────────────▼───────────────┐                      │
│              │          ORCHESTRATOR          │                      │
│              │  Run lifecycle · State machine │                      │
│              │  Event log · Approval gates    │                      │
│              └───────────────┬───────────────┘                      │
│                              │                                      │
│   ┌──────────────────────────┼──────────────────────────────────┐   │
│   │            PROVIDER ADAPTER LAYER                           │   │
│   │  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐ ┌───────┐   │   │
│   │  │ Claude │ │ Codex  │ │ Gemini │ │ OpenCode │ │  Rev  │   │   │
│   │  │ Adapter│ │ Adapter│ │ Adapter│ │ Adapter  │ │Adapter│   │   │
│   │  └────────┘ └────────┘ └────────┘ └──────────┘ └───────┘   │   │
│   │                                                             │   │
│   │  ┌─────────────────────────────────────────────────────┐   │   │
│   │  │  LegacyWrapperAdapter  (@deprecated)                │   │   │
│   │  │  Compatibility shim for existing subprocess wrappers│   │   │
│   │  │  ⚠  Scheduled for removal in next major release     │   │   │
│   │  └─────────────────────────────────────────────────────┘   │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                 EVENT STORE  (SQLite WAL)                    │   │
│  │  Append-only · monotonic sequence · cursor-based replay      │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
        ▲                              ▲
        │  HTTPS/WSS                   │  MCP / HTTP+SSE
        │  (session auth)              │  (Bearer token auth)
   ┌────┴────┐                    ┌────┴──────────────────────────┐
   │ Phone / │                    │ AI Agent Runtimes             │
   │ Browser │                    │  Claude Code · Codex          │
   └─────────┘                    │  Gemini CLI · OpenCode · Rev  │
                                  └───────────────────────────────┘
```

---

## Design principles

| Principle | Implication |
|-----------|-------------|
| MCP is the canonical agent-facing interface | Agents speak MCP; internal implementation details are hidden behind tools |
| Existing secure channel is the canonical human-facing interface | The React UI + WebSocket path remains unchanged; it is not replaced by chat platforms |
| Gateway is the state authority | Orchestrator owns run/session state; adapters are stateless execution engines |
| Provider quirks stay inside adapters | No Claude-specific or Codex-specific logic leaks into the orchestrator or MCP tools |
| Additive migration | Legacy wrappers continue to work until the adapter layer is proven; no big-bang rewrite |
| Replay-safe | Every important transition is written to the event log before it takes effect |

---

## Control surfaces

### Agent-facing: MCP server

**Transport:** Streamable HTTP (MCP spec 2025-03-26)

```
POST   /mcp            JSON-RPC request
GET    /mcp            SSE stream (session-based notifications)
DELETE /mcp            Session termination
```

**Auth:** Bearer token (see `mcp/auth.ts` and `GET /api/mcp/tokens`)

MCP sessions are stateless at the transport layer: each `POST /mcp` carries a
`Mcp-Session-Id` header after the initial `initialize`. Sessions are tracked
in-memory on the gateway; in a multi-instance deployment, move to Redis.

### Human-facing: existing secure channel

- React UI over HTTPS (session cookies, Cloudflare Access, TOTP)
- WebSocket `/ws` for real-time event streaming
- REST API `/api/` for run management, artifacts, auth
- **No changes to this path** — it remains the primary human interface

---

## Data flow for a typical run

```
1. Agent calls MCP tool create_run  →  Run record inserted (pending)
2. Legacy wrapper claims run  →  Run status = running  (or native adapter starts)
3. Agent output → POST /api/ingest/event  →  Event log  →  WebSocket  →  UI
4. Human sends command from phone  →  POST /api/runs/:id/commands
5. Wrapper polls + executes command
6. Agent calls create_approval_request  →  Run status = waiting_approval
7. Human approves from UI  →  PUT /api/mcp/approvals/:id  or  POST approve_action
8. Approval resolved  →  Run resumes
9. Run finishes  →  Artifacts uploaded  →  Events broadcast  →  UI notified
```

---

## Key files

| File | Purpose |
|------|---------|
| `gateway/src/mcp/plugin.ts` | Fastify plugin — mounts MCP routes + token management API |
| `gateway/src/mcp/server.ts` | MCP tools, resources, and handlers |
| `gateway/src/mcp/auth.ts` | Bearer token validation + scope enforcement |
| `gateway/src/domain/types.ts` | Canonical entity types shared across all layers |
| `gateway/src/adapters/types.ts` | ProviderAdapter interface |
| `gateway/src/adapters/registry.ts` | Adapter registry |
| `gateway/src/adapters/legacy-wrapper.ts` | Deprecated compatibility shim |
| `gateway/src/services/database.ts` | Schema including new mcp_tokens + approval_requests tables |
| `gateway/src/config.ts` | Feature flags: AIRC_MCP_ENABLED, AIRC_PROVIDER_*, AIRC_LEGACY_WRAPPERS_ENABLED |

---

## Feature flags

| Env var | Default | Purpose |
|---------|---------|---------|
| `AIRC_MCP_ENABLED` | `true` | Enable/disable the MCP control plane |
| `AIRC_MCP_PATH` | `/mcp` | MCP endpoint path |
| `AIRC_MCP_TOKEN_EXPIRY` | `0` | Token expiry in seconds (0 = never) |
| `AIRC_PROJECT_ROOTS` | `<projectRoot>` | Comma-separated allowlist of filesystem roots allowed for MCP auto-install targets |
| `AIRC_PROVIDER_CLAUDE` | `true` | Enable Claude adapter |
| `AIRC_PROVIDER_CODEX` | `true` | Enable Codex adapter |
| `AIRC_PROVIDER_GEMINI` | `true` | Enable Gemini adapter |
| `AIRC_PROVIDER_OPENCODE` | `true` | Enable OpenCode adapter |
| `AIRC_PROVIDER_ZENFLOW` | `true` | Enable Zenflow adapter |
| `AIRC_PROVIDER_REV` | `true` | Enable Rev adapter |
| `AIRC_LEGACY_WRAPPERS_ENABLED` | `true` | Enable deprecated legacy wrapper compatibility |
| `AIRC_APPROVAL_TIMEOUT` | `300` | Default approval timeout in seconds |

---

## Security model

- MCP Bearer tokens are distinct from UI session tokens
- Tokens carry scopes (runs:read, runs:write, approvals:decide, etc.)
- Admin role can create tokens with any scope; operator/viewer get limited defaults
- Tokens are stored as SHA-256 hashes; the raw token is shown once on creation
- Per-request scope checks in every tool handler via `assertScopes()`
- Approval gates require explicit `approvals:decide` scope
- All auth events flow through the existing audit log
- Rate limiting is applied at the gateway level (MCP path is excluded from the
  global limiter and should have its own in production)

See `docs/SECURITY.md` for the full threat model.

---

## Migration from legacy wrappers

See `docs/MIGRATION_FROM_LEGACY.md` for the full migration guide.

Short version:
1. Deploy this release — everything still works
2. Generate an MCP token via the UI (`/mcp` page)
3. Configure your agent runtime to connect to `/mcp`
4. Validate that the native MCP path works for your use case
5. Set `AIRC_LEGACY_WRAPPERS_ENABLED=false` once migration is complete
6. Legacy wrapper code will be removed in the next major release
