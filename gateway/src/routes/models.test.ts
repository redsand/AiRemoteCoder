import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { modelsRouter } from './models.js';
import { verifySignature, requireRole, logAudit } from '../middleware/auth.js';

// Mock the auth middleware
vi.mock('../middleware/auth.js', () => ({
  verifySignature: vi.fn((c, next) => next()),
  requireRole: vi.fn((roles) => (c, next) => next()),
  logAudit: vi.fn((action) => (c, next) => next())
}));

// Mock database
const mockDb = {
  models: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
};

// Create test app with models router
const app = new Hono();
app.route('/models', modelsRouter);

describe('Models Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('GET /models - List Models', () => {
    it('should return list of models successfully', async () => {
      const mockModels = [
        { id: 1, name: 'gpt-4', provider: 'openai', enabled: true },
        { id: 2, name: 'claude-3', provider: 'anthropic', enabled: true }
      ];

      mockDb.models.findMany.mockResolvedValue(mockModels);

      const response = await app.request('/models', {
        method: 'GET'
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ success: true, data: mockModels });
      expect(mockDb.models.findMany).toHaveBeenCalled();
    });

    it('should handle empty model list', async () => {
      mockDb.models.findMany.mockResolvedValue([]);

      const response = await app.request('/models', {
        method: 'GET'
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ success: true, data: [] });
    });

    it('should filter models by provider', async () => {
      const mockModels = [
        { id: 1, name: 'gpt-4', provider: 'openai', enabled: true }
      ];

      mockDb.models.findMany.mockResolvedValue(mockModels);

      const response = await app.request('/models?provider=openai', {
        method: 'GET'
      });

      expect(response.status).toBe(200);
      expect(mockDb.models.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { provider: 'openai' } })
      );
    });

    it('should filter models by enabled status', async () => {
      const mockModels = [
        { id: 1, name: 'gpt-4', provider: 'openai', enabled: true }
      ];

      mockDb.models.findMany.mockResolvedValue(mockModels);

      const response = await app.request('/models?enabled=true', {
        method: 'GET'
      });

      expect(response.status).toBe(200);
      expect(mockDb.models.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { enabled: true } })
      );
    });

    it('should handle database errors', async () => {
      mockDb.models.findMany.mockRejectedValue(new Error('Database error'));

      const response = await app.request('/models', {
        method: 'GET'
      });

      expect(response.status).toBe(500);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toBeDefined();
    });
  });

  describe('GET /models/:id - Get Model by ID', () => {
    it('should return a single model by ID', async () => {
      const mockModel = {
        id: 1,
        name: 'gpt-4',
        provider: 'openai',
        enabled: true,
        config: { temperature: 0.7 }
      };

      mockDb.models.findUnique.mockResolvedValue(mockModel);

      const response = await app.request('/models/1', {
        method: 'GET'
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ success: true, data: mockModel });
      expect(mockDb.models.findUnique).toHaveBeenCalledWith({
        where: { id: 1 }
      });
    });

    it('should return 404 for non-existent model', async () => {
      mockDb.models.findUnique.mockResolvedValue(null);

      const response = await app.request('/models/999', {
        method: 'GET'
      });

      expect(response.status).toBe(404);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('not found');
    });

    it('should handle invalid model ID', async () => {
      const response = await app.request('/models/invalid', {
        method: 'GET'
      });

      expect(response.status).toBe(400);
    });

    it('should handle database errors', async () => {
      mockDb.models.findUnique.mockRejectedValue(new Error('Database error'));

      const response = await app.request('/models/1', {
        method: 'GET'
      });

      expect(response.status).toBe(500);
      const json = await response.json();
      expect(json.success).toBe(false);
    });
  });

  describe('POST /models - Create Model', () => {
    const validModelData = {
      name: 'gpt-4-turbo',
      provider: 'openai',
      enabled: true,
      config: {
        temperature: 0.7,
        maxTokens: 4096
      }
    };

    it('should create a new model successfully', async () => {
      const createdModel = {
        id: 3,
        ...validModelData
      };

      mockDb.models.create.mockResolvedValue(createdModel);

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validModelData)
      });

      expect(response.status).toBe(201);
      const json = await response.json();
      expect(json).toEqual({ success: true, data: createdModel });
      expect(mockDb.models.create).toHaveBeenCalledWith({
        data: validModelData
      });
    });

    it('should validate required fields', async () => {
      const invalidData = {
        name: 'gpt-4'
        // missing provider
      };

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidData)
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('required');
    });

    it('should validate provider is supported', async () => {
      const invalidData = {
        name: 'test-model',
        provider: 'unsupported-provider',
        enabled: true
      };

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidData)
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it('should reject duplicate model names', async () => {
      mockDb.models.create.mockRejectedValue(
        new Error('Unique constraint failed')
      );

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validModelData)
      });

      expect(response.status).toBe(409);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it('should handle database errors during creation', async () => {
      mockDb.models.create.mockRejectedValue(new Error('Database error'));

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validModelData)
      });

      expect(response.status).toBe(500);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it('should parse config JSON correctly', async () => {
      const modelWithConfig = {
        ...validModelData,
        config: JSON.stringify({ temperature: 0.5 })
      };

      const createdModel = {
        id: 4,
        ...validModelData,
        config: { temperature: 0.5 }
      };

      mockDb.models.create.mockResolvedValue(createdModel);

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modelWithConfig)
      });

      expect(response.status).toBe(201);
    });
  });

  describe('PUT /models/:id - Update Model', () => {
    it('should update an existing model', async () => {
      const updateData = {
        enabled: false,
        config: { temperature: 0.5 }
      };

      const updatedModel = {
        id: 1,
        name: 'gpt-4',
        provider: 'openai',
        ...updateData
      };

      mockDb.models.findUnique.mockResolvedValue(updatedModel);
      mockDb.models.update.mockResolvedValue(updatedModel);

      const response = await app.request('/models/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData)
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ success: true, data: updatedModel });
      expect(mockDb.models.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: updateData
      });
    });

    it('should return 404 when updating non-existent model', async () => {
      mockDb.models.findUnique.mockResolvedValue(null);

      const response = await app.request('/models/999', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false })
      });

      expect(response.status).toBe(404);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it('should validate update data', async () => {
      const invalidData = {
        provider: 'invalid-provider'
      };

      const response = await app.request('/models/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidData)
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it('should allow partial updates', async () => {
      const partialUpdate = { enabled: false };

      const existingModel = {
        id: 1,
        name: 'gpt-4',
        provider: 'openai',
        enabled: true,
        config: { temperature: 0.7 }
      };

      const updatedModel = { ...existingModel, enabled: false };

      mockDb.models.findUnique.mockResolvedValue(existingModel);
      mockDb.models.update.mockResolvedValue(updatedModel);

      const response = await app.request('/models/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partialUpdate)
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.data.enabled).toBe(false);
      expect(json.data.name).toBe('gpt-4');
    });

    it('should handle database errors during update', async () => {
      mockDb.models.findUnique.mockResolvedValue({ id: 1, name: 'gpt-4' });
      mockDb.models.update.mockRejectedValue(new Error('Database error'));

      const response = await app.request('/models/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false })
      });

      expect(response.status).toBe(500);
      const json = await response.json();
      expect(json.success).toBe(false);
    });
  });

  describe('DELETE /models/:id - Delete Model', () => {
    it('should delete a model successfully', async () => {
      const deletedModel = {
        id: 1,
        name: 'gpt-4',
        provider: 'openai'
      };

      mockDb.models.findUnique.mockResolvedValue(deletedModel);
      mockDb.models.delete.mockResolvedValue(deletedModel);

      const response = await app.request('/models/1', {
        method: 'DELETE'
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ success: true, message: 'Model deleted successfully' });
      expect(mockDb.models.delete).toHaveBeenCalledWith({
        where: { id: 1 }
      });
    });

    it('should return 404 when deleting non-existent model', async () => {
      mockDb.models.findUnique.mockResolvedValue(null);

      const response = await app.request('/models/999', {
        method: 'DELETE'
      });

      expect(response.status).toBe(404);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it('should handle database errors during deletion', async () => {
      mockDb.models.findUnique.mockResolvedValue({ id: 1, name: 'gpt-4' });
      mockDb.models.delete.mockRejectedValue(new Error('Database error'));

      const response = await app.request('/models/1', {
        method: 'DELETE'
      });

      expect(response.status).toBe(500);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it('should prevent deletion of system models', async () => {
      const systemModel = {
        id: 1,
        name: 'gpt-4',
        provider: 'openai',
        isSystem: true
      };

      mockDb.models.findUnique.mockResolvedValue(systemModel);

      const response = await app.request('/models/1', {
        method: 'DELETE'
      });

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('system model');
      expect(mockDb.models.delete).not.toHaveBeenCalled();
    });
  });

  describe('Authentication & Authorization', () => {
    it('should require authentication for model listing', async () => {
      const { verifySignature } = await import('../middleware/auth.js');
      vi.mocked(verifySignature).mockImplementationOnce((c, next) => {
        return c.json({ success: false, error: 'Unauthorized' }, 401);
      });

      const response = await app.request('/models', {
        method: 'GET'
      });

      expect(response.status).toBe(401);
    });

    it('should require admin role for model creation', async () => {
      const { requireRole } = await import('../middleware/auth.js');
      vi.mocked(requireRole).mockImplementationOnce((roles) => (c, next) => {
        return c.json({ success: false, error: 'Forbidden' }, 403);
      });

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test',
          provider: 'openai',
          enabled: true
        })
      });

      expect(response.status).toBe(403);
    });

    it('should require admin role for model updates', async () => {
      const { requireRole } = await import('../middleware/auth.js');
      vi.mocked(requireRole).mockImplementationOnce((roles) => (c, next) => {
        return c.json({ success: false, error: 'Forbidden' }, 403);
      });

      const response = await app.request('/models/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false })
      });

      expect(response.status).toBe(403);
    });

    it('should require admin role for model deletion', async () => {
      const { requireRole } = await import('../middleware/auth.js');
      vi.mocked(requireRole).mockImplementationOnce((roles) => (c, next) => {
        return c.json({ success: false, error: 'Forbidden' }, 403);
      });

      const response = await app.request('/models/1', {
        method: 'DELETE'
      });

      expect(response.status).toBe(403);
    });

    it('should log audit events for sensitive operations', async () => {
      const { logAudit } = await import('../middleware/auth.js');
      const logAuditSpy = vi.mocked(logAudit);

      mockDb.models.create.mockResolvedValue({
        id: 1,
        name: 'gpt-4',
        provider: 'openai',
        enabled: true
      });

      await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'gpt-4',
          provider: 'openai',
          enabled: true
        })
      });

      expect(logAuditSpy).toHaveBeenCalledWith('model.create');
    });
  });

  describe('Rate Limiting', () => {
    it('should respect rate limits for model listing', async () => {
      mockDb.models.findMany.mockResolvedValue([]);

      // Make multiple requests rapidly
      const requests = Array(100).fill(null).map(() =>
        app.request('/models', { method: 'GET' })
      );

      const responses = await Promise.all(requests);

      // Some requests should be rate limited
      const rateLimitedResponses = responses.filter(r => r.status === 429);
      expect(rateLimitedResponses.length).toBeGreaterThan(0);
    });

    it('should respect rate limits for model creation', async () => {
      mockDb.models.create.mockResolvedValue({
        id: 1,
        name: 'test',
        provider: 'openai',
        enabled: true
      });

      const requests = Array(50).fill(null).map(() =>
        app.request('/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'test',
            provider: 'openai',
            enabled: true
          })
        })
      );

      const responses = await Promise.all(requests);

      const rateLimitedResponses = responses.filter(r => r.status === 429);
      expect(rateLimitedResponses.length).toBeGreaterThan(0);
    });
  });

  describe('Input Validation', () => {
    it('should reject malformed JSON', async () => {
      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ invalid json }'
      });

      expect(response.status).toBe(400);
    });

    it('should sanitize model names', async () => {
      const maliciousName = '<script>alert("xss")</script>gpt-4';

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: maliciousName,
          provider: 'openai',
          enabled: true
        })
      });

      expect(response.status).toBe(400);
    });

    it('should validate config schema', async () => {
      const invalidConfig = {
        temperature: 'not-a-number',
        maxTokens: 'invalid'
      };

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test',
          provider: 'openai',
          enabled: true,
          config: invalidConfig
        })
      });

      expect(response.status).toBe(400);
    });

    it('should limit config object size', async () => {
      const largeConfig = {};
      for (let i = 0; i < 1000; i++) {
        largeConfig[`key${i}`] = 'x'.repeat(1000);
      }

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test',
          provider: 'openai',
          enabled: true,
          config: largeConfig
        })
      });

      expect(response.status).toBe(400);
    });
  });

  describe('Pagination', () => {
    it('should support pagination for model listing', async () => {
      const mockModels = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        name: `model-${i}`,
        provider: 'openai',
        enabled: true
      }));

      mockDb.models.findMany.mockResolvedValue(mockModels.slice(0, 20));

      const response = await app.request('/models?page=1&limit=20', {
        method: 'GET'
      });

      expect(response.status).toBe(200);
      expect(mockDb.models.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 20
        })
      );
    });

    it('should return pagination metadata', async () => {
      const mockModels = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        name: `model-${i}`,
        provider: 'openai',
        enabled: true
      }));

      mockDb.models.findMany.mockResolvedValue(mockModels.slice(0, 20));

      const response = await app.request('/models?page=1&limit=20', {
        method: 'GET'
      });

      const json = await response.json();
      expect(json.pagination).toBeDefined();
      expect(json.pagination.page).toBe(1);
      expect(json.pagination.limit).toBe(20);
      expect(json.pagination.total).toBe(50);
    });

    it('should handle page out of bounds', async () => {
      mockDb.models.findMany.mockResolvedValue([]);

      const response = await app.request('/models?page=1000&limit=20', {
        method: 'GET'
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.data).toEqual([]);
    });

    it('should validate pagination parameters', async () => {
      const response = await app.request('/models?page=-1&limit=0', {
        method: 'GET'
      });

      expect(response.status).toBe(400);
    });
  });

  describe('Caching', () => {
    it('should cache model list responses', async () => {
      mockDb.models.findMany
        .mockResolvedValueOnce([
          { id: 1, name: 'gpt-4', provider: 'openai' }
        ])
        .mockResolvedValueOnce([
          { id: 1, name: 'gpt-4', provider: 'openai' },
          { id: 2, name: 'claude-3', provider: 'anthropic' }
        ]);

      const response1 = await app.request('/models', { method: 'GET' });
      const response2 = await app.request('/models', { method: 'GET' });

      // Both should return the same data due to caching
      const json1 = await response1.json();
      const json2 = await response2.json();
      expect(json1.data).toEqual(json2.data);

      // Database should only be called once
      expect(mockDb.models.findMany).toHaveBeenCalledTimes(1);
    });

    it('should invalidate cache on model update', async () => {
      mockDb.models.findUnique.mockResolvedValue({
        id: 1,
        name: 'gpt-4',
        provider: 'openai',
        enabled: true
      });

      mockDb.models.update.mockResolvedValue({
        id: 1,
        name: 'gpt-4',
        provider: 'openai',
        enabled: false
      });

      await app.request('/models/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false })
      });

      // Cache should be invalidated
      mockDb.models.findMany.mockClear();
      mockDb.models.findMany.mockResolvedValue([
        { id: 1, name: 'gpt-4', provider: 'openai', enabled: false }
      ]);

      await app.request('/models', { method: 'GET' });

      expect(mockDb.models.findMany).toHaveBeenCalled();
    });
  });
});