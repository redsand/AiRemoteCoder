import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { dirname, join } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { db } from '../services/database.js';
import { generateCapabilityToken } from '../utils/crypto.js';

const { artifactRoot, testDbPath } = vi.hoisted(() => {
  const suffix = Math.random().toString(36).slice(2);
  const root = process.cwd() + '\\.vitest-data\\artifacts-routes-' + suffix;
  return {
    artifactRoot: root,
    testDbPath: root + '\\gateway.db',
  };
});

vi.mock('../config.js', () => ({
  config: {
    dbPath: testDbPath,
    projectRoot: process.cwd(),
    dataDir: dirname(testDbPath),
    artifactsDir: join(artifactRoot, 'artifacts'),
    runsDir: join(artifactRoot, 'runs'),
    certsDir: join(artifactRoot, 'certs'),
    port: 3100,
    host: '127.0.0.1',
    tlsEnabled: false,
    authSecret: 'test-auth-secret',
    hmacSecret: 'test-hmac-secret',
    clockSkewSeconds: 300,
    nonceExpirySeconds: 600,
    claimLeaseSeconds: 60,
    approvalTimeoutSeconds: 300,
    rateLimit: { max: 100, timeWindow: '1 minute' },
    allowlistedCommands: ['npm test', 'git status'],
    cfAccessTeam: '',
    mcpEnabled: true,
    mcpPath: '/mcp',
    mcpTokenExpirySeconds: 86400,
    mcpRateLimit: { max: 300, timeWindow: '1 minute' },
    providers: {
      claude: true,
      codex: true,
      gemini: true,
      opencode: true,
      zenflow: true,
      rev: true,
    },
    maxArtifactSize: 1024 * 1024,
  },
}));

vi.mock('../services/websocket.js', () => ({
  broadcastToRun: vi.fn(),
}));

function cleanup() {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM artifacts').run();
  db.prepare('DELETE FROM runs').run();
  rmSync(join(artifactRoot, 'artifacts'), { recursive: true, force: true });
}

async function buildApp() {
  const { artifactRoutes } = await import('./artifacts.js');
  if (typeof artifactRoutes !== 'function') {
    throw new Error(`artifactRoutes unresolved: ${String(artifactRoutes)}`);
  }
  const fastify = Fastify({ logger: false });
  fastify.register(fastifyCookie, { secret: 'test-auth-secret' });
  fastify.register(artifactRoutes);
  return fastify;
}

describe('routes/artifacts', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    cleanup();
    mkdirSync(join(artifactRoot, 'artifacts'), { recursive: true });
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    cleanup();
  });

  afterAll(async () => {
    await app.close();
    cleanup();
  });

  it('lists, downloads, and deletes an artifact', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'user-1', ?)`).run(Math.floor(Date.now() / 1000) + 3600);
    db.prepare(`
      INSERT INTO runs (id, status, capability_token, worker_type)
      VALUES ('run-1', 'running', ?, 'claude')
    `).run(generateCapabilityToken());
    const filePath = join(artifactRoot, 'artifacts', 'run-1', 'artifact-1_result.log');
    mkdirSync(join(artifactRoot, 'artifacts', 'run-1'), { recursive: true });
    writeFileSync(filePath, 'hello artifact', 'utf8');
    db.prepare(`
      INSERT INTO artifacts (id, run_id, name, type, size, path)
      VALUES ('artifact-1', 'run-1', 'result.log', 'log', 14, ?)
    `).run(filePath);

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/runs/run-1/artifacts',
      headers: { cookie: 'session=session-1' },
    });

    expect(listRes.statusCode).toBe(200);
    expect((listRes.json() as Array<{ id: string }>)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'artifact-1' })]));

    const downloadRes = await app.inject({
      method: 'GET',
      url: '/api/artifacts/artifact-1',
      headers: { cookie: 'session=session-1' },
    });

    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.headers['content-type']).toContain('text/plain');
    expect(downloadRes.payload).toContain('hello artifact');

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/api/artifacts/artifact-1',
      headers: { cookie: 'session=session-1' },
    });

    expect(deleteRes.statusCode).toBe(200);
    expect(db.prepare('SELECT id FROM artifacts WHERE id = ?').get('artifact-1')).toBeUndefined();
  });
});
