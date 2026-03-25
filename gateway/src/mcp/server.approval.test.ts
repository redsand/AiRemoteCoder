/**
 * MCP approval flow tests — full lifecycle.
 *
 * Tests the approval request → status check → resolve (approve/deny) cycle
 * and verifies state transitions in the mocked DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMcpServer } from './server.js';
import type { McpAuthContext } from './auth.js';
import { ALL_MCP_SCOPES } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockApprovalRequests = new Map<string, any>();
const mockRuns = new Map<string, any>();
const mockCommands: any[] = [];

vi.mock('../services/database.js', () => {
  const prepare = (sql: string) => ({
    all: (..._args: any[]) => {
      if (sql.includes('FROM runs')) return [...mockRuns.values()];
      if (sql.includes('FROM approval_requests')) return [...mockApprovalRequests.values()];
      if (sql.includes('COUNT(*)')) return [{ c: 0 }];
      return [];
    },
    get: (...args: any[]) => {
      if (sql.includes('FROM approval_requests WHERE id')) return mockApprovalRequests.get(args[0]);
      if (sql.includes("FROM runs WHERE id = ? AND status = 'running'")) {
        const run = mockRuns.get(args[0]);
        return run?.status === 'running' ? run : undefined;
      }
      if (sql.includes('FROM runs WHERE id')) return mockRuns.get(args[0]);
      if (sql.includes('COUNT(*)')) {
        // Count pending approvals for a run
        const runId = args[0];
        const count = [...mockApprovalRequests.values()].filter(
          (r) => r.run_id === runId && r.status === 'pending'
        ).length;
        return { c: count };
      }
      return undefined;
    },
    run: vi.fn((...args: any[]) => {
      // INSERT approval_request
      if (sql.includes('INSERT INTO approval_requests')) {
        const [id, runId, desc, action, , , timeout, corrId] = args;
        mockApprovalRequests.set(id, { id, run_id: runId, description: desc, action, status: 'pending', timeout_seconds: timeout, provider_correlation_id: corrId });
      }
      // UPDATE approval status — args: (status, resolved_at (via unixepoch inline), resolved_by, resolution, id)
      // SQL: UPDATE approval_requests SET status = ?, resolved_at = unixepoch(), resolved_by = ?, resolution = ? WHERE id = ?
      // Params: [decision, resolvedBy, resolution, requestId]
      if (sql.includes('UPDATE approval_requests') && sql.includes('SET status')) {
        const [status, resolvedBy, resolution, id] = args;
        const req = mockApprovalRequests.get(id);
        if (req) { req.status = status; req.resolved_by = resolvedBy; req.resolution = resolution; }
      }
      // UPDATE runs waiting_approval
      if (sql.includes('UPDATE runs SET waiting_approval = 0')) {
        // No-op in test, runs mock handles this
      }
      if (sql.includes("UPDATE runs SET waiting_approval = 1")) {
        const [id] = args;
        const run = mockRuns.get(id);
        if (run) { run.waiting_approval = 1; run.status = 'waiting_approval'; }
      }
      // INSERT command
      if (sql.includes('INSERT INTO commands')) {
        mockCommands.push({ args });
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
vi.mock('../utils/crypto.js', () => ({ generateCapabilityToken: () => 'cap-tok' }));
vi.mock('../config.js', () => ({
  config: {
    mcpEnabled: true,
    mcpPath: '/mcp',
    allowlistedCommands: [],
    approvalTimeoutSeconds: 300,
    maxArtifactSize: 52428800,
    providers: { claude: true, codex: true, gemini: true, opencode: true, zenflow: true, rev: true },
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

async function callTool(name: string, args: Record<string, unknown>, ctx: McpAuthContext | null) {
  const server = createMcpServer(() => ctx);
  const tools = (server as any)._registeredTools as Record<string, { handler: Function }>;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.handler(args, { sendNotification: vi.fn(), sendRequest: vi.fn() });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Approval lifecycle', () => {
  beforeEach(() => {
    mockApprovalRequests.clear();
    mockRuns.clear();
    mockCommands.length = 0;

    mockRuns.set('run-1', { id: 'run-1', status: 'running', waiting_approval: 0 });
  });

  it('full happy-path: create → status pending → approve → status approved', async () => {
    // 1. Create approval request
    const createResult = await callTool('create_approval_request', {
      run_id: 'run-1',
      description: 'About to drop the database',
      action: { type: 'sql', query: 'DROP DATABASE prod' },
      timeout_seconds: 300,
    }, adminCtx());

    expect(createResult.isError).toBeUndefined();
    const created = JSON.parse(createResult.content[0].text);
    expect(created.status).toBe('pending');
    const requestId: string = created.approval_request_id;
    expect(typeof requestId).toBe('string');

    // 2. Check status → pending
    const statusResult = await callTool('request_approval_status', { approval_request_id: requestId }, adminCtx());
    expect(statusResult.isError).toBeUndefined();
    const status = JSON.parse(statusResult.content[0].text);
    expect(status.status).toBe('pending');

    // 3. Approve
    const approveResult = await callTool('approve_action', {
      approval_request_id: requestId,
      resolution: 'confirmed by admin',
    }, adminCtx());

    expect(approveResult.isError).toBeUndefined();
    const decision = JSON.parse(approveResult.content[0].text);
    expect(decision.decision).toBe('approved');

    // 4. Check status → approved
    const statusAfter = await callTool('request_approval_status', { approval_request_id: requestId }, adminCtx());
    const statusAfterData = JSON.parse(statusAfter.content[0].text);
    expect(statusAfterData.status).toBe('approved');
    expect(statusAfterData.resolved_by).toBe('user-1');
  });

  it('full happy-path: create → deny → status denied', async () => {
    const createResult = await callTool('create_approval_request', {
      run_id: 'run-1',
      description: 'Risky action',
      action: { type: 'delete' },
      timeout_seconds: 60,
    }, adminCtx());
    const requestId: string = JSON.parse(createResult.content[0].text).approval_request_id;

    const denyResult = await callTool('deny_action', {
      approval_request_id: requestId,
      resolution: 'not approved — wrong environment',
    }, adminCtx());

    expect(denyResult.isError).toBeUndefined();
    const decision = JSON.parse(denyResult.content[0].text);
    expect(decision.decision).toBe('denied');

    const statusResult = await callTool('request_approval_status', { approval_request_id: requestId }, adminCtx());
    expect(JSON.parse(statusResult.content[0].text).status).toBe('denied');
  });

  it('create_approval_request requires approvals:write scope', async () => {
    const ctx: McpAuthContext = { ...adminCtx(), scopes: ['runs:read'] };
    const result = await callTool('create_approval_request', {
      run_id: 'run-1',
      description: 'test',
      action: {},
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Insufficient scope/);
  });

  it('approve_action rejects without approvals:decide', async () => {
    const ctx: McpAuthContext = { ...adminCtx(), scopes: ['approvals:read'] };
    const result = await callTool('approve_action', { approval_request_id: 'apr-1' }, ctx);
    expect(result.isError).toBe(true);
  });

  it('approve_action returns not-found for unknown request', async () => {
    const result = await callTool('approve_action', { approval_request_id: 'nonexistent' }, adminCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
  });

  it('double-resolve returns current state, not error', async () => {
    // Set up an already-approved request
    mockApprovalRequests.set('apr-resolved', {
      id: 'apr-resolved', run_id: 'run-1', status: 'approved', description: 'x', action: '{}',
    });

    const result = await callTool('approve_action', { approval_request_id: 'apr-resolved' }, adminCtx());
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.message).toMatch(/already in state/);
  });

  it('create_approval_request returns not-found for missing run', async () => {
    const result = await callTool('create_approval_request', {
      run_id: 'nonexistent-run',
      description: 'test',
      action: {},
    }, adminCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
  });
});

// ---------------------------------------------------------------------------
// Additional tool tests for full coverage
// ---------------------------------------------------------------------------

describe('MCP tool: send_input', () => {
  beforeEach(() => {
    mockRuns.clear();
    mockRuns.set('run-active', { id: 'run-active', status: 'running' });
  });

  it('queues input command for active run', async () => {
    const result = await callTool('send_input', { run_id: 'run-active', input: 'please summarize' }, adminCtx());
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('queued');
    expect(typeof data.command_id).toBe('string');
  });

  it('returns not-found for inactive run', async () => {
    mockRuns.set('run-done', { id: 'run-done', status: 'done' });
    const result = await callTool('send_input', { run_id: 'run-done', input: 'hello' }, adminCtx());
    expect(result.isError).toBe(true);
  });
});

describe('MCP tool: interrupt_session', () => {
  beforeEach(() => {
    mockRuns.clear();
    mockRuns.set('run-1', { id: 'run-1', status: 'running' });
  });

  it('queues escape command', async () => {
    const result = await callTool('interrupt_session', { run_id: 'run-1' }, adminCtx());
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('queued');
  });

  it('returns not-found for unknown run', async () => {
    const result = await callTool('interrupt_session', { run_id: 'unknown' }, adminCtx());
    expect(result.isError).toBe(true);
  });
});

describe('MCP tool: cancel_run', () => {
  beforeEach(() => {
    mockRuns.clear();
    mockRuns.set('run-running', { id: 'run-running', status: 'running' });
    mockRuns.set('run-done', { id: 'run-done', status: 'done' });
  });

  it('queues STOP for running run', async () => {
    const result = await callTool('cancel_run', { run_id: 'run-running' }, adminCtx());
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.message).toMatch(/Cancellation requested/);
  });

  it('reports already-terminal when run is done', async () => {
    const result = await callTool('cancel_run', { run_id: 'run-done' }, adminCtx());
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.message).toMatch(/terminal state/);
  });
});

describe('MCP tool: list_mcp_tokens (admin only)', () => {
  it('rejects non-admin scope', async () => {
    const ctx: McpAuthContext = { ...adminCtx(), scopes: ['runs:read'] };
    const result = await callTool('list_mcp_tokens', {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Insufficient scope/);
  });

  it('returns tokens for admin', async () => {
    const result = await callTool('list_mcp_tokens', {}, adminCtx());
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.tokens)).toBe(true);
  });
});
