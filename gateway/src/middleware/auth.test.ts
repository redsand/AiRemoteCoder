import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join, dirname } from 'path';
import { uiAuth, requireRole, type AuthenticatedRequest } from './auth.js';
import { db } from '../services/database.js';

const { testDbPath } = vi.hoisted(() => ({
  testDbPath: process.cwd() + '\\.vitest-data\\middleware-auth-' + Math.random().toString(36).slice(2) + '.db',
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
      zenflow: true,
      rev: true,
    },
  },
}));

function makeReply() {
  return {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
    setCookie: vi.fn().mockReturnThis(),
    clearCookie: vi.fn().mockReturnThis(),
  } as any;
}

function cleanup() {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM runs').run();
  db.prepare('DELETE FROM clients').run();
}

describe('middleware/auth', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it('accepts a valid session cookie for ui auth', async () => {
    const userId = 'user-1';
    const sessionId = 'session-1';
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES (?, 'alice', 'hash', 'admin')
    `).run(userId);
    db.prepare(`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, ?)
    `).run(sessionId, userId, Math.floor(Date.now() / 1000) + 3600);

    const request = {
      headers: {},
      cookies: { session: sessionId },
      unsignCookie: vi.fn().mockReturnValue({ valid: false, value: '' }),
      ip: '127.0.0.1',
    } as Partial<AuthenticatedRequest> as AuthenticatedRequest;
    const reply = makeReply();

    await uiAuth(request, reply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(request.user).toMatchObject({
      id: userId,
      username: 'alice',
      role: 'admin',
      source: 'session',
    });
    expect(request.deviceId).toMatch(/^dev_[A-Za-z0-9_-]{16,64}$/);
    expect(reply.setCookie).toHaveBeenCalled();
  });

  it('uses trusted signed device cookie and ignores spoofed device headers', async () => {
    const userId = 'user-1';
    const sessionId = 'session-1';
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES (?, 'alice', 'hash', 'admin')
    `).run(userId);
    db.prepare(`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, ?)
    `).run(sessionId, userId, Math.floor(Date.now() / 1000) + 3600);

    const request = {
      headers: { 'x-airc-device-id': 'attacker-controlled' },
      cookies: { session: sessionId, airc_device_id: 'signed-cookie-value' },
      unsignCookie: vi.fn().mockReturnValue({ valid: true, value: 'dev_trusted_device_123456' }),
      ip: '127.0.0.1',
    } as Partial<AuthenticatedRequest> as AuthenticatedRequest;
    const reply = makeReply();

    await uiAuth(request, reply);

    expect(request.deviceId).toBe('dev_trusted_device_123456');
    expect(reply.setCookie).not.toHaveBeenCalled();
  });

  it('rejects ui auth without a session', async () => {
    const request = {
      headers: {},
      cookies: {},
      ip: '127.0.0.1',
    } as Partial<AuthenticatedRequest> as AuthenticatedRequest;
    const reply = makeReply();

    await uiAuth(request, reply);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: 'Authentication required' }));
  });

  it('enforces required roles', async () => {
    const request = {
      user: { id: 'user-1', username: 'alice', role: 'viewer', source: 'session' },
    } as Partial<AuthenticatedRequest> as AuthenticatedRequest;
    const reply = makeReply();

    const check = requireRole('admin');
    await check(request, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: 'Insufficient permissions' }));
  });
});
