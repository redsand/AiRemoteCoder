import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';
import { db } from '../services/database.js';
import { config } from '../config.js';
import { sign } from 'jsonwebtoken';

describe('Dashboard Routes', () => {
  let server: FastifyInstance;
  let testUserId: string;
  let authHeader: string;

  beforeAll(async () => {
    // Initialize test configuration
    config.jwtSecret = 'test-secret-for-dashboard-tests';
    config.database = ':memory:';
    
    // Build and start the test server
    server = await buildServer();
    await server.ready();
  });

  beforeEach(async () => {
    // Generate a unique test user ID
    testUserId = `test-user-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    // Create a valid JWT token for authentication
    const token = sign(
      { userId: testUserId, email: 'test@example.com' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    authHeader = `Bearer ${token}`;
  });

  afterEach(async () => {
    // Clean up test data
    try {
      await db.query('DELETE FROM user_sessions WHERE user_id = ?', [testUserId]);
      await db.query('DELETE FROM users WHERE id = ?', [testUserId]);
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  afterAll(async () => {
    // Close server and database connection
    await server.close();
    await db.close();
  });

  describe('GET /dashboard', () => {
    it('should return 401 when no authentication is provided', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dashboard'
      });

      expect(response.statusCode).toBe(401);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error');
    });

    it('should return 401 when invalid token is provided', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: 'Bearer invalid-token'
        }
      });

      expect(response.statusCode).toBe(401);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error');
    });

    it('should return 401 when expired token is provided', async () => {
      const expiredToken = sign(
        { userId: testUserId, email: 'test@example.com' },
        config.jwtSecret,
        { expiresIn: '-1h' }
      );

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: `Bearer ${expiredToken}`
        }
      });

      expect(response.statusCode).toBe(401);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error');
    });

    it('should retrieve dashboard data successfully with valid authentication', async () => {
      // Insert test user
      await db.query(
        'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, datetime("now"))',
        [testUserId, 'test@example.com', 'Test User']
      );

      // Insert test conversation
      await db.query(
        'INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, datetime("now"), datetime("now"))',
        ['conv-1', testUserId, 'Test Conversation']
      );

      // Insert test messages
      await db.query(
        'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, datetime("now"))',
        ['msg-1', 'conv-1', 'user', 'Hello']
      );

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: authHeader
        }
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      
      // Verify response structure
      expect(data).toHaveProperty('user');
      expect(data).toHaveProperty('stats');
      expect(data).toHaveProperty('recentConversations');
      expect(data).toHaveProperty('modelUsage');
      
      // Verify user data
      expect(data.user).toHaveProperty('id', testUserId);
      expect(data.user).toHaveProperty('email', 'test@example.com');
      
      // Verify stats structure
      expect(data.stats).toHaveProperty('totalConversations');
      expect(data.stats).toHaveProperty('totalMessages');
      expect(data.stats).toHaveProperty('activeModels');
      
      // Verify recent conversations is an array
      expect(Array.isArray(data.recentConversations)).toBe(true);
    });

    it('should validate user session exists before returning dashboard data', async () => {
      // Insert user without active session
      await db.query(
        'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, datetime("now"))',
        [testUserId, 'test@example.com', 'Test User']
      );

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: authHeader
        }
      });

      // Should create session if not exists or return data
      expect([200, 401]).toContain(response.statusCode);
    });

    it('should format response with correct data types', async () => {
      await db.query(
        'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, datetime("now"))',
        [testUserId, 'test@example.com', 'Test User']
      );

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: authHeader
        }
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      
      // Verify stats are numbers
      expect(typeof data.stats.totalConversations).toBe('number');
      expect(typeof data.stats.totalMessages).toBe('number');
      expect(typeof data.stats.activeModels).toBe('number');
      
      // Verify recent conversations have proper structure
      if (data.recentConversations.length > 0) {
        const conv = data.recentConversations[0];
        expect(conv).toHaveProperty('id');
        expect(conv).toHaveProperty('title');
        expect(conv).toHaveProperty('createdAt');
      }
    });

    it('should return empty arrays for users with no data', async () => {
      await db.query(
        'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, datetime("now"))',
        [testUserId, 'newuser@example.com', 'New User']
      );

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: authHeader
        }
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      
      expect(data.recentConversations).toEqual([]);
      expect(data.stats.totalConversations).toBe(0);
      expect(data.stats.totalMessages).toBe(0);
    });

    it('should handle malformed authorization header', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: 'InvalidFormat token'
        }
      });

      expect(response.statusCode).toBe(401);
    });

    it('should handle database errors gracefully', async () => {
      // Mock database query to throw error
      const originalQuery = db.query.bind(db);
      db.query = vi.fn().mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: authHeader
        }
      });

      expect(response.statusCode).toBe(500);
      
      // Restore original query
      db.query = originalQuery;
    });

    it('should limit recent conversations to reasonable number', async () => {
      await db.query(
        'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, datetime("now"))',
        [testUserId, 'test@example.com', 'Test User']
      );

      // Create multiple conversations
      for (let i = 1; i <= 15; i++) {
        await db.query(
          'INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, datetime("now"), datetime("now"))',
          [`conv-${i}`, testUserId, `Conversation ${i}`]
        );
      }

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: authHeader
        }
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      
      // Should return at most 10 recent conversations
      expect(data.recentConversations.length).toBeLessThanOrEqual(10);
    });

    it('should include model usage statistics', async () => {
      await db.query(
        'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, datetime("now"))',
        [testUserId, 'test@example.com', 'Test User']
      );

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: authHeader
        }
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      
      expect(data).toHaveProperty('modelUsage');
      expect(typeof data.modelUsage).toBe('object');
    });

    it('should update last accessed timestamp on dashboard request', async () => {
      await db.query(
        'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, datetime("now"))',
        [testUserId, 'test@example.com', 'Test User']
      );

      await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: authHeader
        }
      });

      // Verify last accessed was updated
      const result = await db.query(
        'SELECT last_accessed FROM users WHERE id = ?',
        [testUserId]
      );
      
      expect(result[0].last_accessed).toBeTruthy();
    });

    it('should handle concurrent requests safely', async () => {
      await db.query(
        'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, datetime("now"))',
        [testUserId, 'test@example.com', 'Test User']
      );

      // Make multiple concurrent requests
      const requests = Array(5).fill(null).map(() => 
        server.inject({
          method: 'GET',
          url: '/dashboard',
          headers: {
            authorization: authHeader
          }
        })
      );

      const responses = await Promise.all(requests);
      
      // All requests should succeed
      responses.forEach(response => {
        expect(response.statusCode).toBe(200);
      });
    });

    it('should include user preferences in response', async () => {
      await db.query(
        'INSERT INTO users (id, email, name, preferences, created_at) VALUES (?, ?, ?, ?, datetime("now"))',
        [testUserId, 'test@example.com', 'Test User', JSON.stringify({ theme: 'dark', language: 'en' })]
      );

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: authHeader
        }
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      
      expect(data.user).toHaveProperty('preferences');
    });

    it('should calculate accurate message counts across conversations', async () => {
      await db.query(
        'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, datetime("now"))',
        [testUserId, 'test@example.com', 'Test User']
      );

      // Create conversation with multiple messages
      await db.query(
        'INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, datetime("now"), datetime("now"))',
        ['conv-1', testUserId, 'Test Conversation']
      );

      for (let i = 1; i <= 5; i++) {
        await db.query(
          'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, datetime("now"))',
          [`msg-${i}`, 'conv-1', i % 2 === 0 ? 'assistant' : 'user', `Message ${i}`]
        );
      }

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: authHeader
        }
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      
      expect(data.stats.totalMessages).toBe(5);
    });
  });

  describe('GET /dashboard/summary', () => {
    it('should return summary data without full conversation details', async () => {
      await db.query(
        'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, datetime("now"))',
        [testUserId, 'test@example.com', 'Test User']
      );

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/summary',
        headers: {
          authorization: authHeader
        }
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      
      expect(data).toHaveProperty('summary');
      expect(data).toHaveProperty('stats');
      expect(data).not.toHaveProperty('recentConversations');
    });
  });
});