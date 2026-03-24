/**
 * MCP server tool handler unit tests.
 *
 * Tests the logic inside each tool handler without needing a real MCP transport.
 * The McpServer is exercised by calling tool handlers directly via a minimal
 * McpServer instance that we initialize and call through a test client transport.
 *
 * Pattern: create an McpAuthContext, call the tool handler, assert the returned
 * MCP content block.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMcpServer } from './server.js';
import type { McpAuthContext } from './auth.js';
import { ALL_MCP_SCOPES } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Mock the database and dependencies
// ---------------------------------------------------------------------------

vi.mock('../services/database.js', () => {
  const rows = {
    runs: [] as any[],
    events: [] as any[],
    artifacts: [] as any[],
    approval_requests: [] as any[],
    run_state: [] as any[],
  };

  const prepare = (sql: string) => ({
    all: (..._args: any[]) => {
      if (sql.includes('FROM runs')) return rows.runs;
      if (sql.includes('FROM events')) return rows.events;
      if (sql.includes('FROM artifacts')) return rows.artifacts;
      if (sql.includes('FROM approval_requests')) return rows.approval_requests;
      if (sql.includes('COUNT(*)')) return [{ c: 1 }];
      return [];
    },
    get: (..._args: any[]) => {
      if (sql.includes('FROM runs WHERE id')) return rows.runs[0] ?? undefined;
      if (sql.includes('FROM run_state')) return rows.run_state[0] ?? undefined;
      if (sql.includes('FROM artifacts WHERE id')) return rows.artifacts[0] ?? undefined;
      if (sql.includes('FROM approval_requests WHERE id')) return rows.approval_requests[0] ?? undefined;
      if (sql.includes('COUNT(*)')) return { c: 0 };
      return undefined;
    },
    run: vi.fn(),
  });

  return {
    db: {
      prepare,
      pragma: vi.fn(),
      exec: vi.fn(),
      close: vi.fn(),
      transaction: (fn: any) => (...args: any[]) => fn(...args),
    },
  };
});

vi.mock('../services/websocket.js', () => ({ broadcastToRun: vi.fn() }));
vi.mock('../utils/crypto.js', () => ({
  generateCapabilityToken: () => 'test-cap-token-xxxx',
}));
vi.mock('../config.js', () => ({
  config: {
    mcpEnabled: true,
    mcpPath: '/mcp',
    allowlistedCommands: ['git diff', 'npm test'],
    approvalTimeoutSeconds: 300,
    maxArtifactSize: 52428800,
    providers: {
      claude: true, codex: true, gemini: true, opencode: true, rev: true, legacyWrapper: false,
    },
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminCtx(): McpAuthContext {
  return {
    tokenId: 'tok-1',
    user: { id: 'user-1', username: 'admin', role: 'admin', source: 'mcp_token' },
    scopes: ALL_MCP_SCOPES,
  };
}

function viewerCtx(): McpAuthContext {
  return {
    tokenId: 'tok-2',
    user: { id: 'user-2', username: 'viewer', role: 'viewer', source: 'mcp_token' },
    scopes: ['runs:read', 'events:read', 'artifacts:read'],
  };
}

/**
 * Invoke a tool by name on the McpServer using the low-level callTool method.
 * We build a minimal in-memory test transport to avoid needing HTTP.
 */
async function callTool(
  toolName: string,
  args: Record<string, unknown>,
  authCtx: McpAuthContext | null
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const server = createMcpServer(() => authCtx);

  // _registeredTools is a plain object in SDK v1.27+: { [name]: { handler, ... } }
  const tools = (server as any)._registeredTools as Record<string, { handler: Function }>;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool not registered: ${toolName}`);

  return tool.handler(args, { sendNotification: vi.fn(), sendRequest: vi.fn() });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP tool: healthcheck', () => {
  it('returns ok without auth', async () => {
    const result = await callTool('healthcheck', {}, null);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('ok');
    expect(data.gateway).toBe('airemotecoder');
  });
});

describe('MCP tool: heartbeat', () => {
  it('returns current timestamp', async () => {
    const result = await callTool('heartbeat', {}, null);
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.ts).toBe('number');
    expect(typeof data.iso).toBe('string');
  });
});

describe('MCP tool: list_runs', () => {
  it('rejects unauthenticated calls', async () => {
    const result = await callTool('list_runs', { limit: 10, offset: 0 }, null);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Authentication required/);
  });

  it('rejects insufficient scope', async () => {
    const ctx: McpAuthContext = { ...viewerCtx(), scopes: [] };
    const result = await callTool('list_runs', { limit: 10, offset: 0 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Insufficient scope/);
  });

  it('returns run list for authenticated caller', async () => {
    const result = await callTool('list_runs', { limit: 10, offset: 0 }, adminCtx());
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.runs)).toBe(true);
  });
});

describe('MCP tool: get_run', () => {
  it('returns not-found for missing run', async () => {
    const result = await callTool('get_run', { run_id: 'nonexistent', include_events: false }, adminCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
  });
});

describe('MCP tool: create_run', () => {
  it('rejects caller without runs:write scope', async () => {
    const ctx = viewerCtx(); // has runs:read but not runs:write
    const result = await callTool('create_run', { worker_type: 'claude' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Insufficient scope/);
  });

  it('creates run and returns run_id for authorized caller', async () => {
    const result = await callTool('create_run', { worker_type: 'claude', label: 'Test run' }, adminCtx());
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.run_id).toBe('string');
    expect(data.status).toBe('pending');
    expect(typeof data.capability_token).toBe('string');
  });
});

describe('MCP tool: cancel_run', () => {
  it('rejects without runs:cancel scope', async () => {
    const ctx: McpAuthContext = { ...adminCtx(), scopes: ['runs:read'] };
    const result = await callTool('cancel_run', { run_id: 'abc' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Insufficient scope/);
  });
});

describe('MCP tool: tail_logs', () => {
  it('rejects without events:read scope', async () => {
    const ctx: McpAuthContext = { ...adminCtx(), scopes: ['runs:read'] };
    const result = await callTool('tail_logs', { run_id: 'abc', limit: 10 }, ctx);
    expect(result.isError).toBe(true);
  });

  it('returns not-found for unknown run', async () => {
    const result = await callTool('tail_logs', { run_id: 'nonexistent', limit: 10 }, adminCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
  });
});

describe('MCP tool: get_agent_capabilities', () => {
  it('returns capability matrix', async () => {
    const result = await callTool('get_agent_capabilities', {}, adminCtx());
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.capabilities).toBeDefined();
    expect(data.enabledProviders).toContain('claude');
  });

  it('legacy_wrapper is absent when disabled', async () => {
    const result = await callTool('get_agent_capabilities', {}, adminCtx());
    const data = JSON.parse(result.content[0].text);
    // config mock has legacyWrapper: false
    expect(data.capabilities.legacy_wrapper).toBeUndefined();
  });
});

describe('MCP tool: get_policy_snapshot', () => {
  it('returns policy for authorized caller', async () => {
    const result = await callTool('get_policy_snapshot', {}, adminCtx());
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.allowlistedCommands)).toBe(true);
    expect(typeof data.approvalTimeoutSeconds).toBe('number');
  });
});

describe('MCP tool: create_approval_request', () => {
  it('rejects without approvals:write scope', async () => {
    const ctx: McpAuthContext = { ...adminCtx(), scopes: ['runs:read'] };
    const result = await callTool('create_approval_request', {
      run_id: 'abc',
      description: 'delete all files?',
      action: { type: 'delete', path: '/' },
    }, ctx);
    expect(result.isError).toBe(true);
  });
});

describe('MCP tool: approve_action / deny_action', () => {
  it('rejects approve without approvals:decide scope', async () => {
    const ctx: McpAuthContext = { ...adminCtx(), scopes: ['approvals:read'] };
    const result = await callTool('approve_action', { approval_request_id: 'apr-1' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Insufficient scope/);
  });

  it('rejects deny without approvals:decide scope', async () => {
    const ctx: McpAuthContext = { ...adminCtx(), scopes: ['approvals:read'] };
    const result = await callTool('deny_action', { approval_request_id: 'apr-1' }, ctx);
    expect(result.isError).toBe(true);
  });
});
