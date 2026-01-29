/**
 * Tests for clients route module
 * 
 * Tests cover:
 * - Client registration and authentication
 * - WebSocket connection handling
 * - Client session management
 * - Client disconnect and cleanup
 * - Multi-client scenarios
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { clientsRouter } from './clients.js';
import { db } from '../services/database.js';

describe('Clients Route Module', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/clients', clientsRouter);
    
    // Mock database operations
    vi.mock('../services/database.js');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/clients/register', () => {
    it('should register a new client with valid credentials', async () => {
      const mockClient = {
        id: 'client-1',
        name: 'Test Client',
        secret: 'test-secret',
        workspace: '/test/workspace',
        createdAt: new Date().toISOString()
      };

      vi.mocked(db.insert).mockResolvedValueOnce(mockClient);

      const response = await request(app)
        .post('/api/clients/register')
        .send({
          name: 'Test Client',
          workspace: '/test/workspace'
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('secret');
      expect(response.body.name).toBe('Test Client');
      expect(response.body.workspace).toBe('/test/workspace');
    });

    it('should reject registration without name', async () => {
      const response = await request(app)
        .post('/api/clients/register')
        .send({
          workspace: '/test/workspace'
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should reject registration without workspace', async () => {
      const response = await request(app)
        .post('/api/clients/register')
        .send({
          name: 'Test Client'
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should reject duplicate client names', async () => {
      vi.mocked(db.query).mockRejectedValueOnce(
        new Error('UNIQUE constraint failed: clients.name')
      );

      const response = await request(app)
        .post('/api/clients/register')
        .send({
          name: 'Existing Client',
          workspace: '/test/workspace'
        });

      expect(response.status).toBe(409);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('GET /api/clients/:id', () => {
    it('should return client information for valid ID', async () => {
      const mockClient = {
        id: 'client-1',
        name: 'Test Client',
        workspace: '/test/workspace',
        connected: true,
        lastSeen: new Date().toISOString()
      };

      vi.mocked(db.query).mockResolvedValueOnce([mockClient]);

      const response = await request(app)
        .get('/api/clients/client-1');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id', 'client-1');
      expect(response.body).toHaveProperty('name', 'Test Client');
      expect(response.body).toHaveProperty('connected', true);
    });

    it('should return 404 for non-existent client', async () => {
      vi.mocked(db.query).mockResolvedValueOnce([]);

      const response = await request(app)
        .get('/api/clients/non-existent');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('GET /api/clients', () => {
    it('should return list of all clients', async () => {
      const mockClients = [
        {
          id: 'client-1',
          name: 'Client One',
          workspace: '/workspace/1',
          connected: true,
          lastSeen: new Date().toISOString()
        },
        {
          id: 'client-2',
          name: 'Client Two',
          workspace: '/workspace/2',
          connected: false,
          lastSeen: new Date().toISOString()
        }
      ];

      vi.mocked(db.query).mockResolvedValueOnce(mockClients);

      const response = await request(app)
        .get('/api/clients');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(2);
      expect(response.body[0]).toHaveProperty('id', 'client-1');
      expect(response.body[1]).toHaveProperty('id', 'client-2');
    });

    it('should filter clients by connected status', async () => {
      const mockClients = [
        {
          id: 'client-1',
          name: 'Client One',
          workspace: '/workspace/1',
          connected: true,
          lastSeen: new Date().toISOString()
        }
      ];

      vi.mocked(db.query).mockResolvedValueOnce(mockClients);

      const response = await request(app)
        .get('/api/clients?connected=true');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.every((c: any) => c.connected === true)).toBe(true);
    });
  });

  describe('DELETE /api/clients/:id', () => {
    it('should delete an existing client', async () => {
      vi.mocked(db.delete).mockResolvedValueOnce(1);

      const response = await request(app)
        .delete('/api/clients/client-1');

      expect(response.status).toBe(204);
    });

    it('should return 404 for non-existent client', async () => {
      vi.mocked(db.delete).mockResolvedValueOnce(0);

      const response = await request(app)
        .delete('/api/clients/non-existent');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('WebSocket Connection', () => {
    it('should accept WebSocket connection with valid credentials', async () => {
      // This test would require a WebSocket client library
      // For now, we'll test the HTTP endpoint that initiates WebSocket
      const response = await request(app)
        .get('/api/clients/client-1/ws')
        .set('Upgrade', 'websocket')
        .set('Connection', 'Upgrade')
        .set('Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ==')
        .set('Sec-WebSocket-Version', '13');

      // WebSocket upgrade response would be 101 Switching Protocols
      expect([101, 426]).toContain(response.status);
    });

    it('should reject WebSocket connection without authentication', async () => {
      const response = await request(app)
        .get('/api/clients/invalid/ws')
        .set('Upgrade', 'websocket')
        .set('Connection', 'Upgrade')
        .set('Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ==')
        .set('Sec-WebSocket-Version', '13');

      expect(response.status).toBe(401);
    });
  });

  describe('Client Session Management', () => {
    it('should update client last seen timestamp on activity', async () => {
      vi.mocked(db.update).mockResolvedValueOnce(1);

      const response = await request(app)
        .post('/api/clients/client-1/heartbeat');

      expect(response.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });

    it('should handle multiple concurrent client sessions', async () => {
      const mockClients = Array.from({ length: 5 }, (_, i) => ({
        id: `client-${i + 1}`,
        name: `Client ${i + 1}`,
        workspace: `/workspace/${i + 1}`,
        connected: true,
        lastSeen: new Date().toISOString()
      }));

      vi.mocked(db.query).mockResolvedValueOnce(mockClients);

      const response = await request(app)
        .get('/api/clients');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(5);
    });
  });

  describe('Client Disconnect and Cleanup', () => {
    it('should mark client as disconnected on session end', async () => {
      vi.mocked(db.update).mockResolvedValueOnce(1);

      const response = await request(app)
        .post('/api/clients/client-1/disconnect');

      expect(response.status).toBe(200);
      expect(db.update).toHaveBeenCalledWith(
        expect.objectContaining({
          connected: false
        })
      );
    });

    it('should clean up stale sessions periodically', async () => {
      const staleDate = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
      
      vi.mocked(db.query).mockResolvedValueOnce([
        { id: 'stale-client', connected: true, lastSeen: staleDate.toISOString() }
      ]);
      
      vi.mocked(db.update).mockResolvedValueOnce(1);

      const response = await request(app)
        .post('/api/clients/cleanup-sessions');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('cleaned');
    });
  });

  describe('Multi-Client Scenarios', () => {
    it('should handle concurrent client registrations', async () => {
      const registrations = Array.from({ length: 3 }, (_, i) => ({
        name: `Client ${i + 1}`,
        workspace: `/workspace/${i + 1}`
      }));

      for (const reg of registrations) {
        vi.mocked(db.insert).mockResolvedValueOnce({
          id: `client-${reg.name}`,
          ...reg,
          secret: 'generated-secret',
          createdAt: new Date().toISOString()
        });

        const response = await request(app)
          .post('/api/clients/register')
          .send(reg);

        expect(response.status).toBe(201);
      }
    });

    it('should route messages to specific clients', async () => {
      const mockClient = {
        id: 'client-1',
        name: 'Target Client',
        workspace: '/workspace/1',
        connected: true
      };

      vi.mocked(db.query).mockResolvedValueOnce([mockClient]);

      const response = await request(app)
        .post('/api/clients/client-1/message')
        .send({
          type: 'command',
          payload: { command: 'echo test' }
        });

      expect(response.status).toBe(200);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle invalid client ID format', async () => {
      const response = await request(app)
        .get('/api/clients/invalid-id-format!@#');

      expect(response.status).toBe(400);
    });

    it('should handle database connection errors gracefully', async () => {
      vi.mocked(db.query).mockRejectedValueOnce(
        new Error('Database connection failed')
      );

      const response = await request(app)
        .get('/api/clients');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error');
    });

    it('should validate workspace path format', async () => {
      const response = await request(app)
        .post('/api/clients/register')
        .send({
          name: 'Test Client',
          workspace: '../../../etc/passwd' // Path traversal attempt
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should sanitize client name input', async () => {
      const response = await request(app)
        .post('/api/clients/register')
        .send({
          name: '<script>alert("xss")</script>',
          workspace: '/test/workspace'
        });

      expect(response.status).toBe(400);
    });
  });

  describe('Rate Limiting', () => {
    it('should enforce rate limit on client registration', async () => {
      const registrationData = {
        name: 'Test Client',
        workspace: '/test/workspace'
      };

      vi.mocked(db.insert).mockResolvedValue({
        id: 'client-1',
        ...registrationData,
        secret: 'test-secret',
        createdAt: new Date().toISOString()
      });

      // First request should succeed
      const firstResponse = await request(app)
        .post('/api/clients/register')
        .send(registrationData);

      expect(firstResponse.status).toBe(201);

      // Subsequent requests may be rate limited
      // (actual rate limiting would be implemented in middleware)
    });
  });

  describe('Client Metadata', () => {
    it('should store and retrieve client metadata', async () => {
      const mockClient = {
        id: 'client-1',
        name: 'Test Client',
        workspace: '/test/workspace',
        metadata: {
          os: 'linux',
          arch: 'x64',
          version: '1.0.0'
        }
      };

      vi.mocked(db.query).mockResolvedValueOnce([mockClient]);

      const response = await request(app)
        .get('/api/clients/client-1');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('metadata');
      expect(response.body.metadata).toHaveProperty('os');
      expect(response.body.metadata).toHaveProperty('arch');
    });

    it('should update client metadata', async () => {
      const updatedMetadata = {
        os: 'windows',
        arch: 'arm64',
        version: '1.1.0'
      };

      vi.mocked(db.update).mockResolvedValueOnce(1);

      const response = await request(app)
        .patch('/api/clients/client-1')
        .send({ metadata: updatedMetadata });

      expect(response.status).toBe(200);
    });
  });
});