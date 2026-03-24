/**
 * Fastify plugin that mounts the MCP control plane.
 *
 * Routes registered:
 *   POST   /mcp        — receive JSON-RPC messages from MCP clients
 *   GET    /mcp        — open SSE stream (session resume / notifications)
 *   DELETE /mcp        — terminate an MCP session
 *   POST   /api/mcp/tokens          — create an MCP API token (UI auth required)
 *   DELETE /api/mcp/tokens/:id      — revoke an MCP API token (UI auth required)
 *   GET    /api/mcp/tokens          — list the caller's MCP tokens (UI auth required)
 *   GET    /api/mcp/config          — public MCP config (enabled, URL, providers)
 *
 * Transport: MCP Streamable HTTP (2025-03-26 spec)
 * Auth:      Bearer token validated by mcp/auth.ts
 */

import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import { db } from '../services/database.js';
import { config } from '../config.js';
import { createMcpServer } from './server.js';
import { validateMcpToken, extractBearerToken, validateMcpSessionAccess, type McpAuthContext } from './auth.js';
import { uiAuth } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { McpScope } from '../domain/types.js';
import { ALL_MCP_SCOPES } from '../domain/types.js';

const NON_ADMIN_ALLOWED_SCOPES: McpScope[] = [
  'runs:read',
  'runs:write',
  'runs:cancel',
  'vnc:read',
  'vnc:control',
  'sessions:read',
  'sessions:write',
  'events:read',
  'artifacts:read',
];

const DEFAULT_AGENT_SCOPES: McpScope[] = [
  'runs:read',
  'runs:write',
  'runs:cancel',
  'vnc:read',
  'vnc:control',
  'sessions:read',
  'sessions:write',
  'events:read',
  'artifacts:read',
  'artifacts:write',
  'approvals:read',
  'approvals:write',
];

// In-memory session map: sessionId → { transport, authContext }
// For production multi-instance deployments, move this to Redis or DB.
const sessions = new Map<string, {
  transport: StreamableHTTPServerTransport;
  authContext: McpAuthContext;
  createdAt: number;
  lastSeenAt: number;
}>();

export async function mcpPlugin(fastify: FastifyInstance) {
  if (!config.mcpEnabled) {
    fastify.log.info('MCP control plane disabled (AIRC_MCP_ENABLED=false)');
    return;
  }

  fastify.log.info(`MCP control plane enabled at ${config.mcpPath}`);

  // -------------------------------------------------------------------------
  // POST /mcp — handle incoming JSON-RPC messages
  // -------------------------------------------------------------------------
  fastify.post(config.mcpPath, async (req, reply) => {
    // Auth — require Bearer token
    const token = extractBearerToken(req.headers.authorization);
    const authContext = token ? validateMcpToken(token) : null;

    if (!authContext) {
      return reply.code(401).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: valid MCP Bearer token required' },
        id: null,
      });
    }

    // Check for existing session via Mcp-Session-Id header
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return reply.code(404).send({
          jsonrpc: '2.0',
          error: { code: -32002, message: `Session not found: ${sessionId}` },
          id: null,
        });
      }
      const authCheck = validateMcpSessionAccess(session.authContext, req.headers.authorization);
      if (!authCheck.ok) {
        return reply.code(authCheck.statusCode).send({
          jsonrpc: '2.0',
          error: { code: authCheck.statusCode === 401 ? -32001 : -32003, message: authCheck.message },
          id: null,
        });
      }
      session.lastSeenAt = Math.floor(Date.now() / 1000);
      // Hand off to existing transport
      await session.transport.handleRequest(req.raw, reply.raw, req.body);
      return;
    }

    // New session — must be an initialize request
    const body = req.body as any;
    if (!isInitializeRequest(body)) {
      return reply.code(400).send({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'First request to a new session must be initialize' },
        id: body?.id ?? null,
      });
    }

    const newSessionId = nanoid();

    // Create transport with per-request auth context injection
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (sid) => {
        const now = Math.floor(Date.now() / 1000);
        sessions.set(sid, { transport, authContext, createdAt: now, lastSeenAt: now });
        fastify.log.info({ sessionId: sid, user: authContext.user.username }, 'MCP session initialized');
      },
    });

    transport.onclose = () => {
      sessions.delete(newSessionId);
      fastify.log.info({ sessionId: newSessionId }, 'MCP session closed');
    };

    // Create a fresh server per session so getAuthContext() closes over this session's auth
    const mcpServer = createMcpServer(() => sessions.get(newSessionId)?.authContext ?? null);
    await mcpServer.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // -------------------------------------------------------------------------
  // GET /mcp — SSE stream for an existing session
  // -------------------------------------------------------------------------
  fastify.get(config.mcpPath, async (req, reply) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      return reply.code(400).send({ error: 'Mcp-Session-Id header required for SSE stream' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return reply.code(404).send({ error: `Session not found: ${sessionId}` });
    }

    const authCheck = validateMcpSessionAccess(session.authContext, req.headers.authorization);
    if (!authCheck.ok) {
      return reply.code(authCheck.statusCode).send({ error: authCheck.message });
    }

    session.lastSeenAt = Math.floor(Date.now() / 1000);
    await session.transport.handleRequest(req.raw, reply.raw);
  });

  // -------------------------------------------------------------------------
  // DELETE /mcp — terminate a session
  // -------------------------------------------------------------------------
  fastify.delete(config.mcpPath, async (req, reply) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      return reply.code(400).send({ error: 'Mcp-Session-Id header required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return reply.code(404).send({ error: `Session not found: ${sessionId}` });
    }

    const authCheck = validateMcpSessionAccess(session.authContext, req.headers.authorization);
    if (!authCheck.ok) {
      return reply.code(authCheck.statusCode).send({ error: authCheck.message });
    }

    session.lastSeenAt = Math.floor(Date.now() / 1000);
    await session.transport.handleRequest(req.raw, reply.raw);
    sessions.delete(sessionId);
    fastify.log.info({ sessionId }, 'MCP session deleted');
    return reply.code(200).send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // GET /api/mcp/config — public configuration endpoint
  // Used by the UI to show connection instructions and one-click setup.
  // -------------------------------------------------------------------------
  fastify.get('/api/mcp/config', async (req, reply) => {
    const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
    const proto = forwardedProto || (req.protocol ?? (config.tlsEnabled ? 'https' : 'http'));
    const host = req.headers.host || `localhost:${config.port}`;
    const mcpUrl = `${proto}://${host}${config.mcpPath}`;

    const enabledProviders = Object.entries(config.providers)
      .filter(([key, val]) => val && key !== 'legacyWrapper')
      .map(([key]) => key);

    return reply.send({
      enabled: config.mcpEnabled,
      url: mcpUrl,
      transport: 'streamable-http',
      specVersion: '2025-03-26',
      availableScopes: ALL_MCP_SCOPES,
      defaultAgentScopes: DEFAULT_AGENT_SCOPES,
      enabledProviders,
      legacyWrapperDeprecated: config.providers.legacyWrapper,
      connectionInstructions: buildConnectionInstructions(mcpUrl),
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/mcp/tokens — create MCP token (UI session required)
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/mcp/tokens',
    { preHandler: [uiAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const { label, scopes, expiresInDays } = req.body as any;

      if (!label || typeof label !== 'string') {
        return reply.code(400).send({ error: 'label is required' });
      }

      const requestedScopes = Array.isArray(scopes) ? scopes : DEFAULT_AGENT_SCOPES;
      const invalidScopes = requestedScopes.filter((scope) => !ALL_MCP_SCOPES.includes(scope as McpScope));
      if (invalidScopes.length > 0) {
        return reply.code(400).send({
          error: `Invalid scopes requested: ${invalidScopes.join(', ')}`,
          allowedScopes: ALL_MCP_SCOPES,
        });
      }

      const resolvedScopes: McpScope[] = requestedScopes as McpScope[];

      // Admin role can grant any scope; operator/viewer get a limited default
      if (req.user!.role !== 'admin') {
        const filtered = resolvedScopes.filter((s) => NON_ADMIN_ALLOWED_SCOPES.includes(s));
        if (filtered.length !== resolvedScopes.length) {
          return reply.code(403).send({ error: 'Only admin users may create tokens with approval or admin scopes' });
        }
      }

      const rawToken = nanoid(48);
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const tokenId = nanoid();

      const expiresAt = expiresInDays && expiresInDays > 0
        ? Math.floor(Date.now() / 1000) + expiresInDays * 86400
        : null;

      db.prepare(`
        INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(tokenId, tokenHash, label, req.user!.id, JSON.stringify(resolvedScopes), expiresAt);

      return reply.code(201).send({
        id: tokenId,
        token: rawToken,  // only shown once — client must store it
        label,
        scopes: resolvedScopes,
        expiresAt,
        warning: 'Store this token securely — it will not be shown again.',
      });
    }
  );

  // -------------------------------------------------------------------------
  // GET /api/mcp/tokens — list tokens for current user (UI session required)
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/mcp/tokens',
    { preHandler: [uiAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const tokens = db.prepare(`
        SELECT id, label, scopes, created_at, expires_at, last_used_at, revoked_at
        FROM mcp_tokens WHERE user_id = ?
        ORDER BY created_at DESC
      `).all(req.user!.id);

      return reply.send({ tokens });
    }
  );

  // -------------------------------------------------------------------------
  // GET /api/mcp/sessions — list active MCP sessions (UI session required)
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/mcp/sessions',
    { preHandler: [uiAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const entries = Array.from(sessions.entries()).map(([id, session]) => ({
        id,
        user: {
          id: session.authContext.user.id,
          username: session.authContext.user.username,
          role: session.authContext.user.role,
        },
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        scopes: session.authContext.scopes,
      }));

      const visible = req.user?.role === 'admin'
        ? entries
        : entries.filter((entry) => entry.user.id === req.user?.id);

      return reply.send({
        sessions: visible,
        total: visible.length,
      });
    }
  );

  // -------------------------------------------------------------------------
  // DELETE /api/mcp/tokens/:id — revoke a token (UI session required)
  // -------------------------------------------------------------------------
  fastify.delete(
    '/api/mcp/tokens/:id',
    { preHandler: [uiAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const { id } = req.params as { id: string };

      const token = db.prepare('SELECT id, user_id FROM mcp_tokens WHERE id = ?').get(id) as any;
      if (!token) return reply.code(404).send({ error: 'Token not found' });

      // Users can only revoke their own tokens; admins can revoke any
      if (token.user_id !== req.user!.id && req.user!.role !== 'admin') {
        return reply.code(403).send({ error: 'Cannot revoke another user\'s token' });
      }

      db.prepare('UPDATE mcp_tokens SET revoked_at = unixepoch() WHERE id = ?').run(id);

      return reply.send({ ok: true, id });
    }
  );

  fastify.log.info({
    path: config.mcpPath,
    tokenEndpoint: '/api/mcp/tokens',
    configEndpoint: '/api/mcp/config',
  }, 'MCP plugin registered');
}

// ---------------------------------------------------------------------------
// Connection instruction snippets per provider
// ---------------------------------------------------------------------------

function buildConnectionInstructions(mcpUrl: string): Record<string, object> {
  return {
    claude_code: {
      description: 'Add to .claude/mcp.json or claude_desktop_config.json',
      config: {
        mcpServers: {
          airemotecoder: {
            type: 'http',
            url: mcpUrl,
            headers: { Authorization: 'Bearer <YOUR_MCP_TOKEN>' },
          },
        },
      },
    },
    codex: {
      description: 'Codex MCP setup (AiRemoteCoder only)',
      commands: [
        `codex mcp add airemotecoder --url ${mcpUrl}`,
      ],
      bash: {
        overwriteFile: `mkdir -p ~/.codex
cat > ~/.codex/config.toml <<'EOF'
[mcp_servers.airemotecoder]
url = "${mcpUrl}"
bearer_token_env_var = "AIREMOTECODER_MCP_TOKEN"
EOF`,
        replaceBlock: `mkdir -p ~/.codex
touch ~/.codex/config.toml
awk '
BEGIN { skip=0 }
$0 ~ /^\\[mcp_servers\\.airemotecoder\\]/ { skip=1; next }
$0 ~ /^\\[/ { if (skip==1) skip=0 }
skip==0 { print }
' ~/.codex/config.toml > ~/.codex/config.toml.tmp
mv ~/.codex/config.toml.tmp ~/.codex/config.toml
cat >> ~/.codex/config.toml <<'EOF'

[mcp_servers.airemotecoder]
url = "${mcpUrl}"
bearer_token_env_var = "AIREMOTECODER_MCP_TOKEN"
EOF`,
      },
      powershell: {
        overwriteFile: `$configDir = Join-Path $HOME ".codex"
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
@'
[mcp_servers.airemotecoder]
url = "${mcpUrl}"
bearer_token_env_var = "AIREMOTECODER_MCP_TOKEN"
'@ | Set-Content -Path (Join-Path $configDir "config.toml") -Encoding utf8`,
        replaceBlock: `$configDir = Join-Path $HOME ".codex"
$configPath = Join-Path $configDir "config.toml"
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
if (!(Test-Path $configPath)) { New-Item -ItemType File -Path $configPath | Out-Null }
$content = Get-Content -Raw -Path $configPath
$content = [regex]::Replace($content, "(?ms)\\n?\\[mcp_servers\\.airemotecoder\\].*?(?=\\n\\[|$)", "")
Set-Content -Path $configPath -Value $content -Encoding utf8
@'

[mcp_servers.airemotecoder]
url = "${mcpUrl}"
bearer_token_env_var = "AIREMOTECODER_MCP_TOKEN"
'@ | Add-Content -Path $configPath -Encoding utf8`,
      },
      env: {
        AIREMOTECODER_MCP_TOKEN: '<YOUR_MCP_TOKEN>',
      },
      note: 'Set AIREMOTECODER_MCP_TOKEN in your shell/session before starting codex. Use overwriteFile for a clean reset or replaceBlock to update only the airemotecoder entry.',
    },
    gemini_cli: {
      description: 'Add to gemini settings.json',
      config: {
        mcpServers: {
          airemotecoder: {
            httpUrl: mcpUrl,
            headers: { Authorization: 'Bearer <YOUR_MCP_TOKEN>' },
          },
        },
      },
    },
    opencode: {
      description: 'Add to opencode config',
      config: {
        mcp: {
          servers: [{
            name: 'airemotecoder',
            type: 'http',
            url: mcpUrl,
            headers: { Authorization: 'Bearer <YOUR_MCP_TOKEN>' },
          }],
        },
      },
    },
    rev: {
      description: 'Rev MCP adapter config (via adapter shim)',
      env: {
        AIRC_MCP_URL: mcpUrl,
        AIRC_MCP_TOKEN: '<YOUR_MCP_TOKEN>',
      },
      note: 'Rev native MCP support pending verification. Use adapter shim.',
    },
    curl_test: {
      description: 'Test connectivity with curl',
      command: `curl -X POST ${mcpUrl} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <YOUR_MCP_TOKEN>" \\
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.0.1"}},"id":1}'`,
    },
  };
}
