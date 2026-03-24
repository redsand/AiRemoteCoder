/**
 * MCP plugin integration tests.
 *
 * Tests the HTTP routes registered by mcpPlugin:
 *   GET  /api/mcp/config
 *   POST /api/mcp/tokens
 *   GET  /api/mcp/tokens
 *   DELETE /api/mcp/tokens/:id
 *
 * The MCP transport routes (POST/GET/DELETE /mcp) require the real MCP SDK
 * transport wiring and are covered by the integration test suite.
 * This file focuses on the token management API and config endpoint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockTokens: any[] = [];
const mockUsers: any[] = [
  { id: 'user-1', username: 'admin', role: 'admin' },
];
const mockSessions = new Map<string, { authToken: string }>();
let lastTransport: { handleRequest: ReturnType<typeof vi.fn>; onclose: null | (() => void) } | null = null;
let lastSessionId: string | null = null;

vi.mock('../services/database.js', () => {
  const prepare = (sql: string) => ({
    get: (id: string) => {
      if (sql.includes('FROM sessions')) {
        if (id === 'valid-session') {
          return { user_id: 'user-1', username: 'admin', role: 'admin', expires_at: 9999999999 };
        }
        return undefined;
      }
      if (sql.includes('FROM users')) {
        return mockUsers.find((u) => u.id === id);
      }
      if (sql.includes('FROM mcp_tokens')) {
        return mockTokens.find((t) => t.id === id);
      }
      return undefined;
    },
    all: () => mockTokens.filter((t) => !t.revoked_at),
    run: vi.fn((...args: any[]) => {
      // Simulate INSERT for token creation
      if (sql.includes('INSERT INTO mcp_tokens')) {
        mockTokens.push({ id: args[0], token_hash: args[1], label: args[2], user_id: args[3], scopes: args[4], expires_at: args[5] });
      }
      // Simulate UPDATE for revocation
      if (sql.includes('UPDATE mcp_tokens SET revoked_at')) {
        const t = mockTokens.find((t) => t.id === args[0]);
        if (t) t.revoked_at = Math.floor(Date.now() / 1000);
      }
    }),
  });
  return {
    db: { prepare, pragma: vi.fn(), exec: vi.fn(), close: vi.fn() },
    findMcpToken: vi.fn((hash: string) => {
      const token = mockTokens.find((t) => t.token_hash === hash && !t.revoked_at);
      if (!token) return undefined;
      return {
        id: token.id,
        label: token.label,
        userId: token.user_id,
        scopes: JSON.parse(token.scopes),
      };
    }),
    expireTimedOutApprovals: vi.fn(),
    cleanupExpiredNonces: vi.fn(),
    cleanupExpiredSessions: vi.fn(),
    updateClientStatus: vi.fn(),
  };
});

vi.mock('../services/websocket.js', () => ({ broadcastToRun: vi.fn(), getConnectionStats: vi.fn(() => ({})) }));
vi.mock('./server.js', () => ({
  createMcpServer: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../config.js', () => ({
  config: {
    mcpEnabled: true,
    mcpPath: '/mcp',
    mcpTokenExpirySeconds: 0,
    mcpRateLimit: { max: 300, timeWindow: '1 minute' },
    tlsEnabled: false,
    port: 3100,
    providers: { claude: true, codex: true, gemini: true, opencode: true, rev: true, legacyWrapper: false },
    allowlistedCommands: [],
    approvalTimeoutSeconds: 300,
    maxArtifactSize: 52428800,
    authSecret: 'testsecret',
  },
}));

// @modelcontextprotocol/sdk needs to be mocked for transport tests
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: vi.fn().mockImplementation((opts: any) => {
    const transport = {
      handleRequest: vi.fn(async (_req: any, _res: any, body?: any) => {
        if (body && typeof body === 'object' && body.method === 'initialize') {
          lastSessionId = opts.sessionIdGenerator();
          opts.onsessioninitialized?.(lastSessionId);
          mockSessions.set(lastSessionId, { authToken: 'valid-token' });
        }
      }),
      onclose: null as null | (() => void),
    };
    lastTransport = transport;
    return transport;
  }),
}));
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  isInitializeRequest: vi.fn().mockReturnValue(true),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function buildApp() {
  const fastify = Fastify({ logger: false });
  await fastify.register(fastifyCookie as any, { secret: 'testsecret' });
  const { mcpPlugin } = await import('./plugin.js');
  await fastify.register(mcpPlugin);
  await fastify.ready();
  return fastify;
}

// ---------------------------------------------------------------------------
// Tests: GET /api/mcp/config
// ---------------------------------------------------------------------------

describe('GET /api/mcp/config', () => {
  it('returns MCP configuration without auth', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/mcp/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(typeof body.url).toBe('string');
    expect(body.url).toMatch(/\/mcp$/);
    expect(body.transport).toBe('streamable-http');
    expect(Array.isArray(body.enabledProviders)).toBe(true);
    expect(body.enabledProviders).toContain('claude');
    expect(body.connectionInstructions).toBeDefined();
    expect(body.connectionInstructions.claude_code).toBeDefined();
    expect(Array.isArray(body.availableScopes)).toBe(true);
    expect(body.availableScopes).toContain('vnc:read');
    expect(body.availableScopes).toContain('vnc:control');
    expect(Array.isArray(body.defaultAgentScopes)).toBe(true);
    expect(body.defaultAgentScopes).toContain('vnc:read');
    await app.close();
  });

  it('includes curl_test snippet', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/mcp/config' });
    const body = res.json();
    expect(body.connectionInstructions.curl_test?.command).toContain('curl');
    await app.close();
  });

  it('marks legacy_wrapper as deprecated when enabled', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/mcp/config' });
    const body = res.json();
    // legacyWrapper is false in mock config so it should not appear
    expect(body.enabledProviders).not.toContain('legacy_wrapper');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /mcp, GET /mcp, DELETE /mcp
// ---------------------------------------------------------------------------

describe('MCP transport routes', () => {
  beforeEach(() => {
    mockSessions.clear();
    lastTransport = null;
    lastSessionId = null;
    mockTokens.length = 0;
    mockTokens.push({
      id: 'tok-1',
      token_hash: createHash('sha256').update('valid-token').digest('hex'),
      label: 'session',
      user_id: 'user-1',
      scopes: JSON.stringify([
        'runs:read', 'runs:write', 'runs:cancel',
        'sessions:read', 'sessions:write',
        'events:read', 'artifacts:read',
        'approvals:read', 'approvals:write', 'approvals:decide',
      ]),
    });
    mockTokens.push({
      id: 'tok-2',
      token_hash: createHash('sha256').update('other-token').digest('hex'),
      label: 'other',
      user_id: 'user-1',
      scopes: JSON.stringify(['runs:read']),
    });
  });

  it('rejects POST /mcp without bearer auth', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', method: 'initialize', id: 1, params: {} },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('initializes a session and reuses the same bearer token for GET/DELETE', async () => {
    const app = await buildApp();

    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer valid-token' },
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
      },
    });

    expect(initRes.statusCode).toBe(200);
    expect(lastSessionId).toBeTruthy();
    expect(lastTransport?.handleRequest).toHaveBeenCalled();

    const getRes = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: {
        authorization: 'Bearer valid-token',
        'mcp-session-id': lastSessionId!,
      },
    });

    expect(getRes.statusCode).toBe(200);
    expect(lastTransport?.handleRequest).toHaveBeenCalledTimes(2);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: {
        authorization: 'Bearer valid-token',
        'mcp-session-id': lastSessionId!,
      },
    });

    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json()).toEqual({ ok: true });

    await app.close();
  });

  it('rejects GET /mcp when bearer token does not match the session identity', async () => {
    const app = await buildApp();

    await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer valid-token' },
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: {
        authorization: 'Bearer other-token',
        'mcp-session-id': lastSessionId!,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('Forbidden: session token does not match the authenticated token');

    await app.close();
  });

  it('rejects DELETE /mcp when session is missing', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: {
        authorization: 'Bearer valid-token',
        'mcp-session-id': 'missing-session',
      },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/mcp/tokens (requires UI session)
// ---------------------------------------------------------------------------

describe('POST /api/mcp/tokens', () => {
  it('returns 401 without session', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/tokens',
      payload: { label: 'test-token' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 400 when label is missing', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/tokens',
      cookies: { session: 'valid-session' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('creates token and returns it (admin)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/tokens',
      cookies: { session: 'valid-session' },
      payload: { label: 'my-agent', scopes: ['runs:read', 'runs:write'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.label).toBe('my-agent');
    expect(body.scopes).toContain('runs:read');
    expect(body.warning).toMatch(/Store this token/);
    await app.close();
  });

  it('returns 400 when scopes contains an unknown value', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/tokens',
      cookies: { session: 'valid-session' },
      payload: { label: 'bad-scopes', scopes: ['runs:read', 'not:a:scope'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Invalid scopes/);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/mcp/tokens
// ---------------------------------------------------------------------------

describe('GET /api/mcp/tokens', () => {
  it('returns 401 without session', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/mcp/tokens' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns token list for authenticated user', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/mcp/tokens',
      cookies: { session: 'valid-session' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.tokens)).toBe(true);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Tests: DELETE /api/mcp/tokens/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/mcp/tokens/:id', () => {
  it('returns 401 without session', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/mcp/tokens/tok-1' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 404 for nonexistent token', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/mcp/tokens/nonexistent',
      cookies: { session: 'valid-session' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
