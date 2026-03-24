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

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockTokens: any[] = [];
const mockUsers: any[] = [
  { id: 'user-1', username: 'admin', role: 'admin' },
];

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
    findMcpToken: vi.fn(),
    expireTimedOutApprovals: vi.fn(),
    cleanupExpiredNonces: vi.fn(),
    cleanupExpiredSessions: vi.fn(),
    updateClientStatus: vi.fn(),
  };
});

vi.mock('../services/websocket.js', () => ({ broadcastToRun: vi.fn(), getConnectionStats: vi.fn(() => ({})) }));
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
  StreamableHTTPServerTransport: vi.fn().mockImplementation(() => ({
    handleRequest: vi.fn(),
    onclose: null,
  })),
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
