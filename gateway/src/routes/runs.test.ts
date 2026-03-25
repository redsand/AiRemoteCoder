import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import { runsRoutes } from './runs.js';
import { vncRoutes } from './vnc.js';
import { db } from '../services/database.js';
import { clearMcpSessionsForTests, registerMcpSession } from '../mcp/session-registry.js';

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
    secretPatterns: [],
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
}

function buildApp() {
  const fastify = Fastify({ logger: false });
  fastify.register(fastifyCookie, { secret: 'test-auth-secret' });
  fastify.register(runsRoutes);
  fastify.register(vncRoutes);
  return fastify;
}

function adminSessionHeaders(session: string) {
  return { cookie: `session=${session}` };
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
    clearMcpSessionsForTests();
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

  it('persists and returns run state for UI queries', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'user-1', ?)`).run(Math.floor(Date.now() / 1000) + 3600);

    db.prepare(`
      INSERT INTO runs (id, status, capability_token, worker_type, command)
      VALUES ('run-1', 'running', 'cap-1', 'claude', 'npm test')
    `).run();
    db.prepare(`
      INSERT INTO run_state (run_id, working_dir, original_command, last_sequence, stdin_buffer, environment)
      VALUES ('run-1', ?, 'npm test', 7, 'abc', ?)
    `).run(process.cwd(), JSON.stringify({ NODE_ENV: 'test' }));

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

  it('accepts MCP provider worker types for UI-created runs', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'user-1', ?)`).run(Math.floor(Date.now() / 1000) + 3600);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: adminSessionHeaders('session-1'),
      payload: {
        label: 'OpenCode run',
        workerType: 'opencode',
      },
    });

    expect(createRes.statusCode).toBe(200);
    const runId = (createRes.json() as { id: string }).id;
    const saved = db.prepare('SELECT worker_type FROM runs WHERE id = ?').get(runId) as { worker_type: string };
    expect(saved.worker_type).toBe('opencode');
  });

  it('auto-attaches to active MCP session and starts run immediately', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'user-1', ?)`).run(Math.floor(Date.now() / 1000) + 3600);

    const now = Math.floor(Date.now() / 1000);
    registerMcpSession({
      id: 'mcp-session-1',
      transport: {} as any,
      authContext: {
        tokenId: 'tok-1',
        tokenLabel: 'auto:codex',
        user: {
          id: 'user-1',
          username: 'alice',
          role: 'admin',
          source: 'mcp_token',
        },
        scopes: ['runs:read', 'runs:write'],
      },
      createdAt: now,
      lastSeenAt: now,
    });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: adminSessionHeaders('session-1'),
      payload: {
        label: 'Codex attached run',
        workerType: 'codex',
        metadata: {
          mcpSessionId: 'mcp-session-1',
        },
      },
    });

    expect(createRes.statusCode).toBe(200);
    expect(createRes.json()).toMatchObject({
      status: 'running',
      attachedMcpSessionId: 'mcp-session-1',
    });

    const runId = (createRes.json() as { id: string }).id;
    const saved = db.prepare('SELECT status, claimed_by, started_at FROM runs WHERE id = ?').get(runId) as {
      status: string;
      claimed_by: string | null;
      started_at: number | null;
    };

    expect(saved.status).toBe('running');
    expect(saved.claimed_by).toBe('mcp:mcp-session-1');
    expect(saved.started_at).toBeTypeOf('number');
  });

  it('does not auto-attach MCP session when mcpMode=agent and stores runner identity for compatibility', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'user-1', ?)`).run(Math.floor(Date.now() / 1000) + 3600);

    const now = Math.floor(Date.now() / 1000);
    registerMcpSession({
      id: 'mcp-session-agent-compat',
      transport: {} as any,
      authContext: {
        tokenId: 'tok-compat',
        tokenLabel: 'auto:codex',
        user: { id: 'user-1', username: 'alice', role: 'admin', source: 'mcp_token' },
        scopes: ['runs:read', 'runs:write'],
      },
      createdAt: now,
      lastSeenAt: now,
    });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: adminSessionHeaders('session-1'),
      payload: {
        label: 'Agent compatibility run',
        workerType: 'codex',
        metadata: {
          mcpMode: 'agent',
          mcpSessionId: 'mcp-session-agent-compat',
        },
      },
    });

    expect(createRes.statusCode).toBe(200);
    expect(createRes.json()).toMatchObject({
      status: 'pending',
      attachedMcpSessionId: null,
    });

    const runId = (createRes.json() as { id: string }).id;
    const saved = db.prepare('SELECT status, claimed_by, metadata FROM runs WHERE id = ?').get(runId) as {
      status: string;
      claimed_by: string | null;
      metadata: string | null;
    };
    expect(saved.status).toBe('pending');
    expect(saved.claimed_by).toBe(null);
    const metadata = saved.metadata ? JSON.parse(saved.metadata) : {};
    expect(metadata.mcpRunnerId).toBe('mcp-session-agent-compat');
    expect(metadata.mcpSessionId).toBeUndefined();
  });

  it('allows an MCP session to claim a pending run for its provider', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'user-1', ?)`).run(Math.floor(Date.now() / 1000) + 3600);

    const token = 'mcp-token-claim';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    db.prepare(`
      INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes)
      VALUES ('mcp-tok-1', ?, 'auto:codex', 'user-1', '["runs:read","runs:write","sessions:write"]')
    `).run(tokenHash);

    const now = Math.floor(Date.now() / 1000);
    registerMcpSession({
      id: 'mcp-session-claim',
      transport: {} as any,
      authContext: {
        tokenId: 'mcp-tok-1',
        tokenLabel: 'auto:codex',
        user: { id: 'user-1', username: 'alice', role: 'admin', source: 'mcp_token' },
        scopes: ['runs:read', 'runs:write', 'sessions:write'],
      },
      createdAt: now,
      lastSeenAt: now,
    });

    db.prepare(`
      INSERT INTO runs (id, status, worker_type, capability_token, waiting_approval, created_at)
      VALUES ('run-mcp-1', 'pending', 'codex', 'cap-mcp-1', 0, unixepoch())
    `).run();

    const claimRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/runs/claim',
      headers: {
        authorization: `Bearer ${token}`,
        'mcp-session-id': 'mcp-session-claim',
        'content-type': 'application/json',
      },
      payload: { provider: 'codex' },
    });

    expect(claimRes.statusCode).toBe(200);
    expect(claimRes.json()).toMatchObject({
      run: {
        id: 'run-mcp-1',
        workerType: 'codex',
      },
    });

    const saved = db.prepare('SELECT status, claimed_by FROM runs WHERE id = ?').get('run-mcp-1') as {
      status: string;
      claimed_by: string | null;
    };
    expect(saved.status).toBe('running');
    expect(saved.claimed_by).toBe('mcp:mcp-session-claim');
  });

  it('lets MCP session poll and ack pending commands for its claimed run', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();

    const token = 'mcp-token-commands';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    db.prepare(`
      INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes)
      VALUES ('mcp-tok-2', ?, 'auto:codex', 'user-1', '["runs:read","sessions:write"]')
    `).run(tokenHash);

    const now = Math.floor(Date.now() / 1000);
    registerMcpSession({
      id: 'mcp-session-cmd',
      transport: {} as any,
      authContext: {
        tokenId: 'mcp-tok-2',
        tokenLabel: 'auto:codex',
        user: { id: 'user-1', username: 'alice', role: 'admin', source: 'mcp_token' },
        scopes: ['runs:read', 'sessions:write'],
      },
      createdAt: now,
      lastSeenAt: now,
    });

    db.prepare(`
      INSERT INTO runs (id, status, worker_type, capability_token, claimed_by, claimed_at, started_at)
      VALUES ('run-mcp-2', 'running', 'codex', 'cap-mcp-2', 'mcp:mcp-session-cmd', unixepoch(), unixepoch())
    `).run();
    db.prepare(`
      INSERT INTO commands (id, run_id, command, arguments, status, created_at)
      VALUES ('cmd-mcp-1', 'run-mcp-2', '__INPUT__', 'hello', 'pending', unixepoch())
    `).run();

    const pollRes = await app.inject({
      method: 'GET',
      url: '/api/mcp/runs/run-mcp-2/commands',
      headers: {
        authorization: `Bearer ${token}`,
        'mcp-session-id': 'mcp-session-cmd',
      },
    });

    expect(pollRes.statusCode).toBe(200);
    const commands = pollRes.json() as Array<{ id: string; command: string; arguments?: string }>;
    expect(commands.some((entry) => entry.id === 'cmd-mcp-1' && entry.command === '__INPUT__')).toBe(true);

    const ackRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/runs/run-mcp-2/commands/cmd-mcp-1/ack',
      headers: {
        authorization: `Bearer ${token}`,
        'mcp-session-id': 'mcp-session-cmd',
        'content-type': 'application/json',
      },
      payload: { result: 'ok', error: null },
    });

    expect(ackRes.statusCode).toBe(200);
    const saved = db.prepare('SELECT status, result, error FROM commands WHERE id = ?').get('cmd-mcp-1') as {
      status: string;
      result: string | null;
      error: string | null;
    };
    expect(saved.status).toBe('completed');
    expect(saved.result).toBe('ok');
    expect(saved.error).toBe(null);
  });

  it('delivers VNC control commands through MCP command polling', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();

    const token = 'mcp-token-vnc';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    db.prepare(`
      INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes)
      VALUES ('mcp-tok-3', ?, 'auto:codex', 'user-1', '["runs:read","sessions:write","vnc:control"]')
    `).run(tokenHash);

    const now = Math.floor(Date.now() / 1000);
    registerMcpSession({
      id: 'mcp-session-vnc',
      transport: {} as any,
      authContext: {
        tokenId: 'mcp-tok-3',
        tokenLabel: 'auto:codex',
        user: { id: 'user-1', username: 'alice', role: 'admin', source: 'mcp_token' },
        scopes: ['runs:read', 'sessions:write', 'vnc:control'],
      },
      createdAt: now,
      lastSeenAt: now,
    });

    db.prepare(`
      INSERT INTO runs (id, status, worker_type, capability_token, claimed_by, claimed_at, started_at)
      VALUES ('run-vnc-1', 'running', 'vnc', 'cap-vnc-1', 'mcp:mcp-session-vnc', unixepoch(), unixepoch())
    `).run();
    db.prepare(`
      INSERT INTO commands (id, run_id, command, arguments, status, created_at)
      VALUES ('cmd-vnc-1', 'run-vnc-1', '__START_VNC_STREAM__', '{"source":"ui"}', 'pending', unixepoch())
    `).run();

    const pollRes = await app.inject({
      method: 'GET',
      url: '/api/mcp/runs/run-vnc-1/commands',
      headers: {
        authorization: `Bearer ${token}`,
        'mcp-session-id': 'mcp-session-vnc',
      },
    });

    expect(pollRes.statusCode).toBe(200);
    const commands = pollRes.json() as Array<{ id: string; command: string; arguments?: string }>;
    expect(commands.some((entry) => entry.id === 'cmd-vnc-1' && entry.command === '__START_VNC_STREAM__')).toBe(true);
  });

  it('queues UI input for MCP-claimed run as __INPUT__ with arguments', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'user-1', ?)`).run(Math.floor(Date.now() / 1000) + 3600);

    const token = 'mcp-token-input';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    db.prepare(`
      INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes)
      VALUES ('mcp-tok-4', ?, 'auto:codex', 'user-1', '["runs:read","sessions:write"]')
    `).run(tokenHash);

    const now = Math.floor(Date.now() / 1000);
    registerMcpSession({
      id: 'mcp-session-input',
      transport: {} as any,
      authContext: {
        tokenId: 'mcp-tok-4',
        tokenLabel: 'auto:codex',
        user: { id: 'user-1', username: 'alice', role: 'admin', source: 'mcp_token' },
        scopes: ['runs:read', 'sessions:write'],
      },
      createdAt: now,
      lastSeenAt: now,
    });

    db.prepare(`
      INSERT INTO runs (id, status, worker_type, capability_token, claimed_by, claimed_at, started_at)
      VALUES ('run-mcp-input', 'running', 'codex', 'cap-mcp-input', 'mcp:mcp-session-input', unixepoch(), unixepoch())
    `).run();

    const inputRes = await app.inject({
      method: 'POST',
      url: '/api/runs/run-mcp-input/input',
      headers: adminSessionHeaders('session-1'),
      payload: { input: 'hello from ui' },
    });
    expect(inputRes.statusCode).toBe(200);

    const pollRes = await app.inject({
      method: 'GET',
      url: '/api/mcp/runs/run-mcp-input/commands',
      headers: {
        authorization: `Bearer ${token}`,
        'mcp-session-id': 'mcp-session-input',
      },
    });
    expect(pollRes.statusCode).toBe(200);
    const commands = pollRes.json() as Array<{ command: string; arguments?: string }>;
    expect(commands.some((entry) => entry.command === '__INPUT__' && entry.arguments === 'hello from ui')).toBe(true);
  });

  it('exposes VNC start command through MCP poll when queued from VNC route', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();

    const token = 'mcp-token-vnc-route';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    db.prepare(`
      INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes)
      VALUES ('mcp-tok-5', ?, 'auto:codex', 'user-1', '["runs:read","sessions:write","vnc:control"]')
    `).run(tokenHash);

    const now = Math.floor(Date.now() / 1000);
    registerMcpSession({
      id: 'mcp-session-vnc-route',
      transport: {} as any,
      authContext: {
        tokenId: 'mcp-tok-5',
        tokenLabel: 'auto:codex',
        user: { id: 'user-1', username: 'alice', role: 'admin', source: 'mcp_token' },
        scopes: ['runs:read', 'sessions:write', 'vnc:control'],
      },
      createdAt: now,
      lastSeenAt: now,
    });

    db.prepare(`
      INSERT INTO runs (id, status, worker_type, capability_token, claimed_by, claimed_at, started_at)
      VALUES ('run-vnc-route-1', 'running', 'vnc', 'cap-vnc-route-1', 'mcp:mcp-session-vnc-route', unixepoch(), unixepoch())
    `).run();

    const startRes = await app.inject({
      method: 'POST',
      url: '/api/runs/run-vnc-route-1/vnc/start',
    });
    expect(startRes.statusCode).toBe(200);

    const pollRes = await app.inject({
      method: 'GET',
      url: '/api/mcp/runs/run-vnc-route-1/commands',
      headers: {
        authorization: `Bearer ${token}`,
        'mcp-session-id': 'mcp-session-vnc-route',
      },
    });
    expect(pollRes.statusCode).toBe(200);
    const commands = pollRes.json() as Array<{ command: string }>;
    expect(commands.some((entry) => entry.command === '__START_VNC_STREAM__')).toBe(true);
  });

  it('accepts MCP event ingestion for a claimed run and exposes events to UI', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'user-1', ?)`).run(Math.floor(Date.now() / 1000) + 3600);

    const token = 'mcp-token-events';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    db.prepare(`
      INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes)
      VALUES ('mcp-tok-6', ?, 'auto:codex', 'user-1', '["runs:write","sessions:write"]')
    `).run(tokenHash);

    const now = Math.floor(Date.now() / 1000);
    registerMcpSession({
      id: 'mcp-session-events',
      transport: {} as any,
      authContext: {
        tokenId: 'mcp-tok-6',
        tokenLabel: 'auto:codex',
        user: { id: 'user-1', username: 'alice', role: 'admin', source: 'mcp_token' },
        scopes: ['runs:write', 'sessions:write'],
      },
      createdAt: now,
      lastSeenAt: now,
    });

    db.prepare(`
      INSERT INTO runs (id, status, worker_type, capability_token, claimed_by, claimed_at, started_at)
      VALUES ('run-mcp-events', 'running', 'codex', 'cap-mcp-events', 'mcp:mcp-session-events', unixepoch(), unixepoch())
    `).run();

    const ingestRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/runs/run-mcp-events/events',
      headers: {
        authorization: `Bearer ${token}`,
        'mcp-session-id': 'mcp-session-events',
        'content-type': 'application/json',
      },
      payload: { type: 'stdout', data: 'hello from mcp', sequence: 1 },
    });

    expect(ingestRes.statusCode).toBe(200);

    const eventsRes = await app.inject({
      method: 'GET',
      url: '/api/runs/run-mcp-events/events',
      headers: adminSessionHeaders('session-1'),
    });
    expect(eventsRes.statusCode).toBe(200);
    const events = eventsRes.json() as Array<{ type: string; data: string }>;
    expect(events.some((entry) => entry.type === 'stdout' && entry.data === 'hello from mcp')).toBe(true);
  });

  it('updates run status from MCP marker finished event', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();

    const token = 'mcp-token-marker';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    db.prepare(`
      INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes)
      VALUES ('mcp-tok-7', ?, 'auto:codex', 'user-1', '["runs:write","sessions:write"]')
    `).run(tokenHash);

    const now = Math.floor(Date.now() / 1000);
    registerMcpSession({
      id: 'mcp-session-marker',
      transport: {} as any,
      authContext: {
        tokenId: 'mcp-tok-7',
        tokenLabel: 'auto:codex',
        user: { id: 'user-1', username: 'alice', role: 'admin', source: 'mcp_token' },
        scopes: ['runs:write', 'sessions:write'],
      },
      createdAt: now,
      lastSeenAt: now,
    });

    db.prepare(`
      INSERT INTO runs (id, status, worker_type, capability_token, claimed_by, claimed_at, started_at)
      VALUES ('run-mcp-marker', 'running', 'codex', 'cap-mcp-marker', 'mcp:mcp-session-marker', unixepoch(), unixepoch())
    `).run();

    const markerPayload = { event: 'finished', exitCode: 0 };
    const markerRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/runs/run-mcp-marker/events',
      headers: {
        authorization: `Bearer ${token}`,
        'mcp-session-id': 'mcp-session-marker',
        'content-type': 'application/json',
      },
      payload: { type: 'marker', data: JSON.stringify(markerPayload), sequence: 99 },
    });

    expect(markerRes.statusCode).toBe(200);
    const saved = db.prepare('SELECT status, exit_code, finished_at FROM runs WHERE id = ?').get('run-mcp-marker') as {
      status: string;
      exit_code: number | null;
      finished_at: number | null;
    };
    expect(saved.status).toBe('done');
    expect(saved.exit_code).toBe(0);
    expect(saved.finished_at).toBeTypeOf('number');
  });

  it('resolves MCP worker session by bearer token when mcp-session-id is omitted', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();

    const token = 'mcp-token-no-header';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    db.prepare(`
      INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes)
      VALUES ('mcp-tok-8', ?, 'auto:codex', 'user-1', '["runs:read","sessions:write"]')
    `).run(tokenHash);

    const now = Math.floor(Date.now() / 1000);
    registerMcpSession({
      id: 'mcp-session-no-header',
      transport: {} as any,
      authContext: {
        tokenId: 'mcp-tok-8',
        tokenLabel: 'auto:codex',
        user: { id: 'user-1', username: 'alice', role: 'admin', source: 'mcp_token' },
        scopes: ['runs:read', 'sessions:write'],
      },
      createdAt: now,
      lastSeenAt: now,
    });

    db.prepare(`
      INSERT INTO runs (id, status, worker_type, capability_token, claimed_by, claimed_at, started_at)
      VALUES ('run-mcp-no-header', 'running', 'codex', 'cap-mcp-no-header', 'mcp:mcp-session-no-header', unixepoch(), unixepoch())
    `).run();
    db.prepare(`
      INSERT INTO commands (id, run_id, command, arguments, status, created_at)
      VALUES ('cmd-mcp-no-header', 'run-mcp-no-header', '__INPUT__', 'no session header', 'pending', unixepoch())
    `).run();

    const pollRes = await app.inject({
      method: 'GET',
      url: '/api/mcp/runs/run-mcp-no-header/commands',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(pollRes.statusCode).toBe(200);
    const commands = pollRes.json() as Array<{ id: string; command: string; arguments?: string }>;
    expect(commands.some((entry) => entry.id === 'cmd-mcp-no-header' && entry.command === '__INPUT__')).toBe(true);
  });

  it('allows MCP claim without active session by falling back to token worker identity', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();

    const token = 'mcp-token-no-session-claim';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    db.prepare(`
      INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes)
      VALUES ('mcp-tok-9', ?, 'auto:codex', 'user-1', '["runs:read","runs:write","sessions:write"]')
    `).run(tokenHash);

    db.prepare(`
      INSERT INTO runs (id, status, worker_type, capability_token, waiting_approval, created_at)
      VALUES ('run-mcp-no-session-claim', 'pending', 'codex', 'cap-mcp-no-session-claim', 0, unixepoch())
    `).run();

    const claimRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/runs/claim',
      headers: {
        authorization: `Bearer ${token}`,
        'x-airc-runner-id': 'runner-a',
        'content-type': 'application/json',
      },
      payload: { provider: 'codex' },
    });

    expect(claimRes.statusCode).toBe(200);
    expect(claimRes.json()).toMatchObject({
      run: {
        id: 'run-mcp-no-session-claim',
        workerType: 'codex',
      },
    });

    const saved = db.prepare('SELECT status, claimed_by FROM runs WHERE id = ?').get('run-mcp-no-session-claim') as {
      status: string;
      claimed_by: string | null;
    };
    expect(saved.status).toBe('running');
    expect(saved.claimed_by).toBe('mcp-runner:mcp-tok-9:runner-a');
  });

  it('polls and acks commands for token-claimed MCP runs without active session', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();

    const token = 'mcp-token-no-session-cmd';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    db.prepare(`
      INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes)
      VALUES ('mcp-tok-10', ?, 'auto:codex', 'user-1', '["runs:read","sessions:write"]')
    `).run(tokenHash);

    db.prepare(`
      INSERT INTO runs (id, status, worker_type, capability_token, claimed_by, claimed_at, started_at)
      VALUES ('run-mcp-no-session-cmd', 'running', 'codex', 'cap-mcp-no-session-cmd', 'mcp-runner:mcp-tok-10:runner-b', unixepoch(), unixepoch())
    `).run();
    db.prepare(`
      INSERT INTO commands (id, run_id, command, arguments, status, created_at)
      VALUES ('cmd-mcp-no-session-cmd', 'run-mcp-no-session-cmd', '__INPUT__', 'hello token claim', 'pending', unixepoch())
    `).run();

    const pollRes = await app.inject({
      method: 'GET',
      url: '/api/mcp/runs/run-mcp-no-session-cmd/commands',
      headers: {
        authorization: `Bearer ${token}`,
        'x-airc-runner-id': 'runner-b',
      },
    });
    expect(pollRes.statusCode).toBe(200);
    const commands = pollRes.json() as Array<{ id: string; command: string }>;
    expect(commands.some((entry) => entry.id === 'cmd-mcp-no-session-cmd' && entry.command === '__INPUT__')).toBe(true);

    const ackRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/runs/run-mcp-no-session-cmd/commands/cmd-mcp-no-session-cmd/ack',
      headers: {
        authorization: `Bearer ${token}`,
        'x-airc-runner-id': 'runner-b',
        'content-type': 'application/json',
      },
      payload: { result: 'ok' },
    });
    expect(ackRes.statusCode).toBe(200);

    const saved = db.prepare('SELECT status, result FROM commands WHERE id = ?').get('cmd-mcp-no-session-cmd') as {
      status: string;
      result: string | null;
    };
    expect(saved.status).toBe('completed');
    expect(saved.result).toBe('ok');
  });

  it('claims only runs targeted to matching mcpRunnerId when provided', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();

    const token = 'mcp-token-target-runner';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    db.prepare(`
      INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes)
      VALUES ('mcp-tok-12', ?, 'auto:codex', 'user-1', '["runs:read","runs:write","sessions:write"]')
    `).run(tokenHash);

    db.prepare(`
      INSERT INTO runs (id, status, worker_type, capability_token, waiting_approval, metadata, created_at)
      VALUES ('run-mcp-target-a', 'pending', 'codex', 'cap-mcp-target-a', 0, '{"mcpRunnerId":"runner-a"}', unixepoch())
    `).run();
    db.prepare(`
      INSERT INTO runs (id, status, worker_type, capability_token, waiting_approval, metadata, created_at)
      VALUES ('run-mcp-target-b', 'pending', 'codex', 'cap-mcp-target-b', 0, '{"mcpRunnerId":"runner-b"}', unixepoch()+1)
    `).run();

    const claimRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/runs/claim',
      headers: {
        authorization: `Bearer ${token}`,
        'x-airc-runner-id': 'runner-b',
        'content-type': 'application/json',
      },
      payload: { provider: 'codex' },
    });

    expect(claimRes.statusCode).toBe(200);
    expect(claimRes.json()).toMatchObject({
      run: { id: 'run-mcp-target-b' },
    });
  });

  it('prefers explicit runner identity over active MCP session for runner-targeted claims', async () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'alice', 'hash', 'admin')`).run();

    const token = 'mcp-token-runner-over-session';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    db.prepare(`
      INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes)
      VALUES ('mcp-tok-13', ?, 'auto:codex', 'user-1', '["runs:read","runs:write","sessions:write"]')
    `).run(tokenHash);

    const now = Math.floor(Date.now() / 1000);
    registerMcpSession({
      id: 'mcp-session-live-codex',
      transport: {} as any,
      authContext: {
        tokenId: 'mcp-tok-13',
        tokenLabel: 'auto:codex',
        user: { id: 'user-1', username: 'alice', role: 'admin', source: 'mcp_token' },
        scopes: ['runs:read', 'runs:write', 'sessions:write'],
      },
      createdAt: now,
      lastSeenAt: now,
    });

    db.prepare(`
      INSERT INTO runs (id, status, worker_type, capability_token, waiting_approval, metadata, created_at)
      VALUES ('run-mcp-runner-over-session', 'pending', 'codex', 'cap-mcp-runner-over-session', 0, '{"mcpRunnerId":"runner-z"}', unixepoch())
    `).run();

    const claimRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/runs/claim',
      headers: {
        authorization: `Bearer ${token}`,
        'x-airc-runner-id': 'runner-z',
        'content-type': 'application/json',
      },
      payload: { provider: 'codex' },
    });

    expect(claimRes.statusCode).toBe(200);
    expect(claimRes.json()).toMatchObject({
      run: { id: 'run-mcp-runner-over-session' },
    });

    const saved = db.prepare('SELECT claimed_by, status FROM runs WHERE id = ?').get('run-mcp-runner-over-session') as {
      claimed_by: string | null;
      status: string;
    };
    expect(saved.claimed_by).toBe('mcp-runner:mcp-tok-13:runner-z');
    expect(saved.status).toBe('running');
  });

});
