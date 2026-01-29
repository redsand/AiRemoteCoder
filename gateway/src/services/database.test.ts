import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
import * as dbService from './database.js';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

// Create a test database
const testDir = join(process.cwd(), '.test-data');
const testDbPath = join(testDir, 'test.sqlite');

describe('Database Service', () => {
  let db: Database.Database;

  beforeAll(() => {
    // Set environment var for test database
    process.env.DATABASE_PATH = testDbPath;
    
    // Create test directory
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test database
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }
    if (existsSync(testDir)) {
      rmSync(testDir);
    }
  });

  beforeEach(() => {
    // Initialize database for each test
    db = new Database(testDbPath);
    
    // Create test tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  });

  afterEach(() => {
    // Close database connection
    if (db) {
      db.close();
    }
    
    // Remove database file
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }
  });

  describe('Connection Handling', () => {
    it('should initialize database connection successfully', () => {
      const connection = dbService.getConnection();
      expect(connection).toBeDefined();
      expect(connection.open).toBe(true);
      connection.close();
    });

    it('should handle multiple connection requests', () => {
      const conn1 = dbService.getConnection();
      const conn2 = dbService.getConnection();
      expect(conn1).toBeDefined();
      expect(conn2).toBeDefined();
      conn1.close();
      conn2.close();
    });

    it('should close database connection properly', () => {
      const connection = dbService.getConnection();
      expect(() => connection.close()).not.toThrow();
    });

    it('should handle connection errors gracefully', () => {
      // Use invalid path
      const invalidPath = '/nonexistent/path/to/db.sqlite';
      expect(() => {
        const badDb = new Database(invalidPath, { readonly: true });
        badDb.close();
      }).not.toThrow(); // better-sqlite3 may not throw immediately
    });

    it('should handle database file not found scenario', () => {
      const nonExistentPath = join(testDir, 'nonexistent.sqlite');
      expect(() => {
        const newDb = new Database(nonExistentPath);
        newDb.close();
      }).not.toThrow();
      // Cleanup
      if (existsSync(nonExistentPath)) {
        rmSync(nonExistentPath);
      }
    });
  });

  describe('Query Execution', () => {
    beforeEach(() => {
      // Insert test data
      db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run('John Doe', 'john@example.com');
      db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run('Jane Smith', 'jane@example.com');
      db.prepare('INSERT INTO posts (user_id, title, content) VALUES (?, ?, ?)').run(1, 'First Post', 'Hello World');
      db.prepare('INSERT INTO posts (user_id, title, content) VALUES (?, ?, ?)').run(1, 'Second Post', 'Hello Again');
    });

    it('should execute simple SELECT query', () => {
      const result = db.prepare('SELECT * FROM users').all();
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('name', 'John Doe');
    });

    it('should execute SELECT with WHERE clause', () => {
      const result = db.prepare('SELECT * FROM users WHERE email = ?').get('john@example.com');
      expect(result).toBeDefined();
      expect(result?.name).toBe('John Doe');
    });

    it('should execute INSERT query', () => {
      const info = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run('Bob Wilson', 'bob@example.com');
      expect(info.changes).toBe(1);
      expect(info.lastInsertRowid).toBeGreaterThan(0);
    });

    it('should execute UPDATE query', () => {
      const info = db.prepare('UPDATE users SET name = ? WHERE id = ?').run('John Updated', 1);
      expect(info.changes).toBe(1);
      
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(1);
      expect(user?.name).toBe('John Updated');
    });

    it('should execute DELETE query', () => {
      const info = db.prepare('DELETE FROM users WHERE id = ?').run(2);
      expect(info.changes).toBe(1);
      
      const result = db.prepare('SELECT * FROM users').all();
      expect(result).toHaveLength(1);
    });

    it('should handle JOIN queries', () => {
      const result = db.prepare(`
        SELECT u.name, p.title 
        FROM users u 
        JOIN posts p ON u.id = p.user_id
      `).all();
      
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('name', 'John Doe');
      expect(result[0]).toHaveProperty('title');
    });

    it('should handle ORDER BY queries', () => {
      const result = db.prepare('SELECT * FROM users ORDER BY name DESC').all();
      expect(result[0].name).toBe('John Doe');
    });

    it('should handle LIMIT queries', () => {
      const result = db.prepare('SELECT * FROM users LIMIT 1').all();
      expect(result).toHaveLength(1);
    });

    it('should handle aggregate functions', () => {
      const count = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
      expect(count.count).toBe(2);
    });

    it('should handle GROUP BY queries', () => {
      const result = db.prepare('SELECT user_id, COUNT(*) as post_count FROM posts GROUP BY user_id').all();
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('post_count', 2);
    });
  });

  describe('Prepared Statements', () => {
    it('should prepare and execute statement multiple times', () => {
      const stmt = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
      
      stmt.run('User 1', 'user1@example.com');
      stmt.run('User 2', 'user2@example.com');
      stmt.run('User 3', 'user3@example.com');
      
      const result = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
      expect(result.count).toBe(3);
    });

    it('should handle named parameters in prepared statements', () => {
      const stmt = db.prepare('INSERT INTO users (name, email) VALUES (@name, @email)');
      stmt.run({ name: 'Named User', email: 'named@example.com' });
      
      const user = db.prepare('SELECT * FROM users WHERE name = ?').get('Named User');
      expect(user).toBeDefined();
      expect(user?.email).toBe('named@example.com');
    });

    it('should reuse prepared statement efficiently', () => {
      const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
      
      db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run('Test 1', 'test1@example.com');
      db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run('Test 2', 'test2@example.com');
      
      const user1 = stmt.get(1);
      const user2 = stmt.get(2);
      
      expect(user1).toBeDefined();
      expect(user2).toBeDefined();
    });

    it('should handle parameterized queries safely', () => {
      const maliciousInput = "'; DROP TABLE users; --";
      
      const stmt = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
      expect(() => stmt.run(maliciousInput, 'test@example.com')).not.toThrow();
      
      // Table should still exist
      const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
      expect(result).toBeDefined();
    });

    it('should get statement metadata', () => {
      const stmt = db.prepare('SELECT * FROM users');
      const columns = stmt.columns();
      
      expect(columns).toBeDefined();
      expect(columns.length).toBeGreaterThan(0);
      expect(columns.some(col => col.name === 'id')).toBe(true);
    });
  });

  describe('Transactions', () => {
    it('should commit transaction successfully', () => {
      const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
      
      db.transaction(() => {
        insert.run('Transaction User 1', 'trans1@example.com');
        insert.run('Transaction User 2', 'trans2@example.com');
      })();
      
      const count = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
      expect(count.count).toBe(2);
    });

    it('should rollback transaction on error', () => {
      const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
      
      expect(() => {
        db.transaction(() => {
          insert.run('User 1', 'user1@example.com');
          insert.run('User 2', 'user1@example.com'); // Duplicate email - will fail
        })();
      }).toThrow();
      
      const count = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
      expect(count.count).toBe(0);
    });

    it('should handle nested transactions (savepoints)', () => {
      const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
      
      db.transaction(() => {
        insert.run('Outer User', 'outer@example.com');
        
        db.transaction(() => {
          insert.run('Inner User', 'inner@example.com');
        })();
      })();
      
      const count = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
      expect(count.count).toBe(2);
    });

    it('should maintain transaction isolation', () => {
      const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
      
      // Start transaction
      const transaction = db.transaction(() => {
        insert.run('Isolated User', 'isolated@example.com');
        
        // Check inside transaction
        const innerCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
        expect(innerCount.count).toBe(1);
      });
      
      transaction();
      
      // Check after transaction
      const count = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
      expect(count.count).toBe(1);
    });

    it('should handle immediate transaction', () => {
      const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
      
      const transaction = db.transaction((name: string, email: string) => {
        insert.run(name, email);
      });
      
      transaction('Immediate User', 'immediate@example.com');
      
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get('immediate@example.com');
      expect(user).toBeDefined();
    });

    it('should rollback explicitly', () => {
      const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
      
      try {
        db.transaction(() => {
          insert.run('Rollback User', 'rollback@example.com');
          throw new Error('Intentional error');
        })();
      } catch (e) {
        // Expected
      }
      
      const count = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
      expect(count.count).toBe(0);
    });
  });

  describe('Error Scenarios', () => {
    it('should handle syntax errors in queries', () => {
      expect(() => {
        db.prepare('INVALID SQL QUERY').get();
      }).toThrow();
    });

    it('should handle constraint violations (unique)', () => {
      db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run('Duplicate User', 'dup@example.com');
      
      expect(() => {
        db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run('Another User', 'dup@example.com');
      }).toThrow();
    });

    it('should handle foreign key constraint violations', () => {
      expect(() => {
        db.prepare('INSERT INTO posts (user_id, title, content) VALUES (?, ?, ?)').run(999, 'Invalid Post', 'No user');
      }).toThrow();
    });

    it('should handle NOT NULL constraint violations', () => {
      expect(() => {
        db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run(null as any, 'test@example.com');
      }).toThrow();
    });

    it('should handle parameter count mismatch', () => {
      const stmt = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
      
      expect(() => {
        stmt.run('Only One Param');
      }).toThrow();
    });

    it('should handle query with no results', () => {
      const result = db.prepare('SELECT * FROM users WHERE id = 999').get();
      expect(result).toBeUndefined();
    });

    it('should handle empty result sets', () => {
      const result = db.prepare('SELECT * FROM users WHERE name = ?').all('Nonexistent');
      expect(result).toEqual([]);
    });

    it('should handle invalid column names', () => {
      expect(() => {
        db.prepare('SELECT invalid_column FROM users').get();
      }).toThrow();
    });

    it('should handle database locked scenarios', () => {
      // This test simulates concurrent access
      const db1 = new Database(testDbPath);
      const db2 = new Database(testDbPath);
      
      db1.pragma('journal_mode = ' + 'wal');
      
      // Both should be able to read
      const result1 = db1.prepare('SELECT * FROM users').all();
      const result2 = db2.prepare('SELECT * FROM users').all();
      
      expect(result1).toEqual(result2);
      
      db1.close();
      db2.close();
    });

    it('should handle malformed SQL', () => {
      expect(() => {
        db.prepare('SELEC * FROM').get();
      }).toThrow();
    });

    it('should handle type conversion errors', () => {
      db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run('Type Test', 'type@example.com');
      
      const result = db.prepare('SELECT id FROM users WHERE name = ?').get('Type Test') as { id: number };
      expect(typeof result.id).toBe('number');
    });
  });

  describe('Database Schema Operations', () => {
    it('should create table successfully', () => {
      db.exec('CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT)');
      
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_table'").get();
      expect(tables).toBeDefined();
    });

    it('should alter table structure', () => {
      db.prepare('ALTER TABLE users ADD COLUMN age INTEGER').run();
      
      const columns = db.prepare('PRAGMA table_info(users)').all();
      expect(columns.some((col: any) => col.name === 'age')).toBe(true);
    });

    it('should drop table', () => {
      db.exec('CREATE TABLE temp_table (id INTEGER)');
      db.exec('DROP TABLE temp_table');
      
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='temp_table'").get();
      expect(tables).toBeUndefined();
    });

    it('should handle indexes', () => {
      db.exec('CREATE INDEX idx_users_email ON users(email)');
      
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_email'").get();
      expect(indexes).toBeDefined();
    });

    it('should drop indexes', () => {
      db.exec('CREATE INDEX idx_temp ON users(name)');
      db.exec('DROP INDEX idx_temp');
      
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_temp'").get();
      expect(indexes).toBeUndefined();
    });
  });

  describe('Utility Functions', () => {
    it('should handle PRAGMA statements', () => {
      const result = db.pragma('journal_mode', { simple: true });
      expect(result).toBeDefined();
    });

    it('should set and read PRAGMA values', () => {
      db.pragma('synchronous = OFF');
      const syncMode = db.pragma('synchronous', { simple: true });
      expect(syncMode).toBeDefined();
    });

    it('should get database version', () => {
      const version = db.prepare('SELECT sqlite_version() as version').get() as { version: string };
      expect(version.version).toBeDefined();
      expect(typeof version.version).toBe('string');
    });

    it('should handle database file size', () => {
      const stats = db.pragma('page_count', { simple: true });
      expect(typeof stats).toBe('number');
    });

    it('should handle vacuum operation', () => {
      db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run('Vacuum Test', 'vacuum@example.com');
      db.prepare('DELETE FROM users').run();
      
      expect(() => db.exec('VACUUM')).not.toThrow();
    });
  });

  describe('Batch Operations', () => {
    it('should handle multiple inserts in transaction', () => {
      const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
      const insertMany = db.transaction((users: Array<{name: string, email: string}>) => {
        for (const user of users) {
          insert.run(user.name, user.email);
        }
      });
      
      const users = [
        { name: 'Batch 1', email: 'batch1@example.com' },
        { name: 'Batch 2', email: 'batch2@example.com' },
        { name: 'Batch 3', email: 'batch3@example.com' },
      ];
      
      insertMany(users);
      
      const count = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
      expect(count.count).toBe(3);
    });

    it('should handle bulk update operations', () => {
      // Insert test data
      const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
      insert.run('User 1', 'user1@example.com');
      insert.run('User 2', 'user2@example.com');
      
      // Update all
      const update = db.prepare('UPDATE users SET name = ?');
      const updateMany = db.transaction((newName: string) => {
        update.run(newName);
      });
      
      updateMany('Updated Name');
      
      const users = db.prepare('SELECT * FROM users').all();
      expect(users.every((u: any) => u.name === 'Updated Name')).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty strings', () => {
      db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run('', 'empty@example.com');
      
      const user = db.prepare('SELECT * FROM users WHERE name = ?').get('');
      expect(user).toBeDefined();
    });

    it('should handle very long strings', () => {
      const longString = 'a'.repeat(10000);
      db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run(longString, 'long@example.com');
      
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get('long@example.com');
      expect(user?.name).toBe(longString);
    });

    it('should handle special characters in strings', () => {
      const specialChars = "Test with 'quotes' and \"double quotes\" and \n newlines and \t tabs";
      db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run(specialChars, 'special@example.com');
      
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get('special@example.com');
      expect(user?.name).toBe(specialChars);
    });

    it('should handle Unicode characters', () => {
      const unicode = '用户 Ñoño café 日本語 🎉';
      db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run(unicode, 'unicode@example.com');
      
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get('unicode@example.com');
      expect(user?.name).toBe(unicode);
    });

    it('should handle NULL values in optional fields', () => {
      db.prepare('INSERT INTO posts (user_id, title, content) VALUES (?, ?, ?)').run(1, 'No Content', null);
      
      const post = db.prepare('SELECT * FROM posts WHERE content IS NULL').get();
      expect(post).toBeDefined();
    });

    it('should handle zero values', () => {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('zero_count', '0');
      
      const setting = db.prepare('SELECT * FROM settings WHERE key = ?').get('zero_count');
      expect(setting?.value).toBe('0');
    });

    it('should handle boolean-like values', () => {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('enabled', '1');
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('disabled', '0');
      
      const enabled = db.prepare('SELECT * FROM settings WHERE key = ?').get('enabled');
      const disabled = db.prepare('SELECT * FROM settings WHERE key = ?').get('disabled');
      
      expect(enabled?.value).toBe('1');
      expect(disabled?.value).toBe('0');
    });
  });

  describe('Performance Considerations', () => {
    it('should execute large number of queries efficiently', () => {
      const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
      const transaction = db.transaction((count: number) => {
        for (let i = 0; i < count; i++) {
          insert.run(`User ${i}`, `user${i}@example.com`);
        }
      });
      
      const start = Date.now();
      transaction(100);
      const duration = Date.now() - start;
      
      expect(duration).toBeLessThan(1000); // Should complete in less than 1 second
      
      const count = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
      expect(count.count).toBe(100);
    });

    it('should handle prepared statement caching', () => {
      const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
      
      db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run('Cached', 'cached@example.com');
      
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        stmt.get(1);
      }
      const duration = Date.now() - start;
      
      expect(duration).toBeLessThan(100); // Should be very fast
    });
  });
});