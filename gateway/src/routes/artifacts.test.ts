import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { Readable } from 'stream';
import { db } from '../services/database.js';
import { rawBodyPlugin } from '../middleware/auth.js';
import { createSignature, generateCapabilityToken, generateNonce, hashBody } from '../utils/crypto.js';

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
      rev: true,
      legacyWrapper: true,
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
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM nonces').run();
  rmSync(join(artifactRoot, 'artifacts'), { recursive: true, force: true });
}

async function buildApp() {
  const { artifactRoutes } = await import('./artifacts.js');
  if (typeof artifactRoutes !== 'function') {
    throw new Error(`artifactRoutes unresolved: ${String(artifactRoutes)}`);
  }
  const fastify = Fastify({ logger: false });
  rawBodyPlugin(fastify);
  fastify.register(fastifyCookie, { secret: 'test-auth-secret' });
  fastify.register(fastifyMultipart, { limits: { fileSize: 1024 * 1024 } });
  fastify.addHook('preHandler', async (request) => {
    if (request.url === '/api/ingest/artifact') {
      (request as any).file = async () => ({
        filename: 'result.log',
        mimetype: 'text/plain',
        file: Readable.from(['hello artifact']),
      });
    }
  });
  fastify.register(artifactRoutes);
  return fastify;
}

function wrapperHeaders(method: string, url: string, _body: string, runId: string, capabilityToken: string) {
  const nonce = generateNonce();
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    'x-signature': createSignature({
      method,
      path: url,
      bodyHash: hashBody(''),
      timestamp,
      nonce,
      runId,
      capabilityToken,
    }, 'test-hmac-secret'),
    'x-timestamp': String(timestamp),
    'x-nonce': nonce,
    'x-run-id': runId,
    'x-capability-token': capabilityToken,
    'content-type': 'multipart/form-data; boundary=----airemotecoder',
  };
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

  it('uploads an artifact and lists/downloads/deletes it', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'user-1', ?)`).run(Math.floor(Date.now() / 1000) + 3600);
    db.prepare(`
      INSERT INTO runs (id, status, capability_token, worker_type)
      VALUES ('run-1', 'running', ?, 'claude')
    `).run(generateCapabilityToken());

    const capabilityToken = db.prepare('SELECT capability_token FROM runs WHERE id = ?').get('run-1') as { capability_token: string };
    const multipartBody = [
      '------airemotecoder',
      'Content-Disposition: form-data; name="file"; filename="result.log"',
      'Content-Type: text/plain',
      '',
      'hello artifact',
      '------airemotecoder--',
      '',
    ].join('\r\n');

    const uploadRes = await app.inject({
      method: 'POST',
      url: '/api/ingest/artifact',
      headers: {
        ...wrapperHeaders('POST', '/api/ingest/artifact', multipartBody, 'run-1', capabilityToken.capability_token),
        'content-length': String(Buffer.byteLength(multipartBody)),
      },
      payload: multipartBody,
    });

    expect(uploadRes.statusCode).toBe(200);
    const uploaded = uploadRes.json() as { artifactId: string; name: string };
    expect(uploaded.name).toBe('result.log');

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/runs/run-1/artifacts',
      headers: { cookie: 'session=session-1' },
    });

    expect(listRes.statusCode).toBe(200);
    expect((listRes.json() as Array<{ id: string }>)).toEqual(expect.arrayContaining([expect.objectContaining({ id: uploaded.artifactId })]));

    const downloadRes = await app.inject({
      method: 'GET',
      url: `/api/artifacts/${uploaded.artifactId}`,
      headers: { cookie: 'session=session-1' },
    });

    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.headers['content-type']).toContain('text/plain');
    expect(downloadRes.payload).toContain('hello artifact');

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/artifacts/${uploaded.artifactId}`,
      headers: { cookie: 'session=session-1' },
    });

    expect(deleteRes.statusCode).toBe(200);
    expect(db.prepare('SELECT id FROM artifacts WHERE id = ?').get(uploaded.artifactId)).toBeUndefined();
  });
});
