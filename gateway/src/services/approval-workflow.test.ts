import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApprovalRequest, resolveApprovalRequest } from './approval-workflow.js';

const { nanoidMock } = vi.hoisted(() => ({
  nanoidMock: vi.fn(),
}));

vi.mock('nanoid', () => ({
  nanoid: nanoidMock,
}));

function buildDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      waiting_approval INTEGER NOT NULL DEFAULT 0,
      capability_token TEXT NOT NULL
    );
    CREATE TABLE approval_requests (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      session_id TEXT,
      description TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
      resolved_at INTEGER,
      resolved_by TEXT,
      resolution TEXT,
      timeout_seconds INTEGER NOT NULL DEFAULT 300,
      provider_correlation_id TEXT
    );
    CREATE TABLE commands (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      command TEXT NOT NULL,
      arguments TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  db.prepare("INSERT INTO runs (id, status, waiting_approval, capability_token) VALUES ('run-1', 'running', 0, 'tok')").run();
  return db;
}

describe('approval workflow service', () => {
  let db: Database.Database;

  beforeEach(() => {
    nanoidMock.mockReset();
    db = buildDb();
  });

  afterEach(() => {
    db.close();
  });

  it('creates an approval request and updates run state atomically', () => {
    nanoidMock.mockReturnValueOnce('apr-1');

    const created = createApprovalRequest(db, {
      runId: 'run-1',
      description: 'needs approval',
      action: { type: 'danger' },
      timeoutSeconds: 300,
      providerCorrelationId: 'corr-1',
    });

    expect(created.approvalRequestId).toBe('apr-1');

    const request = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get('apr-1') as any;
    const run = db.prepare('SELECT status, waiting_approval FROM runs WHERE id = ?').get('run-1') as any;

    expect(request.status).toBe('pending');
    expect(run.status).toBe('waiting_approval');
    expect(run.waiting_approval).toBe(1);
  });

  it('resolves approval and queues the unblock command in one transaction', () => {
    nanoidMock.mockReturnValueOnce('apr-1');
    createApprovalRequest(db, {
      runId: 'run-1',
      description: 'needs approval',
      action: { type: 'danger' },
      timeoutSeconds: 300,
      providerCorrelationId: 'corr-1',
    });

    nanoidMock.mockReturnValueOnce('cmd-1');
    const resolved = resolveApprovalRequest(db, {
      approvalRequestId: 'apr-1',
      decision: 'approved',
      resolvedBy: 'user-1',
      resolution: 'ok',
    });

    expect(resolved.wasPending).toBe(true);
    expect(resolved.commandId).toBe('cmd-1');

    const request = db.prepare('SELECT status, resolved_by FROM approval_requests WHERE id = ?').get('apr-1') as any;
    const run = db.prepare('SELECT status, waiting_approval FROM runs WHERE id = ?').get('run-1') as any;
    const command = db.prepare('SELECT * FROM commands WHERE id = ?').get('cmd-1') as any;

    expect(request.status).toBe('approved');
    expect(request.resolved_by).toBe('user-1');
    expect(run.status).toBe('running');
    expect(run.waiting_approval).toBe(0);
    expect(command.command).toBe('__APPROVAL_RESOLVED__');
  });

  it('rolls back approval resolution if command enqueue fails', () => {
    nanoidMock.mockReturnValueOnce('apr-1');
    createApprovalRequest(db, {
      runId: 'run-1',
      description: 'needs approval',
      action: { type: 'danger' },
      timeoutSeconds: 300,
      providerCorrelationId: 'corr-1',
    });

    db.prepare(`
      INSERT INTO commands (id, run_id, command, status, created_at)
      VALUES ('cmd-1', 'run-1', 'existing', 'pending', unixepoch())
    `).run();

    nanoidMock.mockReturnValueOnce('cmd-1');

    expect(() => resolveApprovalRequest(db, {
      approvalRequestId: 'apr-1',
      decision: 'denied',
      resolvedBy: 'user-1',
      resolution: 'blocked',
    })).toThrow();

    const request = db.prepare('SELECT status, resolved_by FROM approval_requests WHERE id = ?').get('apr-1') as any;
    const run = db.prepare('SELECT status, waiting_approval FROM runs WHERE id = ?').get('run-1') as any;
    const commands = db.prepare('SELECT COUNT(*) as c FROM commands').get() as { c: number };

    expect(request.status).toBe('pending');
    expect(request.resolved_by).toBeNull();
    expect(run.status).toBe('waiting_approval');
    expect(run.waiting_approval).toBe(1);
    expect(commands.c).toBe(1);
  });
});
