/**
 * Tests for new MCP-specific database helpers:
 *   - findMcpToken
 *   - expireTimedOutApprovals
 *
 * Uses a real in-memory SQLite database (not mocked) to exercise the
 * exact SQL queries.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Build an isolated in-memory DB for each test group
// ---------------------------------------------------------------------------

function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      totp_secret TEXT,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE mcp_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scopes TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER,
      last_used_at INTEGER,
      revoked_at INTEGER
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      waiting_approval INTEGER NOT NULL DEFAULT 0,
      capability_token TEXT NOT NULL,
      worker_type TEXT NOT NULL DEFAULT 'claude',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
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
  `);
  return db;
}

// Inline implementations of the helpers under test (so we can use the test DB)

function findMcpTokenWith(db: ReturnType<typeof buildTestDb>) {
  return (tokenHash: string) => {
    const row = db.prepare(`
      SELECT id, label, user_id, scopes
      FROM mcp_tokens
      WHERE token_hash = ?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > unixepoch())
    `).get(tokenHash) as { id: string; label: string; user_id: string; scopes: string } | undefined;
    if (!row) return undefined;
    db.prepare('UPDATE mcp_tokens SET last_used_at = unixepoch() WHERE id = ?').run(row.id);
    return { id: row.id, label: row.label, userId: row.user_id, scopes: JSON.parse(row.scopes) as string[] };
  };
}

function expireTimedOutApprovalsWith(db: ReturnType<typeof buildTestDb>) {
  return () => {
    const now = Math.floor(Date.now() / 1000);
    const result = db.prepare(`
      UPDATE approval_requests
      SET status = 'timed_out', resolved_at = ?
      WHERE status = 'pending'
        AND timeout_seconds > 0
        AND (requested_at + timeout_seconds) < ?
    `).run(now, now);
    if (result.changes > 0) {
      db.prepare(`
        UPDATE runs SET waiting_approval = 0
        WHERE waiting_approval = 1
          AND id NOT IN (
            SELECT DISTINCT run_id FROM approval_requests WHERE status = 'pending'
          )
      `).run();
    }
    return result.changes;
  };
}

// ---------------------------------------------------------------------------
// findMcpToken tests
// ---------------------------------------------------------------------------

describe('findMcpToken', () => {
  let db: ReturnType<typeof buildTestDb>;
  let findMcpToken: ReturnType<typeof findMcpTokenWith>;
  const rawToken = 'my-secret-token-1234';
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  beforeEach(() => {
    db = buildTestDb();
    findMcpToken = findMcpTokenWith(db);

    db.prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?)').run('u1', 'alice', 'admin');
    db.prepare(`
      INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes)
      VALUES ('tok-1', ?, 'My token', 'u1', '["runs:read","runs:write"]')
    `).run(tokenHash);
  });

  it('returns token data for a valid hash', () => {
    const result = findMcpToken(tokenHash);
    expect(result).toBeDefined();
    expect(result!.id).toBe('tok-1');
    expect(result!.label).toBe('My token');
    expect(result!.userId).toBe('u1');
    expect(result!.scopes).toContain('runs:read');
  });

  it('returns undefined for unknown hash', () => {
    expect(findMcpToken('unknownhash')).toBeUndefined();
  });

  it('returns undefined for revoked token', () => {
    db.prepare('UPDATE mcp_tokens SET revoked_at = unixepoch() WHERE id = ?').run('tok-1');
    expect(findMcpToken(tokenHash)).toBeUndefined();
  });

  it('returns undefined for expired token', () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 1000;
    db.prepare('UPDATE mcp_tokens SET expires_at = ? WHERE id = ?').run(pastExpiry, 'tok-1');
    expect(findMcpToken(tokenHash)).toBeUndefined();
  });

  it('returns token when expiry is in the future', () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 86400;
    db.prepare('UPDATE mcp_tokens SET expires_at = ? WHERE id = ?').run(futureExpiry, 'tok-1');
    expect(findMcpToken(tokenHash)).toBeDefined();
  });

  it('updates last_used_at on successful lookup', () => {
    const before = db.prepare('SELECT last_used_at FROM mcp_tokens WHERE id = ?').get('tok-1') as any;
    expect(before.last_used_at).toBeNull();

    findMcpToken(tokenHash);

    const after = db.prepare('SELECT last_used_at FROM mcp_tokens WHERE id = ?').get('tok-1') as any;
    expect(after.last_used_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// expireTimedOutApprovals tests
// ---------------------------------------------------------------------------

describe('expireTimedOutApprovals', () => {
  let db: ReturnType<typeof buildTestDb>;
  let expireTimedOutApprovals: ReturnType<typeof expireTimedOutApprovalsWith>;

  beforeEach(() => {
    db = buildTestDb();
    expireTimedOutApprovals = expireTimedOutApprovalsWith(db);

    db.prepare("INSERT INTO runs (id, status, waiting_approval, capability_token) VALUES ('run-1', 'waiting_approval', 1, 'tok')").run();
    db.prepare("INSERT INTO runs (id, status, waiting_approval, capability_token) VALUES ('run-2', 'running', 0, 'tok2')").run();
  });

  it('returns 0 when no approvals have timed out', () => {
    // Insert a fresh pending approval that has not yet timed out
    const futureRequested = Math.floor(Date.now() / 1000) + 9999;
    db.prepare(`
      INSERT INTO approval_requests (id, run_id, description, action, status, requested_at, timeout_seconds)
      VALUES ('apr-1', 'run-1', 'test', '{}', 'pending', ?, 300)
    `).run(futureRequested);

    expect(expireTimedOutApprovals()).toBe(0);
  });

  it('expires approvals that exceeded their timeout', () => {
    // Insert an already-expired approval (requested 1000s ago, 10s timeout)
    const pastRequested = Math.floor(Date.now() / 1000) - 1000;
    db.prepare(`
      INSERT INTO approval_requests (id, run_id, description, action, status, requested_at, timeout_seconds)
      VALUES ('apr-expired', 'run-1', 'stale request', '{}', 'pending', ?, 10)
    `).run(pastRequested);

    const changed = expireTimedOutApprovals();
    expect(changed).toBe(1);

    const row = db.prepare("SELECT status FROM approval_requests WHERE id = 'apr-expired'").get() as any;
    expect(row.status).toBe('timed_out');
  });

  it('clears waiting_approval on run when last pending approval expires', () => {
    const pastRequested = Math.floor(Date.now() / 1000) - 1000;
    db.prepare(`
      INSERT INTO approval_requests (id, run_id, description, action, status, requested_at, timeout_seconds)
      VALUES ('apr-2', 'run-1', 'stale', '{}', 'pending', ?, 10)
    `).run(pastRequested);

    expireTimedOutApprovals();

    const run = db.prepare("SELECT waiting_approval FROM runs WHERE id = 'run-1'").get() as any;
    expect(run.waiting_approval).toBe(0);
  });

  it('does not expire approvals with timeout_seconds = 0', () => {
    const pastRequested = Math.floor(Date.now() / 1000) - 9999;
    db.prepare(`
      INSERT INTO approval_requests (id, run_id, description, action, status, requested_at, timeout_seconds)
      VALUES ('apr-never', 'run-1', 'never timeout', '{}', 'pending', ?, 0)
    `).run(pastRequested);

    expect(expireTimedOutApprovals()).toBe(0);
  });

  it('does not affect already-resolved approvals', () => {
    const pastRequested = Math.floor(Date.now() / 1000) - 1000;
    db.prepare(`
      INSERT INTO approval_requests (id, run_id, description, action, status, requested_at, timeout_seconds)
      VALUES ('apr-done', 'run-1', 'already done', '{}', 'approved', ?, 10)
    `).run(pastRequested);

    expect(expireTimedOutApprovals()).toBe(0);
  });
});
