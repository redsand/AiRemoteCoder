import Fastify from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const { projectRoot } = vi.hoisted(() => ({
  projectRoot: `${process.cwd()}\\.test-data\\mcp-setup-${Math.random().toString(36).slice(2)}`,
}));

const tokens: Array<{ id: string; token_hash: string; label: string; user_id: string; scopes: string }> = [];

vi.mock('../config.js', () => ({
  config: {
    projectRoot,
    tlsEnabled: false,
    port: 3100,
    mcpPath: '/mcp',
  },
}));

vi.mock('../middleware/auth.js', () => ({
  uiAuth: (req: any, _reply: any, done: () => void) => {
    req.user = { id: 'user-1', username: 'alice', role: 'admin' };
    done();
  },
}));

vi.mock('../services/database.js', () => ({
  db: {
    prepare: (sql: string) => ({
      get: () => undefined,
      all: () => [],
      run: (...args: any[]) => {
        if (sql.includes('INSERT INTO mcp_tokens')) {
          tokens.push({
            id: args[0],
            token_hash: args[1],
            label: args[2],
            user_id: args[3],
            scopes: args[4],
          });
        }
        if (sql.includes('UPDATE mcp_tokens SET revoked_at')) {
          const token = tokens.find((entry) => entry.id === args[0]);
          if (token) {
            (token as any).revoked_at = Math.floor(Date.now() / 1000);
          }
        }
      },
    }),
  },
}));

describe('mcpSetupRoutes', () => {
  beforeEach(() => {
    tokens.length = 0;
    mkdirSync(projectRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function buildApp() {
    const app = Fastify({ logger: false });
    const { mcpSetupRoutes } = await import('./mcp-setup.js');
    await app.register(mcpSetupRoutes);
    await app.ready();
    return app;
  }

  it('uses the same token for setup and auto-install', async () => {
    const app = await buildApp();

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude',
    });

    expect(setupRes.statusCode).toBe(200);
    const setup = setupRes.json() as { token: string; snippet: any };
    expect(setup.snippet.mcpServers.airemotecoder.headers.Authorization).toBe(`Bearer ${setup.token}`);

    const installRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude/install',
      payload: { token: setup.token },
    });

    expect(installRes.statusCode).toBe(200);
    const install = installRes.json() as { token: string; filePath: string };
    expect(install.token).toBe(setup.token);

    const writtenPath = join(projectRoot, '.claude', 'mcp.json');
    expect(existsSync(writtenPath)).toBe(true);
    const written = JSON.parse(readFileSync(writtenPath, 'utf-8')) as any;
    expect(written.mcpServers.airemotecoder.headers.Authorization).toBe(`Bearer ${setup.token}`);

    await app.close();
  });

  it('rejects install without a token', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude/install',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns an env snippet for codex install without writing a file', async () => {
    const app = await buildApp();

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/codex',
    });

    expect(setupRes.statusCode).toBe(200);
    const setup = setupRes.json() as { token: string };

    const installRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/codex/install',
      payload: { token: setup.token },
    });

    expect(installRes.statusCode).toBe(200);
    const install = installRes.json() as { installed: boolean; snippet: string; token: string };
    expect(install.installed).toBe(false);
    expect(install.snippet).toContain('MCP_SERVER_URL=');
    expect(install.snippet).toContain(`MCP_SERVER_TOKEN=${setup.token}`);
    expect(install.token).toBe(setup.token);

    await app.close();
  });

  it('rejects unsupported providers', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/discord',
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('reports configured providers from the project root', async () => {
    const app = await buildApp();
    const configuredPath = join(projectRoot, '.claude', 'mcp.json');
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(configuredPath, JSON.stringify({
      mcpServers: {
        airemotecoder: {
          url: 'http://localhost:3100/mcp',
        },
      },
    }, null, 2), 'utf-8');

    const res = await app.inject({
      method: 'GET',
      url: '/api/mcp/setup/status',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: Record<string, { configured: boolean; exists: boolean }> };
    expect(body.status.claude.configured).toBe(true);
    expect(body.status.claude.exists).toBe(true);

    await app.close();
  });

  it('supports Zenflow auto-install with its own config path', async () => {
    const app = await buildApp();

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/zenflow',
    });

    expect(setupRes.statusCode).toBe(200);
    const setup = setupRes.json() as { token: string };

    const installRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/zenflow/install',
      payload: { token: setup.token },
    });

    expect(installRes.statusCode).toBe(200);
    const install = installRes.json() as { installed: boolean; filePath: string };
    expect(install.installed).toBe(true);
    expect(install.filePath).toContain('.zenflow');

    await app.close();
  });
});
