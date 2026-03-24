import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join, dirname } from 'path';
import { wrapperAuth, uiAuth, requireRole, type AuthenticatedRequest } from './auth.js';
import { db } from '../services/database.js';
import { createSignature, generateNonce, hashBody, generateCapabilityToken } from '../utils/crypto.js';

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
      rev: true,
      legacyWrapper: true,
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
  db.prepare('DELETE FROM nonces').run();
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

  it('accepts valid wrapper requests and binds run auth', async () => {
    const runId = 'run-1';
    const capabilityToken = generateCapabilityToken();
    db.prepare(`
      INSERT INTO runs (id, status, capability_token, worker_type)
      VALUES (?, 'pending', ?, 'claude')
    `).run(runId, capabilityToken);

    const nonce = generateNonce();
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ input: 'hello' });
    const signature = createSignature({
      method: 'POST',
      path: '/api/runs/run-1/input',
      bodyHash: hashBody(body),
      timestamp,
      nonce,
      runId,
      capabilityToken,
    }, 'test-hmac-secret');

    const request = {
      headers: {
        'x-signature': signature,
        'x-timestamp': String(timestamp),
        'x-nonce': nonce,
        'x-run-id': runId,
        'x-capability-token': capabilityToken,
        'content-type': 'application/json',
      },
      rawBody: body,
      method: 'POST',
      url: '/api/runs/run-1/input',
      ip: '127.0.0.1',
    } as Partial<AuthenticatedRequest> as AuthenticatedRequest;
    const reply = makeReply();

    await wrapperAuth(request, reply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(request.user?.source).toBe('wrapper');
    expect(request.runAuth).toEqual({ runId, capabilityToken });
  });

  it('rejects replayed wrapper nonces', async () => {
    const runId = 'run-2';
    const capabilityToken = generateCapabilityToken();
    db.prepare(`
      INSERT INTO runs (id, status, capability_token, worker_type)
      VALUES (?, 'pending', ?, 'claude')
    `).run(runId, capabilityToken);

    const nonce = generateNonce();
    const body = JSON.stringify({ input: 'hello' });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createSignature({
      method: 'POST',
      path: '/api/runs/run-2/input',
      bodyHash: hashBody(body),
      timestamp,
      nonce,
      runId,
      capabilityToken,
    }, 'test-hmac-secret');

    const request = {
      headers: {
        'x-signature': signature,
        'x-timestamp': String(timestamp),
        'x-nonce': nonce,
        'x-run-id': runId,
        'x-capability-token': capabilityToken,
      },
      rawBody: body,
      method: 'POST',
      url: '/api/runs/run-2/input',
      ip: '127.0.0.1',
    } as Partial<AuthenticatedRequest> as AuthenticatedRequest;
    const reply = makeReply();

    await wrapperAuth(request, reply);
    await wrapperAuth(request, reply);

    expect(reply.code).toHaveBeenLastCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('Nonce already used') }));
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
