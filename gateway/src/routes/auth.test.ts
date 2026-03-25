import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { dirname, join } from 'path';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import { authRoutes } from './auth.js';
import { db } from '../services/database.js';

const { testDbPath } = vi.hoisted(() => ({
  testDbPath: process.cwd() + '\\.vitest-data\\auth-routes-' + Math.random().toString(36).slice(2) + '.db',
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

vi.mock('argon2');
vi.mock('otplib', () => ({
  authenticator: {
    generateSecret: vi.fn(() => 'TOTPSECRET'),
    keyuri: vi.fn((user: string, issuer: string, secret: string) => `otpauth://totp/${issuer}:${user}?secret=${secret}`),
    verify: vi.fn(() => true),
  },
}));

function cleanup() {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
}

function buildApp() {
  const fastify = Fastify({ logger: false });
  fastify.register(fastifyCookie, { secret: 'test-auth-secret' });
  fastify.register(authRoutes);
  return fastify;
}

describe('routes/auth', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    cleanup();
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    cleanup();
  });

  it('reports setup required before any users exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      setupRequired: true,
      localAuthEnabled: false,
    });
  });

  it('creates the initial admin user during setup', async () => {
    vi.mocked(argon2.hash).mockResolvedValue('hashed-password' as never);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: {
        username: 'alice',
        password: 'very-strong-password',
        enableTotp: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; userId: string; totpUri: string };
    expect(body.ok).toBe(true);
    expect(body.totpUri).toContain('otpauth://');

    const user = db.prepare('SELECT username, role, totp_secret FROM users WHERE id = ?').get(body.userId) as {
      username: string;
      role: string;
      totp_secret: string;
    };
    expect(user.username).toBe('alice');
    expect(user.role).toBe('admin');
    expect(user.totp_secret).toBe('TOTPSECRET');
  });

  it('accepts email address for initial setup username', async () => {
    vi.mocked(argon2.hash).mockResolvedValue('hashed-password' as never);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: {
        username: 'admin@example.com',
        password: 'very-strong-password',
        enableTotp: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; userId: string };
    expect(body.ok).toBe(true);

    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(body.userId) as { username: string };
    expect(user.username).toBe('admin@example.com');
  });

  it('rejects invalid setup username with 400 instead of 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: {
        username: 'bad username with spaces',
        password: 'very-strong-password',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'Invalid setup payload',
    });
  });

  it('logs in and returns a session cookie for valid credentials', async () => {
    const userId = 'user-1';
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES (?, 'alice', 'hashed', 'admin')
    `).run(userId);
    vi.mocked(argon2.verify).mockResolvedValue(true as never);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'alice',
        password: 'password',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      user: { id: userId, username: 'alice', role: 'admin' },
    });
    expect(res.headers['set-cookie']).toBeDefined();
    expect(String(res.headers['set-cookie'])).toContain('session=');
  });

  it('returns the current user and refreshes the session', async () => {
    const userId = 'user-1';
    const sessionId = 'session-1';
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES (?, 'alice', 'hashed', 'admin')
    `).run(userId);
    db.prepare(`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, ?)
    `).run(sessionId, userId, Math.floor(Date.now() / 1000) + 3600);

    const meRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { session: sessionId },
    });

    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toMatchObject({ user: { id: userId, username: 'alice', role: 'admin' } });

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { session: sessionId },
    });

    expect(refreshRes.statusCode).toBe(200);
    expect(refreshRes.headers['set-cookie']).toBeDefined();
    expect(String(refreshRes.headers['set-cookie'])).toContain('session=');
    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)).toBeUndefined();
  });

  it('allows an admin to create additional users', async () => {
    const userId = 'user-1';
    const sessionId = 'session-admin';
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES (?, 'alice', 'hashed', 'admin')
    `).run(userId);
    db.prepare(`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, ?)
    `).run(sessionId, userId, Math.floor(Date.now() / 1000) + 3600);
    vi.mocked(argon2.hash).mockResolvedValue('other-hash' as never);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/users',
      cookies: { session: sessionId },
      payload: {
        username: 'bob',
        password: 'another-strong-password',
        role: 'operator',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT username, role FROM users WHERE username = ?').get('bob')).toMatchObject({
      username: 'bob',
      role: 'operator',
    });
  });

  it('allows an admin to create users with email usernames', async () => {
    const userId = 'user-1';
    const sessionId = 'session-admin';
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES (?, 'alice', 'hashed', 'admin')
    `).run(userId);
    db.prepare(`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, ?)
    `).run(sessionId, userId, Math.floor(Date.now() / 1000) + 3600);
    vi.mocked(argon2.hash).mockResolvedValue('other-hash' as never);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/users',
      cookies: { session: sessionId },
      payload: {
        username: 'operator@example.com',
        password: 'another-strong-password',
        role: 'operator',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT username, role FROM users WHERE username = ?').get('operator@example.com')).toMatchObject({
      username: 'operator@example.com',
      role: 'operator',
    });
  });
});
