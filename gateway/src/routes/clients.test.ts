import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import { clientsRoutes } from './clients.js';
import { db } from '../services/database.js';
import { rawBodyPlugin } from '../middleware/auth.js';
import { createSignature, generateNonce, hashBody } from '../utils/crypto.js';

const { testDbPath } = vi.hoisted(() => ({
  testDbPath: process.cwd() + '\\.vitest-data\\clients-routes-' + Math.random().toString(36).slice(2) + '.db',
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
  db.prepare('DELETE FROM commands').run();
  db.prepare('DELETE FROM events').run();
  db.prepare('DELETE FROM runs').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM nonces').run();
}

function buildApp() {
  const fastify = Fastify({ logger: false });
  rawBodyPlugin(fastify);
  fastify.register(fastifyCookie, { secret: 'test-auth-secret' });
  fastify.register(clientsRoutes);
  return fastify;
}

function uiSessionHeaders(session: string) {
  return { cookie: `session=${session}` };
}

function wrapperHeaders(method: string, url: string, body: string) {
  const nonce = generateNonce();
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    'x-signature': createSignature({
      method,
      path: url,
      bodyHash: hashBody(body),
      timestamp,
      nonce,
    }, 'test-hmac-secret'),
    'x-timestamp': String(timestamp),
    'x-nonce': nonce,
  };
}

describe('routes/clients', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    cleanup();
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    cleanup();
  });

  afterAll(async () => {
    await app.close();
    cleanup();
  });

  it('creates and rotates a client token for operators', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'user-1', ?)`).run(Math.floor(Date.now() / 1000) + 3600);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/clients/create',
      headers: uiSessionHeaders('session-1'),
      payload: { displayName: 'Agent One', agentId: 'agent-1' },
    });

    expect(createRes.statusCode).toBe(200);
    const created = createRes.json() as { id: string; token: string };
    expect(created.token).toBeTruthy();

    const rotateRes = await app.inject({
      method: 'POST',
      url: `/api/clients/${created.id}/token`,
      headers: uiSessionHeaders('session-1'),
    });

    expect(rotateRes.statusCode).toBe(200);
    expect(rotateRes.json()).toMatchObject({ id: created.id });
  });

  it('registers and heartbeats a wrapper client with the current token', async () => {
    db.prepare(`INSERT INTO clients (id, display_name, agent_id, token_hash, status) VALUES ('client-1', 'Agent One', 'agent-1', ?, 'offline')`).run(
      'deadbeef'
    );

    const token = 'client-token-1';
    const hash = createHash('sha256').update(token).digest('hex');
    db.prepare('UPDATE clients SET token_hash = ? WHERE agent_id = ?').run(hash, 'agent-1');

    const registerBody = JSON.stringify({
      displayName: 'Agent One',
      agentId: 'agent-1',
      version: '1.0.0',
      capabilities: ['runs', 'artifacts'],
    });

    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/clients/register',
      headers: {
        ...wrapperHeaders('POST', '/api/clients/register', registerBody),
        'content-type': 'application/json',
        'x-client-token': token,
      },
      payload: registerBody,
    });

    expect(registerRes.statusCode).toBe(200);
    expect(registerRes.json()).toMatchObject({ updated: true });

    const heartbeatBody = JSON.stringify({ agentId: 'agent-1' });
    const heartbeatRes = await app.inject({
      method: 'POST',
      url: '/api/clients/heartbeat',
      headers: {
        ...wrapperHeaders('POST', '/api/clients/heartbeat', heartbeatBody),
        'content-type': 'application/json',
        'x-client-token': token,
      },
      payload: heartbeatBody,
    });

    expect(heartbeatRes.statusCode).toBe(200);
    expect(heartbeatRes.json()).toMatchObject({ ok: true });
  });

  it('lists clients and returns client details', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'user-1', ?)`).run(Math.floor(Date.now() / 1000) + 3600);
    db.prepare(`
      INSERT INTO clients (id, display_name, agent_id, token_hash, status, capabilities, metadata)
      VALUES ('client-1', 'Agent One', 'agent-1', 'tokenhash', 'online', '["runs"]', '{"os":"linux"}')
    `).run();
    db.prepare(`
      INSERT INTO runs (id, client_id, status, capability_token, worker_type, label)
      VALUES ('run-1', 'client-1', 'running', 'cap-1', 'claude', 'Smoke Run')
    `).run();
    db.prepare(`
      INSERT INTO events (run_id, type, data, timestamp, sequence)
      VALUES ('run-1', 'marker', '{"event":"started"}', unixepoch(), 1)
    `).run();

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: uiSessionHeaders('session-1'),
    });

    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().total).toBe(1);

    const detailRes = await app.inject({
      method: 'GET',
      url: '/api/clients/client-1',
      headers: uiSessionHeaders('session-1'),
    });

    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json()).toMatchObject({
      id: 'client-1',
      display_name: 'Agent One',
    });
  });
});
