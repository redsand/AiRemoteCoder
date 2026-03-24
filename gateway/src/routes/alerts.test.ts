import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { dirname, join } from 'path';
import { alertsRoutes } from './alerts.js';
import { db } from '../services/database.js';

const { testDbPath } = vi.hoisted(() => ({
  testDbPath: process.cwd() + '\\.vitest-data\\alerts-routes-' + Math.random().toString(36).slice(2) + '.db',
}));

vi.mock('../config.js', () => ({
  config: {
    dbPath: testDbPath,
    projectRoot: process.cwd(),
    dataDir: dirname(testDbPath),
    artifactsDir: join(dirname(testDbPath), 'artifacts'),
    runsDir: join(dirname(testDbPath), 'runs'),
    certsDir: join(dirname(testDbPath), 'certs'),
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
      rev: true,
      legacyWrapper: true,
    },
  },
}));

vi.mock('../services/websocket.js', () => ({
  broadcastAll: vi.fn(),
}));

function cleanup() {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM alert_rules').run();
  db.prepare('DELETE FROM alerts').run();
}

function buildApp() {
  const fastify = Fastify({ logger: false });
  fastify.register(fastifyCookie, { secret: 'test-auth-secret' });
  fastify.register(alertsRoutes);
  return fastify;
}

describe('routes/alerts', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    cleanup();
    app = buildApp();
    await app.ready();
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'user-1', ?)`).run(Math.floor(Date.now() / 1000) + 3600);
  });

  afterEach(async () => {
    await app.close();
    cleanup();
  });

  it('creates alert rules and lists them', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/alerts/rules',
      headers: { cookie: 'session=session-1' },
      payload: {
        name: 'Run failed',
        type: 'run_failed',
        config: { timeoutMinutes: 15 },
      },
    });

    expect(createRes.statusCode).toBe(200);
    const { id } = createRes.json() as { id: string };

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/alerts/rules',
      headers: { cookie: 'session=session-1' },
    });

    expect(listRes.statusCode).toBe(200);
    expect((listRes.json() as Array<{ id: string }>)).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
  });

  it('lists alerts, acknowledges them, and reports stats', async () => {
    db.prepare(`
      INSERT INTO alerts (id, type, severity, title, acknowledged)
      VALUES ('alert-1', 'run_failed', 'critical', 'Run failed', 0)
    `).run();

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/alerts',
      headers: { cookie: 'session=session-1' },
    });

    expect(listRes.statusCode).toBe(200);
    expect((listRes.json() as { alerts: Array<{ id: string }>; unacknowledged: number }).unacknowledged).toBe(1);

    const ackRes = await app.inject({
      method: 'POST',
      url: '/api/alerts/alert-1/acknowledge',
      headers: { cookie: 'session=session-1' },
    });

    expect(ackRes.statusCode).toBe(200);

    const statsRes = await app.inject({
      method: 'GET',
      url: '/api/alerts/stats',
      headers: { cookie: 'session=session-1' },
    });

    expect(statsRes.statusCode).toBe(200);
    expect(statsRes.json()).toMatchObject({ total: 1, unacknowledged: 0 });
  });
});
