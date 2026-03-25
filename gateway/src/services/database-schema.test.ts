import { describe, it, expect, vi } from 'vitest';
import { dirname, join } from 'path';

const { testDbPath } = vi.hoisted(() => ({
  testDbPath: process.cwd() + '\\.vitest-data\\database-schema-' + Math.random().toString(36).slice(2) + '.db',
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

describe('services/database schema', () => {
  it('initializes an MCP-only schema without clients table or runs.client_id', async () => {
    const mod = await import('./database.js');
    const tables = mod.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all() as Array<{ name: string }>;
    const runColumns = mod.db.prepare(`PRAGMA table_info(runs)`).all() as Array<{ name: string }>;

    expect(tables.some((entry) => entry.name === 'clients')).toBe(false);
    expect(runColumns.some((entry) => entry.name === 'client_id')).toBe(false);
  });
});
