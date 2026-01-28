import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

// Create a test database
const testDir = join(process.cwd(), '.test-data');
const testDbPath = join(testDir, 'test.sqlite');

describe('Database Schema', () => {
  let db: Database.Database;

  beforeAll(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }

    db = new Database(testDbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Initialize schema (copy from database.ts)
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        command TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        started_at INTEGER,
        finished_at INTEGER,
        exit_code INTEGER,
        error_message TEXT,
        capability_token TEXT NOT NULL,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        data TEXT,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
        sequence INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);

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

      CREATE TABLE IF NOT EXISTS nonces (
        nonce TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_nonces_created_at ON nonces(created_at);

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        totp_secret TEXT,
        role TEXT NOT NULL DEFAULT 'viewer',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at INTEGER NOT NULL
      );

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
    `);
  });

  afterAll(() => {
    db.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  beforeEach(() => {
    // Clean tables between tests
    db.exec('DELETE FROM events');
    db.exec('DELETE FROM commands');
    db.exec('DELETE FROM artifacts');
    db.exec('DELETE FROM runs');
    db.exec('DELETE FROM nonces');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM audit_log');
  });

  describe('Runs Table', () => {
    it('should create a run', () => {
      const stmt = db.prepare(`
        INSERT INTO runs (id, capability_token) VALUES (?, ?)
      `);
      stmt.run('test-run-1', 'test-token');

      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get('test-run-1') as any;
      expect(run).toBeDefined();
      expect(run.id).toBe('test-run-1');
      expect(run.status).toBe('pending');
      expect(run.capability_token).toBe('test-token');
    });

    it('should update run status', () => {
      db.prepare('INSERT INTO runs (id, capability_token) VALUES (?, ?)').run('run-2', 'token');
      db.prepare('UPDATE runs SET status = ?, started_at = unixepoch() WHERE id = ?').run('running', 'run-2');

      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get('run-2') as any;
      expect(run.status).toBe('running');
      expect(run.started_at).toBeGreaterThan(0);
    });

    it('should store metadata as JSON', () => {
      const metadata = JSON.stringify({ key: 'value', count: 42 });
      db.prepare('INSERT INTO runs (id, capability_token, metadata) VALUES (?, ?, ?)').run('run-3', 'token', metadata);

      const run = db.prepare('SELECT metadata FROM runs WHERE id = ?').get('run-3') as any;
      expect(JSON.parse(run.metadata)).toEqual({ key: 'value', count: 42 });
    });
  });

  describe('Events Table', () => {
    beforeEach(() => {
      db.prepare('INSERT INTO runs (id, capability_token) VALUES (?, ?)').run('run-events', 'token');
    });

    it('should insert events with auto-increment id', () => {
      db.prepare('INSERT INTO events (run_id, type, data) VALUES (?, ?, ?)').run('run-events', 'stdout', 'output');
      db.prepare('INSERT INTO events (run_id, type, data) VALUES (?, ?, ?)').run('run-events', 'stderr', 'error');

      const events = db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY id').all('run-events') as any[];
      expect(events.length).toBe(2);
      expect(events[0].id).toBeLessThan(events[1].id);
    });

    it('should cascade delete events when run is deleted', () => {
      db.prepare('INSERT INTO events (run_id, type, data) VALUES (?, ?, ?)').run('run-events', 'stdout', 'test');

      const before = db.prepare('SELECT COUNT(*) as count FROM events').get() as any;
      expect(before.count).toBe(1);

      db.prepare('DELETE FROM runs WHERE id = ?').run('run-events');

      const after = db.prepare('SELECT COUNT(*) as count FROM events').get() as any;
      expect(after.count).toBe(0);
    });

    it('should order events by sequence', () => {
      db.prepare('INSERT INTO events (run_id, type, data, sequence) VALUES (?, ?, ?, ?)').run('run-events', 'stdout', 'first', 1);
      db.prepare('INSERT INTO events (run_id, type, data, sequence) VALUES (?, ?, ?, ?)').run('run-events', 'stdout', 'third', 3);
      db.prepare('INSERT INTO events (run_id, type, data, sequence) VALUES (?, ?, ?, ?)').run('run-events', 'stdout', 'second', 2);

      const events = db.prepare('SELECT data FROM events WHERE run_id = ? ORDER BY sequence').all('run-events') as any[];
      expect(events.map(e => e.data)).toEqual(['first', 'second', 'third']);
    });
  });

  describe('Commands Table', () => {
    beforeEach(() => {
      db.prepare('INSERT INTO runs (id, capability_token) VALUES (?, ?)').run('run-cmds', 'token');
    });

    it('should insert commands', () => {
      db.prepare('INSERT INTO commands (id, run_id, command) VALUES (?, ?, ?)').run('cmd-1', 'run-cmds', 'npm test');

      const cmd = db.prepare('SELECT * FROM commands WHERE id = ?').get('cmd-1') as any;
      expect(cmd.command).toBe('npm test');
      expect(cmd.status).toBe('pending');
    });

    it('should update command status on ack', () => {
      db.prepare('INSERT INTO commands (id, run_id, command) VALUES (?, ?, ?)').run('cmd-2', 'run-cmds', 'git diff');
      db.prepare(`
        UPDATE commands SET status = 'completed', acked_at = unixepoch(), result = ? WHERE id = ?
      `).run('diff output', 'cmd-2');

      const cmd = db.prepare('SELECT * FROM commands WHERE id = ?').get('cmd-2') as any;
      expect(cmd.status).toBe('completed');
      expect(cmd.result).toBe('diff output');
      expect(cmd.acked_at).toBeGreaterThan(0);
    });
  });

  describe('Nonces Table', () => {
    it('should enforce unique nonces', () => {
      db.prepare('INSERT INTO nonces (nonce) VALUES (?)').run('nonce-1');

      expect(() => {
        db.prepare('INSERT INTO nonces (nonce) VALUES (?)').run('nonce-1');
      }).toThrow();
    });

    it('should allow different nonces', () => {
      db.prepare('INSERT INTO nonces (nonce) VALUES (?)').run('nonce-a');
      db.prepare('INSERT INTO nonces (nonce) VALUES (?)').run('nonce-b');

      const count = db.prepare('SELECT COUNT(*) as count FROM nonces').get() as any;
      expect(count.count).toBe(2);
    });

    it('should cleanup old nonces', () => {
      const old = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
      db.prepare('INSERT INTO nonces (nonce, created_at) VALUES (?, ?)').run('old-nonce', old);
      db.prepare('INSERT INTO nonces (nonce) VALUES (?)').run('new-nonce');

      const cutoff = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      db.prepare('DELETE FROM nonces WHERE created_at < ?').run(cutoff);

      const remaining = db.prepare('SELECT nonce FROM nonces').all() as any[];
      expect(remaining.length).toBe(1);
      expect(remaining[0].nonce).toBe('new-nonce');
    });
  });

  describe('Users Table', () => {
    it('should enforce unique usernames', () => {
      db.prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?)').run('user-1', 'admin', 'admin');

      expect(() => {
        db.prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?)').run('user-2', 'admin', 'viewer');
      }).toThrow();
    });

    it('should store password hash and totp secret', () => {
      db.prepare(`
        INSERT INTO users (id, username, password_hash, totp_secret, role)
        VALUES (?, ?, ?, ?, ?)
      `).run('user-3', 'testuser', 'hashed_password', 'totp_secret_here', 'operator');

      const user = db.prepare('SELECT * FROM users WHERE id = ?').get('user-3') as any;
      expect(user.password_hash).toBe('hashed_password');
      expect(user.totp_secret).toBe('totp_secret_here');
      expect(user.role).toBe('operator');
    });
  });

  describe('Sessions Table', () => {
    beforeEach(() => {
      db.prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?)').run('user-sess', 'testuser', 'admin');
    });

    it('should create sessions with expiry', () => {
      const expires = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now
      db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('sess-1', 'user-sess', expires);

      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-1') as any;
      expect(session.user_id).toBe('user-sess');
      expect(session.expires_at).toBe(expires);
    });

    it('should cascade delete sessions when user is deleted', () => {
      db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('sess-2', 'user-sess', 999999999);

      db.prepare('DELETE FROM users WHERE id = ?').run('user-sess');

      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-2');
      expect(session).toBeUndefined();
    });
  });

  describe('Audit Log', () => {
    it('should record audit entries', () => {
      db.prepare(`
        INSERT INTO audit_log (user_id, action, target_type, target_id, details, ip_address)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('user-1', 'run.create', 'run', 'run-1', '{"command":"test"}', '127.0.0.1');

      const log = db.prepare('SELECT * FROM audit_log').all() as any[];
      expect(log.length).toBe(1);
      expect(log[0].action).toBe('run.create');
      expect(JSON.parse(log[0].details)).toEqual({ command: 'test' });
    });

    it('should order by timestamp', () => {
      db.prepare('INSERT INTO audit_log (user_id, action, timestamp) VALUES (?, ?, ?)').run('u', 'first', 100);
      db.prepare('INSERT INTO audit_log (user_id, action, timestamp) VALUES (?, ?, ?)').run('u', 'third', 300);
      db.prepare('INSERT INTO audit_log (user_id, action, timestamp) VALUES (?, ?, ?)').run('u', 'second', 200);

      const logs = db.prepare('SELECT action FROM audit_log ORDER BY timestamp DESC').all() as any[];
      expect(logs.map(l => l.action)).toEqual(['third', 'second', 'first']);
    });
  });
});
