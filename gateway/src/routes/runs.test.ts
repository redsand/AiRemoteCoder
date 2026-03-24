import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import { runsRoutes } from './runs.js';
import { db } from '../services/database.js';
import { rawBodyPlugin } from '../middleware/auth.js';
import { createSignature, generateNonce, hashBody } from '../utils/crypto.js';

const { testDbPath } = vi.hoisted(() => ({
  testDbPath: process.cwd() + '\\.vitest-data\\runs-routes-' + Math.random().toString(36).slice(2) + '.db',
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
  broadcastToRun: vi.fn(),
}));

function cleanup() {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM commands').run();
  db.prepare('DELETE FROM events').run();
  db.prepare('DELETE FROM run_state').run();
  db.prepare('DELETE FROM runs').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM nonces').run();
}

function buildApp() {
  const fastify = Fastify({ logger: false });
  rawBodyPlugin(fastify);
  fastify.register(fastifyCookie, { secret: 'test-auth-secret' });
  fastify.register(runsRoutes);
  return fastify;
}

function adminSessionHeaders(session: string) {
  return { cookie: `session=${session}` };
}

function wrapperHeaders(method: string, url: string, body: string, runId?: string, capabilityToken?: string, clientToken?: string) {
  const nonce = generateNonce();
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    'x-signature': createSignature({
      method,
      path: url,
      bodyHash: hashBody(body),
      timestamp,
      nonce,
      runId,
      capabilityToken,
    }, 'test-hmac-secret'),
    'x-timestamp': String(timestamp),
    'x-nonce': nonce,
    ...(runId ? { 'x-run-id': runId } : {}),
    ...(capabilityToken ? { 'x-capability-token': capabilityToken } : {}),
    ...(clientToken ? { 'x-client-token': clientToken } : {}),
  };
}

describe('routes/runs', () => {
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

  it('creates, lists, and retrieves a run', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'user-1', ?)`).run(Math.floor(Date.now() / 1000) + 3600);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: adminSessionHeaders('session-1'),
      payload: {
        command: 'npm test',
        label: 'Smoke run',
        workerType: 'claude',
        workingDir: process.cwd(),
      },
    });

    expect(createRes.statusCode).toBe(200);
    const created = createRes.json() as { id: string; capabilityToken: string };

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: adminSessionHeaders('session-1'),
    });

    expect(listRes.statusCode).toBe(200);
    expect((listRes.json() as { runs: Array<{ id: string }> }).runs).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id })]));

    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${created.id}`,
      headers: adminSessionHeaders('session-1'),
    });

    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json()).toMatchObject({ id: created.id, status: 'pending' });
  });

  it('claims a pending run with a valid client token', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'user-1', ?)`).run(Math.floor(Date.now() / 1000) + 3600);

    const clientToken = 'client-token';
    const clientHash = createHash('sha256').update(clientToken).digest('hex');
    db.prepare(`
      INSERT INTO clients (id, display_name, agent_id, token_hash, status)
      VALUES ('client-1', 'Agent One', 'agent-1', ?, 'online')
    `).run(clientHash);
    db.prepare(`
      INSERT INTO runs (id, status, capability_token, worker_type, command)
      VALUES ('run-1', 'pending', 'cap-1', 'claude', 'npm test')
    `).run();

    const claimBody = JSON.stringify({ agentId: 'agent-1' });
    const claimRes = await app.inject({
      method: 'POST',
      url: '/api/runs/claim',
      headers: {
        ...wrapperHeaders('POST', '/api/runs/claim', claimBody, undefined, undefined, clientToken),
        'content-type': 'application/json',
      },
      payload: claimBody,
    });

    expect(claimRes.statusCode).toBe(200);
    expect(claimRes.json()).toHaveProperty('run.id', 'run-1');
  });

  it('persists and returns run state for wrapper sessions', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'user-1', ?)`).run(Math.floor(Date.now() / 1000) + 3600);

    db.prepare(`
      INSERT INTO runs (id, status, capability_token, worker_type, command)
      VALUES ('run-1', 'running', 'cap-1', 'claude', 'npm test')
    `).run();

    const stateBody = JSON.stringify({
      workingDir: process.cwd(),
      lastSequence: 7,
      stdinBuffer: 'abc',
      environment: { NODE_ENV: 'test' },
    });

    const stateRes = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/state',
      headers: {
        ...wrapperHeaders('POST', '/api/runs/run-1/state', stateBody, 'run-1', 'cap-1'),
        'content-type': 'application/json',
      },
      payload: stateBody,
    });

    expect(stateRes.statusCode).toBe(200);

    const getStateRes = await app.inject({
      method: 'GET',
      url: '/api/runs/run-1/state',
      headers: adminSessionHeaders('session-1'),
    });

    expect(getStateRes.statusCode).toBe(200);
    expect(getStateRes.json()).toMatchObject({
      run: { id: 'run-1', status: 'running' },
      canResume: false,
    });
  });
});
