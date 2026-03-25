# Security Model

## Threat Model

### Assets to Protect
1. Run prompts, code output, logs, and artifacts
2. MCP bearer tokens and UI sessions
3. Approval decisions and audit history
4. Local execution on paired runner hosts
5. Stored secrets and environment-derived credentials

### Threat Actors
1. Network attackers attempting interception or replay
2. Authenticated users attempting privilege escalation
3. Compromised runner hosts or coding environments
4. Malicious MCP clients or stolen bearer tokens

### Security Assumptions
1. TLS is terminated at the edge or gateway
2. SQLite/database files are not directly exposed
3. Runner hosts are operator-controlled and project-scoped
4. UI auth secrets and MCP token material are stored securely

## Authentication Mechanisms

AiRemoteCoder now has two supported auth surfaces:

### 1. MCP Authentication

Used for agent and runner access to the control plane.

- Transport: `POST /mcp`, `GET /mcp`, `DELETE /mcp`
- Auth: `Authorization: Bearer <token>`
- Validation: `gateway/src/mcp/auth.ts`
- Scope enforcement: per-tool and per-worker-route

#### Token Properties

- Tokens are created via `POST /api/mcp/tokens`
- Raw token is shown once and stored hashed server-side
- Tokens are bound to a user
- Tokens carry explicit scopes such as:
  - `runs:read`
  - `runs:write`
  - `sessions:write`
  - `events:read`
  - `artifacts:read`
  - `approvals:decide`
  - `admin`

#### Session Semantics

- MCP sessions are created during `initialize`
- Session ownership is tied back to the authenticated token
- Reuse of a session requires the same bearer identity
- Standalone helper mode requires explicit `x-airc-runner-id`

### 2. UI Authentication

Used for the human-facing web app and `/api/*` routes.

- Cookie session auth
- Optional bearer-style session auth for API clients
- Optional Cloudflare Access integration
- Validation: `gateway/src/middleware/auth.ts`

#### User Context

Authenticated UI requests receive:

```ts
{
  id: string;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  source: 'cloudflare' | 'session';
}
```

## Authorization Model

### Roles

- `admin`: full system control, token management, approvals, destructive actions
- `operator`: create/manage runs, operate sessions, limited token creation
- `viewer`: read-only access

### MCP Scope Model

Roles govern the UI. Scopes govern MCP.

- UI auth does not imply MCP access
- MCP tokens do not imply full UI privileges
- Non-admin users cannot mint admin/approval-heavy tokens

### Runner Pairing

The local helper must identify itself explicitly:

- `x-airc-runner-id: <stable-host-project-id>`

The gateway uses this to:

- target runs to the intended host/project pair
- prevent ambiguous claims across multiple machines
- partition work safely when the same user has many active environments

## Approval Security

Approval flows are server-authoritative.

- Approval requests are stored durably
- Approval resolution is transactional
- State transition and command enqueue are applied atomically
- Audit records capture resolver identity and rationale

Required protection goals:

- no partial approval resolution
- no client-side source of truth
- no silent bypass of pending approval state

## Audit Logging

Security-relevant actions are recorded in `audit_log`, including:

- run creation/deletion
- token creation/revocation
- command dispatch
- approval decisions
- other privileged UI actions

Audit records should be treated as append-only operational evidence.

## Secure Channel Boundaries

### Human Path

- Browser/UI
- `/api/*`
- WebSocket updates

This is the canonical human control path.

### Agent Path

- MCP tools/resources over HTTP/SSE
- `airc-mcp-runner` polling worker APIs for claim/poll/ack/event flows

This is the canonical agent/runtime path.

The human channel never delegates authority to the agent channel, and the agent
channel never becomes the source of truth for server state.

## Key Security Controls

1. Scoped MCP bearer tokens
2. Per-tool scope enforcement
3. Role-based UI authorization
4. Stable runner identity targeting
5. Secret redaction in events/logs
6. Allowlisted command execution
7. Approval gates for dangerous actions
8. Durable server-side state and audit log
9. Device/session correlation for UI auth
10. Rate limiting and HTTPS deployment posture

## Deployment Guidance

1. Run behind HTTPS only in production
2. Put the gateway behind a trusted reverse proxy or zero-trust edge when possible
3. Restrict shell access on runner hosts
4. Use one MCP token per host/project pairing where practical
5. Rotate tokens when a runner host is repurposed or shared
6. Avoid long-lived broad-scope admin tokens on unattended machines

## Testing Security

Minimum security validation should include:

- invalid/expired MCP token rejection
- wrong-scope MCP rejection
- mismatched MCP session identity rejection
- missing runner-id rejection for standalone helper mode
- session auth rejection for unauthenticated UI calls
- approval rollback on failure
- command allowlist enforcement
- secret redaction in persisted events

## Operational Notes

- The removed wrapper-era HMAC signature flow is no longer part of the supported security model.
- Any references to wrapper-specific signatures, raw-body verification, or client-token registration are obsolete.
