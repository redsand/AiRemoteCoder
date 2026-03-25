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

const { mockRows, mockVncState } = vi.hoisted(() => ({
  mockRows: {
    runs: [] as any[],
    events: [] as any[],
    artifacts: [] as any[],
    approval_requests: [] as any[],
    run_state: [] as any[],
    commands: [] as any[],
  },
  mockVncState: {
    tunnelByRunId: new Map<string, any>(),
    closeTunnel: vi.fn(),
  },
}));

vi.mock('../services/database.js', () => {
  const prepare = (sql: string) => ({
    all: (...args: any[]) => {
      if (sql.includes('FROM runs')) return mockRows.runs;
      if (sql.includes('FROM events')) return mockRows.events;
      if (sql.includes('FROM artifacts') && sql.includes('WHERE run_id = ?')) {
        return mockRows.artifacts.filter((a) => a.run_id === args[0]);
      }
      if (sql.includes('FROM artifacts')) return mockRows.artifacts;
      if (sql.includes('FROM approval_requests')) return mockRows.approval_requests;
      if (sql.includes('COUNT(*)')) return [{ c: 1 }];
      return [];
    },
    get: (...args: any[]) => {
      if (sql.includes("FROM runs WHERE id = ? AND status = 'running'")) {
        const run = mockRows.runs.find((r) => r.id === args[0]);
        return run?.status === 'running' ? run : undefined;
      }
      if (sql.includes('FROM runs WHERE id = ?')) return mockRows.runs.find((r) => r.id === args[0]);
      if (sql.includes('FROM run_state')) return mockRows.run_state.find((r) => r.run_id === args[0]);
      if (sql.includes('FROM artifacts WHERE id')) return mockRows.artifacts.find((a) => a.id === args[0]);
      if (sql.includes('FROM approval_requests WHERE id')) return mockRows.approval_requests.find((r) => r.id === args[0]);
      if (sql.includes('COUNT(*)')) return { c: 0 };
      return undefined;
    },
    run: vi.fn((...args: any[]) => {
      if (sql.includes('INSERT INTO commands')) {
        const commandMatch = /VALUES\s*\(\?,\s*\?,\s*'([^']+)'/i.exec(sql);
        mockRows.commands.push({
          id: args[0],
          run_id: args[1],
          command: commandMatch ? commandMatch[1] : args[2],
          arguments: commandMatch ? (args[2] ?? null) : (args[3] ?? null),
        });
      }
    }),
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
vi.mock('../services/vnc-tunnel.js', () => ({
  vncTunnelManager: {
    getTunnel: vi.fn((runId: string) => mockVncState.tunnelByRunId.get(runId)),
    getTunnelStats: vi.fn((runId: string) => mockVncState.tunnelByRunId.get(runId) ?? null),
    createTunnel: vi.fn((runId: string) => {
      const tunnel = { runId, status: 'pending', clientConnected: false, viewerConnected: false };
      mockVncState.tunnelByRunId.set(runId, tunnel);
      return tunnel;
    }),
    closeTunnel: mockVncState.closeTunnel,
    getActiveTunnelCount: vi.fn(() => mockVncState.tunnelByRunId.size),
    getPendingTunnelCount: vi.fn(() => 0),
    getAllTunnelStats: vi.fn(() => Array.from(mockVncState.tunnelByRunId.values())),
  },
}));
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
      claude: true, codex: true, gemini: true, opencode: true, zenflow: true, rev: true,
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
  beforeEach(() => {
    mockRows.runs.length = 0;
    mockRows.events.length = 0;
    mockRows.artifacts.length = 0;
    mockRows.approval_requests.length = 0;
    mockRows.run_state.length = 0;
    mockRows.commands.length = 0;
    mockVncState.tunnelByRunId.clear();
    mockVncState.closeTunnel.mockReset();
  });

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

  it('returns only supported MCP providers', async () => {
    const result = await callTool('get_agent_capabilities', {}, adminCtx());
    const data = JSON.parse(result.content[0].text);
    expect(data.capabilities.unsupported_provider).toBeUndefined();
    expect(data.enabledProviders).toContain('zenflow');
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

describe('MCP tool: get_vnc_status', () => {
  beforeEach(() => {
    mockRows.runs.length = 0;
    mockRows.runs.push({ id: 'run-vnc', status: 'running', worker_type: 'vnc' });
    mockRows.runs.push({ id: 'run-codex', status: 'running', worker_type: 'codex' });
  });

  it('returns auth error when unauthenticated', async () => {
    const result = await callTool('get_vnc_status', { run_id: 'run-vnc' }, null);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Authentication required/);
  });

  it('returns scope error when token lacks vnc:read', async () => {
    const ctx: McpAuthContext = { ...adminCtx(), scopes: ['runs:read'] };
    const result = await callTool('get_vnc_status', { run_id: 'run-vnc' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Insufficient scope/);
  });

  it('returns not-found when run does not exist', async () => {
    const result = await callTool('get_vnc_status', { run_id: 'missing' }, adminCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
  });

  it('returns invalid-request when run is not a vnc worker', async () => {
    const result = await callTool('get_vnc_status', { run_id: 'run-codex' }, adminCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not a VNC worker/);
  });

  it('returns vnc connection status for a vnc run', async () => {
    mockVncState.tunnelByRunId.set('run-vnc', {
      runId: 'run-vnc',
      status: 'active',
      clientConnected: true,
      viewerConnected: true,
    });

    const result = await callTool('get_vnc_status', { run_id: 'run-vnc' }, adminCtx());
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.run_id).toBe('run-vnc');
    expect(data.available).toBe(true);
    expect(data.ws_url).toBe('/ws/vnc/run-vnc');
  });
});

describe('MCP tool: start_vnc_stream', () => {
  beforeEach(() => {
    mockRows.runs.length = 0;
    mockRows.commands.length = 0;
    mockRows.runs.push({ id: 'run-vnc', status: 'running', worker_type: 'vnc' });
    mockRows.runs.push({ id: 'run-codex', status: 'running', worker_type: 'codex' });
  });

  it('returns scope error when token lacks vnc:control', async () => {
    const ctx: McpAuthContext = { ...adminCtx(), scopes: ['sessions:write'] };
    const result = await callTool('start_vnc_stream', { run_id: 'run-vnc' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Insufficient scope/);
  });

  it('returns not-found when run does not exist', async () => {
    const result = await callTool('start_vnc_stream', { run_id: 'missing' }, adminCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
  });

  it('returns invalid-request when run is not a vnc worker', async () => {
    const result = await callTool('start_vnc_stream', { run_id: 'run-codex' }, adminCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not a VNC worker/);
  });

  it('queues start command and returns websocket url', async () => {
    const result = await callTool('start_vnc_stream', { run_id: 'run-vnc' }, adminCtx());
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.command).toBe('__START_VNC_STREAM__');
    expect(data.ws_url).toBe('/ws/vnc/run-vnc');
    expect(mockRows.commands.some((c) => c.run_id === 'run-vnc' && c.command === '__START_VNC_STREAM__')).toBe(true);
  });
});

describe('MCP tool: stop_vnc_stream', () => {
  beforeEach(() => {
    mockRows.runs.length = 0;
    mockRows.runs.push({ id: 'run-vnc', status: 'running', worker_type: 'vnc' });
    mockRows.runs.push({ id: 'run-codex', status: 'running', worker_type: 'codex' });
    mockVncState.closeTunnel.mockReset();
  });

  it('returns scope error when token lacks vnc:control', async () => {
    const ctx: McpAuthContext = { ...adminCtx(), scopes: ['sessions:write'] };
    const result = await callTool('stop_vnc_stream', { run_id: 'run-vnc' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Insufficient scope/);
  });

  it('closes tunnel for valid run', async () => {
    const result = await callTool('stop_vnc_stream', { run_id: 'run-vnc' }, adminCtx());
    expect(result.isError).toBeUndefined();
    expect(mockVncState.closeTunnel).toHaveBeenCalledWith('run-vnc');
  });

  it('returns invalid-request when run is not a vnc worker', async () => {
    const result = await callTool('stop_vnc_stream', { run_id: 'run-codex' }, adminCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not a VNC worker/);
  });
});

describe('MCP tool: get_vnc_tunnel_stats', () => {
  beforeEach(() => {
    mockVncState.tunnelByRunId.clear();
    mockVncState.tunnelByRunId.set('run-vnc', { runId: 'run-vnc', status: 'active' });
  });

  it('returns scope error for non-admin caller', async () => {
    const ctx: McpAuthContext = { ...adminCtx(), scopes: ['runs:read'] };
    const result = await callTool('get_vnc_tunnel_stats', {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Insufficient scope/);
  });

  it('returns aggregate tunnel stats for admin caller', async () => {
    const result = await callTool('get_vnc_tunnel_stats', {}, adminCtx());
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.active_tunnels).toBe(1);
    expect(Array.isArray(data.tunnels)).toBe(true);
  });
});
