import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config.js';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

// Ensure data directory exists
const dbDir = dirname(config.dbPath);
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

export const db: DatabaseType = new Database(config.dbPath);

export function getConnection(): DatabaseType {
  return db;
}

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  -- Runs table
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    label TEXT,
    command TEXT,
    repo_path TEXT,
    repo_name TEXT,
    waiting_approval INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    started_at INTEGER,
    finished_at INTEGER,
    exit_code INTEGER,
    error_message TEXT,
    capability_token TEXT NOT NULL,
    metadata TEXT,
    tags TEXT,
    worker_type TEXT NOT NULL DEFAULT 'claude',
    claimed_by TEXT,
    claimed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
  CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
  CREATE INDEX IF NOT EXISTS idx_runs_waiting_approval ON runs(waiting_approval);
  CREATE INDEX IF NOT EXISTS idx_runs_worker_type ON runs(worker_type);

  -- Migration: Add worker_type column if it doesn't exist
  -- This is a no-op if the column already exists
  -- ALTER TABLE runs ADD COLUMN worker_type TEXT NOT NULL DEFAULT 'claude';

  -- Events table (log chunks, markers)
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    data TEXT,
    step_id TEXT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
    sequence INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_step_id ON events(step_id);

  -- Commands table (UI -> runner)
  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    command TEXT NOT NULL,
    arguments TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    acked_at INTEGER,
    result TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_commands_run_id ON commands(run_id);
  CREATE INDEX IF NOT EXISTS idx_commands_status ON commands(status);

  -- Artifacts table
  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);

  -- Nonces for replay protection
  CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_nonces_created_at ON nonces(created_at);

  -- Users table (for local auth fallback)
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    totp_secret TEXT,
    role TEXT NOT NULL DEFAULT 'viewer',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- Sessions table
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  -- Audit log
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    details TEXT,
    ip_address TEXT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);

  -- Alert rules
  CREATE TABLE IF NOT EXISTS alert_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- Alerts (triggered notifications)
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    rule_id TEXT REFERENCES alert_rules(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    message TEXT,
    target_type TEXT,
    target_id TEXT,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    acknowledged_by TEXT,
    acknowledged_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON alerts(acknowledged);
  CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);

  -- UI preferences
  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    dark_mode INTEGER NOT NULL DEFAULT 1,
    autoscroll INTEGER NOT NULL DEFAULT 1,
    compact_view INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- Session state for resume/restart functionality
  CREATE TABLE IF NOT EXISTS run_state (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    working_dir TEXT NOT NULL,
    original_command TEXT,
    last_sequence INTEGER DEFAULT 0,
    stdin_buffer TEXT,
    environment TEXT,
    provider_state TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- MCP API tokens (separate from UI session tokens)
  -- Each token is scoped, supports expiry, and is linked to a user.
  CREATE TABLE IF NOT EXISTS mcp_tokens (
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
  CREATE INDEX IF NOT EXISTS idx_mcp_tokens_token_hash ON mcp_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user_id ON mcp_tokens(user_id);

  -- Approval requests — formal gates for dangerous/irreversible agent actions.
  -- Replaces ad-hoc prompt_waiting event scanning with a structured flow.
  CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    session_id TEXT,
    description TEXT NOT NULL,
    action TEXT NOT NULL,           -- JSON: structured action the agent wants to take
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
    resolved_at INTEGER,
    resolved_by TEXT,
    resolution TEXT,                -- free-text rationale
    timeout_seconds INTEGER NOT NULL DEFAULT 300,
    provider_correlation_id TEXT    -- lets the adapter unblock when resolved
  );
  CREATE INDEX IF NOT EXISTS idx_approval_requests_run_id ON approval_requests(run_id);
  CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
  CREATE INDEX IF NOT EXISTS idx_approval_requests_requested_at ON approval_requests(requested_at);

  -- Project targets used by MCP auto-setup for multi-repo / multi-machine installs.
  CREATE TABLE IF NOT EXISTS project_targets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    path TEXT NOT NULL,
    machine_id TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_project_targets_user_id ON project_targets(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_project_targets_user_path ON project_targets(user_id, path);
`);

function ensureColumn(table: string, column: string, type: string): void {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const hasColumn = existing.some((col) => col.name === column);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function hasTable(table: string): boolean {
  const row = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table) as { name: string } | undefined;
  return Boolean(row);
}

function hasColumn(table: string, column: string): boolean {
  if (!hasTable(table)) return false;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((col) => col.name === column);
}

function migrateLegacyClientSchema(): void {
  if (hasColumn('runs', 'client_id')) {
    db.exec('DROP INDEX IF EXISTS idx_runs_client_id');
    db.exec('ALTER TABLE runs DROP COLUMN client_id');
  }

  if (hasTable('clients')) {
    db.exec('DROP INDEX IF EXISTS idx_clients_agent_id');
    db.exec('DROP INDEX IF EXISTS idx_clients_status');
    db.exec('DROP INDEX IF EXISTS idx_clients_last_seen');
    db.exec('DROP TABLE IF EXISTS clients');
  }
}

migrateLegacyClientSchema();

ensureColumn('runs', 'claimed_by', 'TEXT');
ensureColumn('runs', 'claimed_at', 'INTEGER');
ensureColumn('commands', 'arguments', 'TEXT');
ensureColumn('run_state', 'provider_state', 'TEXT');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_runs_claimed_by ON runs(claimed_by);
  CREATE INDEX IF NOT EXISTS idx_runs_claimed_at ON runs(claimed_at);
`);

// ---------------------------------------------------------------------------
// MCP token helpers
// ---------------------------------------------------------------------------

/** Look up a valid (non-revoked, non-expired) MCP token by its SHA-256 hash. */
export function findMcpToken(tokenHash: string): {
  id: string;
  label: string;
  userId: string;
  scopes: string[];
} | undefined {
  const row = db.prepare(`
    SELECT id, label, user_id, scopes
    FROM mcp_tokens
    WHERE token_hash = ?
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > unixepoch())
  `).get(tokenHash) as { id: string; label: string; user_id: string; scopes: string } | undefined;

  if (!row) return undefined;

  db.prepare('UPDATE mcp_tokens SET last_used_at = unixepoch() WHERE id = ?').run(row.id);

  return {
    id: row.id,
    label: row.label,
    userId: row.user_id,
    scopes: JSON.parse(row.scopes) as string[],
  };
}

// ---------------------------------------------------------------------------
// Approval request helpers
// ---------------------------------------------------------------------------

/** Expire timed-out approval requests and update the parent run's waiting_approval flag. */
export function expireTimedOutApprovals(): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    UPDATE approval_requests
    SET status = 'timed_out', resolved_at = ?
    WHERE status = 'pending'
      AND timeout_seconds > 0
      AND (requested_at + timeout_seconds) < ?
  `).run(now, now);

  if (result.changes > 0) {
    // Clear waiting_approval on runs that no longer have pending approvals
    db.prepare(`
      UPDATE runs SET waiting_approval = 0
      WHERE waiting_approval = 1
        AND id NOT IN (
          SELECT DISTINCT run_id FROM approval_requests WHERE status = 'pending'
        )
    `).run();
  }

  return result.changes;
}

// Helper functions
export function cleanupExpiredNonces(): number {
  const cutoff = Math.floor(Date.now() / 1000) - config.nonceExpirySeconds;
  const result = db.prepare('DELETE FROM nonces WHERE created_at < ?').run(cutoff);
  return result.changes;
}

export function cleanupExpiredSessions(): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return result.changes;
}

// Update client status based on heartbeat
export function cleanupExpiredRunClaims(): number {
  const now = Math.floor(Date.now() / 1000);
  // Release expired run claims
  const claimCutoff = now - config.claimLeaseSeconds;
  const result = db.prepare(`
    UPDATE runs
    SET claimed_by = NULL, claimed_at = NULL
    WHERE status = 'pending'
      AND claimed_at IS NOT NULL
      AND claimed_at < ?
  `).run(claimCutoff);

  return result.changes;
}

// Run cleanup periodically
setInterval(() => {
  cleanupExpiredNonces();
  cleanupExpiredSessions();
  cleanupExpiredRunClaims();
  expireTimedOutApprovals();
}, 60000); // Every minute
