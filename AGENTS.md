# AGENTS.md — AI Agent Development Guide for AiRemoteCoder

This file is the authoritative guide for AI coding agents working on this
repository. Read it before making any changes.

---

## Project overview

AiRemoteCoder is a connect-back gateway that lets you manage AI coding agents
(Claude Code, Codex, Gemini CLI, OpenCode, Rev) remotely from a phone or
browser. The gateway is a Fastify/Node.js TypeScript server. Agents connect to
it via the MCP control plane (primary) or the legacy subprocess wrapper (deprecated).

**Repository layout:**

```
gateway/     Fastify server — MCP server, REST API, WebSocket, SQLite
wrapper/     CLI tool that spawns AI agents (deprecated for new work)
ui/          React web UI (Vite + TypeScript)
docs/        Architecture and operational documentation
```

---

## Test-Driven Development (TDD) is mandatory

This project follows strict TDD. For every new feature or bug fix:

1. **Write the test first** — define what "done" looks like before writing code
2. **Run the test** — confirm it fails for the right reason
3. **Write the minimum code** to make the test pass
4. **Refactor** — clean up without breaking tests
5. **Repeat** for each new behaviour

### Non-negotiable testing rules

- No new code ships without tests
- Every MCP tool handler must have a test covering: happy path, auth rejection
  (unauthenticated), scope rejection (authenticated but wrong scope), and
  not-found / invalid input
- Every database helper must have a test
- Every adapter must have a test confirming it implements the ProviderAdapter contract
- Tests must mock the database and external services — no real I/O in unit tests
- Integration tests that test the full HTTP path must be in `*.integration.test.ts`
  files so they can be run separately from unit tests

### Running tests

```bash
# Gateway unit tests
cd gateway && npm test

# Watch mode
cd gateway && npm run test:watch

# Wrapper unit tests
cd wrapper && npm test

# All tests from root
npm test --workspaces
```

### Test file naming

| Type | Filename pattern | Scope |
|------|-----------------|-------|
| Unit | `*.test.ts` | Mocked deps, fast |
| Integration | `*.integration.test.ts` | Real or in-memory DB |
| End-to-end | `*.e2e.test.ts` | Real server |

---

## MCP-specific testing requirements

The MCP control plane is the primary agent-facing interface. Every change to
`gateway/src/mcp/` **must** include or update tests.

### Required test coverage for MCP

| Component | Test file | Must cover |
|-----------|-----------|-----------|
| `mcp/auth.ts` | `mcp/auth.test.ts` | Token extraction, scope assertion, admin bypass, invalid token |
| `mcp/server.ts` | `mcp/server.test.ts` | Every tool: auth failure, scope failure, success, edge cases |
| `mcp/plugin.ts` | `mcp/plugin.test.ts` | HTTP routes: POST/GET/DELETE /mcp, token CRUD, /api/mcp/config |
| `adapters/types.ts` | `adapters/adapter-contract.test.ts` | Interface compliance |
| `adapters/legacy-wrapper.ts` | `adapters/legacy-wrapper.test.ts` | All adapter methods |
| `adapters/registry.ts` | `adapters/registry.test.ts` | Register, get, list, has |
| `services/database.ts` (new helpers) | `services/database.test.ts` | findMcpToken, expireTimedOutApprovals |
| `domain/types.ts` | No runtime tests needed (TypeScript) | Compile-time only |

### Tool handler test template

Every MCP tool must be tested with this pattern:

```typescript
describe('MCP tool: <name>', () => {
  it('returns auth error when no auth context', async () => { ... });
  it('returns scope error when token lacks required scope', async () => { ... });
  it('returns not-found when resource does not exist', async () => { ... });
  it('returns success for valid authorized call', async () => { ... });
  // Additional edge cases specific to the tool
});
```

### Approval flow tests

The approval request lifecycle must be tested end-to-end:

```
create_approval_request → status: pending
→ request_approval_status (pending)
→ approve_action / deny_action
→ request_approval_status (approved/denied)
→ run.waiting_approval = false
→ __APPROVAL_RESOLVED__ command queued
```

---

## Architecture principles (for agents)

1. **MCP is the agent-facing interface.** If you are adding a feature that
   agents will use, expose it as an MCP tool, not a raw HTTP route.

2. **Human interface stays unchanged.** The React UI, WebSocket, and REST API
   under `/api/` are the human path. Do not redirect human workflows through MCP.

3. **Provider quirks stay inside adapters.** `gateway/src/adapters/` is the
   only place where Claude-specific, Codex-specific, or any other
   provider-specific logic belongs.

4. **Domain types are the contract.** `gateway/src/domain/types.ts` defines
   what crosses boundaries. Adapters must convert from their native format to
   these types.

5. **Additive migration.** Do not remove legacy code until `AIRC_LEGACY_WRAPPERS_ENABLED=false`
   is confirmed working and the adapter path is proven. Use feature flags.

6. **Legacy wrapper is deprecated.** Do not add new features to
   `gateway/src/adapters/legacy-wrapper.ts` or `wrapper/src/`. New work goes
   into native provider adapters.

---

## File structure

```
gateway/src/
  config.ts              Feature flags and configuration
  index.ts               Fastify server bootstrap
  domain/
    types.ts             Canonical entity types (Run, Session, Event, etc.)
  mcp/
    auth.ts              Bearer token validation + scope enforcement
    plugin.ts            Fastify plugin — MCP HTTP routes + token API
    server.ts            McpServer with all tools and resources
    auth.test.ts         Auth unit tests
    server.test.ts       Tool handler unit tests
    plugin.test.ts       HTTP route integration tests
  adapters/
    types.ts             ProviderAdapter interface
    registry.ts          Adapter registry
    legacy-wrapper.ts    @deprecated compatibility shim
    *.test.ts            Adapter tests
  services/
    database.ts          SQLite schema + helpers
    websocket.ts         WebSocket hub
  middleware/
    auth.ts              HMAC wrapper auth + UI session auth
  routes/                Existing REST API routes (unchanged)
  utils/
    crypto.ts            HMAC, hashing, token generation
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AIRC_MCP_ENABLED` | `true` | Enable MCP control plane |
| `AIRC_MCP_PATH` | `/mcp` | MCP endpoint path |
| `AIRC_LEGACY_WRAPPERS_ENABLED` | `true` | Enable deprecated wrapper compat |
| `AIRC_PROVIDER_CLAUDE` | `true` | Enable Claude adapter |
| `AIRC_PROVIDER_CODEX` | `true` | Enable Codex adapter |
| `AIRC_PROVIDER_GEMINI` | `true` | Enable Gemini adapter |
| `AIRC_PROVIDER_OPENCODE` | `true` | Enable OpenCode adapter |
| `AIRC_PROVIDER_REV` | `true` | Enable Rev adapter |
| `AIRC_APPROVAL_TIMEOUT` | `300` | Default approval timeout (seconds) |
| `HMAC_SECRET` | auto | HMAC secret for wrapper auth |
| `AUTH_SECRET` | auto | Session auth secret |
| `GATEWAY_PORT` | `3100` | Gateway listen port |

---

## Commit and PR standards

- Tests must pass before committing
- PRs must include tests for all new/changed behaviour
- Reference the relevant tool name in commit messages for MCP changes
  (e.g. `feat(mcp): add tail_logs cursor replay support`)
- The description in PR body must list which MCP tools / adapters are affected

---

## Key documentation

| Doc | Purpose |
|-----|---------|
| `docs/MCP_ARCHITECTURE.md` | System design and data flow |
| `docs/MCP_SERVER.md` | MCP tool reference |
| `docs/MIGRATION_FROM_LEGACY.md` | How to migrate from wrapper to MCP |
| `docs/SECURITY.md` | Threat model |
| `docs/TESTING.md` | Test procedures |
