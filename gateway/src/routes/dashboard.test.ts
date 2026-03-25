import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { dirname, join } from 'path';
import { dashboardRoutes } from './dashboard.js';
import { db } from '../services/database.js';

const { testDbPath } = vi.hoisted(() => ({
  testDbPath: process.cwd() + '\\.vitest-data\\dashboard-routes-' + Math.random().toString(36).slice(2) + '.db',
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
      zenflow: true,
    },
  },
}));

function cleanup() {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM commands').run();
  db.prepare('DELETE FROM artifacts').run();
  db.prepare('DELETE FROM events').run();
  db.prepare('DELETE FROM runs').run();
  db.prepare('DELETE FROM alerts').run();
}

function buildApp() {
  const fastify = Fastify({ logger: false });
  fastify.register(fastifyCookie, { secret: 'test-auth-secret' });
  fastify.register(dashboardRoutes);
  return fastify;
}

describe('routes/dashboard', () => {
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

  it('summarizes runs and alerts that need attention', async () => {
    db.prepare(`
      INSERT INTO runs (id, status, label, command, capability_token, waiting_approval, created_at, finished_at, error_message, worker_type)
      VALUES
      ('run-1', 'pending', 'Awaiting approval', 'npm test', 'cap-1', 1, ?, NULL, NULL, 'claude'),
      ('run-2', 'failed', 'Failed run', 'npm test', 'cap-2', 0, ?, ?, 'boom', 'claude'),
      ('run-3', 'running', 'Active run', 'npm test', 'cap-3', 0, ?, NULL, NULL, 'claude')
    `).run(
      Math.floor(Date.now() / 1000) - 1000,
      Math.floor(Date.now() / 1000) - 2000,
      Math.floor(Date.now() / 1000) - 1000,
      Math.floor(Date.now() / 1000) - 100
    );
    db.prepare(`
      INSERT INTO alerts (id, type, severity, title, acknowledged, created_at)
      VALUES ('alert-1', 'run_failed', 'critical', 'Run failed', 0, unixepoch())
    `).run();

    const res = await app.inject({
      method: 'GET',
      url: '/api/dashboard/needs-attention',
      headers: { cookie: 'session=session-1' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      waitingApproval: any[];
      failedRuns: any[];
      unacknowledgedAlerts: any[];
      counts: { waitingApproval: number; failedRuns: number; unacknowledgedAlerts: number };
    };
    expect(body.counts.waitingApproval).toBe(1);
    expect(body.counts.failedRuns).toBe(1);
    expect(body.counts.unacknowledgedAlerts).toBe(1);
  });

  it('returns active runs and recent activity', async () => {
    db.prepare(`
      INSERT INTO runs (id, status, label, command, capability_token, waiting_approval, created_at, started_at, worker_type)
      VALUES ('run-1', 'running', 'Active run', 'npm test', 'cap-1', 0, ?, ?, 'claude')
    `).run(Math.floor(Date.now() / 1000) - 60, Math.floor(Date.now() / 1000) - 30);
    db.prepare(`
      INSERT INTO commands (id, run_id, command, status, created_at, acked_at)
      VALUES ('cmd-1', 'run-1', 'echo hello', 'completed', ?, ?)
    `).run(Math.floor(Date.now() / 1000) - 20, Math.floor(Date.now() / 1000) - 10);
    db.prepare(`
      INSERT INTO artifacts (id, run_id, name, type, size, path, created_at)
      VALUES ('art-1', 'run-1', 'log.txt', 'log', 4, ?, ?)
    `).run(join(process.cwd(), '.test-data', 'log.txt'), Math.floor(Date.now() / 1000) - 5);
    db.prepare(`
      INSERT INTO events (run_id, type, data, timestamp, sequence)
      VALUES ('run-1', 'marker', '{"event":"started"}', ?, 1)
    `).run(Math.floor(Date.now() / 1000) - 15);

    const activeRes = await app.inject({
      method: 'GET',
      url: '/api/dashboard/active-runs',
      headers: { cookie: 'session=session-1' },
    });
    const activityRes = await app.inject({
      method: 'GET',
      url: '/api/dashboard/activity',
      headers: { cookie: 'session=session-1' },
    });

    expect(activeRes.statusCode).toBe(200);
    expect(activeRes.json()).toHaveLength(1);
    expect(activityRes.statusCode).toBe(200);
    expect(activityRes.json().length).toBeGreaterThan(0);
  });

  it('returns overall dashboard stats', async () => {
    db.prepare(`
      INSERT INTO runs (id, status, label, command, capability_token, worker_type)
      VALUES ('run-1', 'done', 'Done run', 'npm test', 'cap-1', 'claude')
    `).run();
    db.prepare(`
      INSERT INTO events (run_id, type, data, timestamp, sequence)
      VALUES ('run-1', 'marker', '{"event":"finished"}', unixepoch(), 1)
    `).run();

    const res = await app.inject({
      method: 'GET',
      url: '/api/dashboard/stats',
      headers: { cookie: 'session=session-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      runs: expect.objectContaining({ total: 1, done: 1 }),
      alerts: expect.objectContaining({ unacknowledged: 0 }),
    });
  });
});
