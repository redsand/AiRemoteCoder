import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { rawBodyPlugin } from '../middleware/auth.js';
import { clientsRoutes } from './clients.js';
import { runsRoutes } from './runs.js';
import { db } from '../services/database.js';
import { createSignature, hashBody, generateNonce } from '../utils/crypto.js';
import { config } from '../config.js';

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  rawBodyPlugin(app);
  app.register(clientsRoutes);
  app.register(runsRoutes);
  return app;
}

function makeUiAuthHeaders(sessionToken: string) {
  return { Authorization: `Bearer ${sessionToken}` };
}

function makeWrapperAuthHeaders(method: string, path: string, body: string, runId?: string, capabilityToken?: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = generateNonce();
  const signature = createSignature({
    method,
    path,
    bodyHash: hashBody(body),
    timestamp,
    nonce,
    runId,
    capabilityToken
  }, config.hmacSecret);

  return {
    'X-Timestamp': timestamp.toString(),
    'X-Nonce': nonce,
    'X-Signature': signature,
    ...(runId ? { 'X-Run-Id': runId } : {}),
    ...(capabilityToken ? { 'X-Capability-Token': capabilityToken } : {}),
  };
}

describe('Client Tokens', () => {
  let app: FastifyInstance;
  const userId = 'user-test';
  const sessionId = 'session-test';
  const clientId = 'client-test';
  const agentId = 'agent-test';

  beforeAll(async () => {
    app = buildTestApp();
    await app.ready();
  });

  afterEach(async () => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.prepare('DELETE FROM runs WHERE id = ?').run('run-test');
    db.prepare('DELETE FROM clients WHERE id = ?').run(clientId);
    db.prepare('DELETE FROM nonces').run();
  });

  it('creates a client token and rotates it', async () => {
    db.prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?)').run(userId, 'admin', 'admin');
    db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sessionId, userId, Math.floor(Date.now() / 1000) + 3600);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/clients/create',
      headers: makeUiAuthHeaders(sessionId),
      payload: { displayName: 'Test Runner', agentId }
    });

    expect(createResponse.statusCode).toBe(200);
    const created = JSON.parse(createResponse.payload);
    expect(created.token).toBeTruthy();

    const rotateResponse = await app.inject({
      method: 'POST',
      url: `/api/clients/${created.id}/token`,
      headers: makeUiAuthHeaders(sessionId)
    });

    expect(rotateResponse.statusCode).toBe(200);
    const rotated = JSON.parse(rotateResponse.payload);
    expect(rotated.token).toBeTruthy();
    expect(rotated.token).not.toBe(created.token);
  });

  it('rejects register/claim without a valid client token', async () => {
    db.prepare('INSERT INTO clients (id, display_name, agent_id, token_hash, status) VALUES (?, ?, ?, ?, ?)').run(
      clientId,
      'Test Runner',
      agentId,
      'deadbeef',
      'offline'
    );

    const registerBody = JSON.stringify({
      displayName: 'Test Runner',
      agentId,
      capabilities: ['run_execution']
    });

    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/clients/register',
      headers: {
        ...makeWrapperAuthHeaders('POST', '/api/clients/register', registerBody),
        'Content-Type': 'application/json'
      },
      payload: registerBody
    });

    expect(registerResponse.statusCode).toBe(403);

    const claimBody = JSON.stringify({ agentId });
    const claimResponse = await app.inject({
      method: 'POST',
      url: '/api/runs/claim',
      headers: {
        ...makeWrapperAuthHeaders('POST', '/api/runs/claim', claimBody),
        'Content-Type': 'application/json'
      },
      payload: claimBody
    });

    expect(claimResponse.statusCode).toBe(403);
  });
});
