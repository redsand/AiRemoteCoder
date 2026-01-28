import Database from 'better-sqlite3';
import { config } from '../config.js';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

// Ensure data directory exists
const dbDir = dirname(config.dbPath);
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(config.dbPath);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  -- Clients table (machines/agents connecting to gateway)
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    agent_id TEXT UNIQUE NOT NULL,
    last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
    version TEXT,
    capabilities TEXT,
    status TEXT NOT NULL DEFAULT 'online',
    operator_enabled INTEGER NOT NULL DEFAULT 1,
    metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_clients_agent_id ON clients(agent_id);
  CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
  CREATE INDEX IF NOT EXISTS idx_clients_last_seen ON clients(last_seen_at);

  -- Runs table
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
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
    tags TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runs_client_id ON runs(client_id);
  CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
  CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
  CREATE INDEX IF NOT EXISTS idx_runs_waiting_approval ON runs(waiting_approval);

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

  -- Commands table (UI -> wrapper)
  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    command TEXT NOT NULL,
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
`);

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
export function updateClientStatus(): number {
  const now = Math.floor(Date.now() / 1000);
  const offlineThreshold = now - 60; // 60 seconds without heartbeat = offline
  const degradedThreshold = now - 30; // 30 seconds = degraded

  // Mark clients as offline
  const offlineResult = db.prepare(
    "UPDATE clients SET status = 'offline' WHERE last_seen_at < ? AND status != 'offline'"
  ).run(offlineThreshold);

  // Mark clients as degraded
  db.prepare(
    "UPDATE clients SET status = 'degraded' WHERE last_seen_at >= ? AND last_seen_at < ? AND status = 'online'"
  ).run(offlineThreshold, degradedThreshold);

  // Mark clients as online
  db.prepare(
    "UPDATE clients SET status = 'online' WHERE last_seen_at >= ? AND status != 'online'"
  ).run(degradedThreshold);

  return offlineResult.changes;
}

// Run cleanup periodically
setInterval(() => {
  cleanupExpiredNonces();
  cleanupExpiredSessions();
  updateClientStatus();
}, 60000); // Every minute
