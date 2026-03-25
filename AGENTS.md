# AGENTS.md — AI Agent Development Guide for AiRemoteCoder

This file is the authoritative guide for AI coding agents working on this
repository. Read it before making any changes.

---

## Project overview

AiRemoteCoder is a connect-back gateway that lets you manage AI coding agents
(Claude Code, Codex, Gemini CLI, OpenCode, Rev) remotely from a phone or
browser. The gateway is a Fastify/Node.js TypeScript server. Agents connect to
it via the MCP control plane and the `airc-mcp-runner` helper.

**Repository layout:**

```
gateway/     Fastify server — MCP server, REST API, WebSocket, SQLite
runner/      CLI tool that pairs a local coding environment with the gateway
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

For MCP work, this is mandatory at the feature boundary as well: new tools,
session semantics, setup flows, approval behavior, and adapter changes must
start with tests that describe the desired behavior before code changes land.

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
- UI changes that affect MCP setup, deployment, or navigation must include
  `ui/src/**/*.test.tsx` coverage for the affected component or page and must
  verify the MCP-first flow, supported provider list, and install affordances.
- Treat UI TDD the same way as gateway TDD: write the component test first,
  then implement the minimum code to satisfy it, then refactor.

### Running tests

```bash
# Gateway unit tests
cd gateway && npm test

# Watch mode
cd gateway && npm run test:watch

# All tests from root
npm test --workspaces

# MCP MVP test path
npm run test:mvp
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
| `mcp/server.ts` | `mcp/server.test.ts` | Every tool: auth failure, scope failure, success, not-found, idempotency, and approval state transitions |
| `mcp/plugin.ts` | `mcp/plugin.test.ts` | HTTP routes: POST/GET/DELETE /mcp, session auth/replay checks, token CRUD, /api/mcp/config |
| `adapters/types.ts` | `adapters/adapter-contract.test.ts` | Interface compliance |
| `adapters/registry.ts` | `adapters/registry.test.ts` | Register, get, list, has |
| `services/database.ts` (new helpers) | `services/database.test.ts` | findMcpToken, expireTimedOutApprovals |
| `services/approval-workflow.ts` | `services/approval-workflow.test.ts` | Transactional approval create/resolve, rollback on failure |
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

Any change to approval creation or resolution must also cover the rollback path
so the state transition and command enqueue cannot partially apply.

### MCP setup tests

The provider setup flow must have direct tests for:

- deterministic token handoff from setup to install
- install rejection when no token is provided
- file write behavior for file-backed providers
- env-var-only providers such as Codex and Rev
- unsupported provider rejection
- configured-provider detection from the project root

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

5. **MCP plus helper only.** Do not reintroduce wrapper-era HMAC client-token
   flows, subprocess bridge routes, or deprecated compatibility adapters.

6. **Runner is the local bridge.** New execution features belong in `runner/`
   and the MCP worker APIs, not in ad hoc local wrappers.

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
    *.test.ts            Adapter tests
  services/
    database.ts          SQLite schema + helpers
    websocket.ts         WebSocket hub
  middleware/
    auth.ts              UI session auth
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
| `AIRC_PROVIDER_CLAUDE` | `true` | Enable Claude adapter |
| `AIRC_PROVIDER_CODEX` | `true` | Enable Codex adapter |
| `AIRC_PROVIDER_GEMINI` | `true` | Enable Gemini adapter |
| `AIRC_PROVIDER_OPENCODE` | `true` | Enable OpenCode adapter |
| `AIRC_PROVIDER_ZENFLOW` | `true` | Enable Zenflow adapter |
| `AIRC_PROVIDER_REV` | `true` | Enable Rev adapter |
| `AIRC_APPROVAL_TIMEOUT` | `300` | Default approval timeout (seconds) |
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
| `docs/SECURITY.md` | Threat model |
| `docs/TESTING.md` | Test procedures |
