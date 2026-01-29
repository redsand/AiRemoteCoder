import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { modelsRouter } from './models.js';
import { verifySignature } from '../middleware/auth.js';

// Mock the auth middleware
vi.mock('../middleware/auth.js', () => ({
  verifySignature: vi.fn((c, next) => next())
}));

// Mock database
const mockDb = {
  models: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  },
  providers: {
    findMany: vi.fn(),
    findUnique: vi.fn()
  }
};

// Mock Prisma client
vi.mock('../lib/db.js', () => ({
  default: mockDb
}));

describe('Models Router', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.route('/models', modelsRouter);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /models', () => {
    it('should return list of models with pagination', async () => {
      const mockModels = [
        {
          id: 'model-1',
          name: 'gpt-4',
          provider: { id: 'prov-1', name: 'OpenAI' },
          contextWindow: 8192,
          maxTokens: 4096,
          inputPrice: 0.03,
          outputPrice: 0.06,
          capabilities: ['chat', 'completion'],
          isActive: true,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01')
        },
        {
          id: 'model-2',
          name: 'claude-3-opus',
          provider: { id: 'prov-2', name: 'Anthropic' },
          contextWindow: 200000,
          maxTokens: 4096,
          inputPrice: 0.015,
          outputPrice: 0.075,
          capabilities: ['chat', 'vision'],
          isActive: true,
          createdAt: new Date('2024-01-02'),
          updatedAt: new Date('2024-01-02')
        }
      ];

      mockDb.models.findMany.mockResolvedValue(mockModels);

      const response = await app.request('/models?page=1&limit=10');
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({
        success: true,
        data: mockModels,
        pagination: {
          page: 1,
          limit: 10,
          total: 2
        }
      });
      expect(mockDb.models.findMany).toHaveBeenCalledWith({
        include: { provider: true },
        where: { isActive: true },
        skip: 0,
        take: 10,
        orderBy: { name: 'asc' }
      });
    });

    it('should filter models by provider', async () => {
      const mockModels = [
        {
          id: 'model-1',
          name: 'gpt-4',
          provider: { id: 'prov-1', name: 'OpenAI' },
          contextWindow: 8192,
          maxTokens: 4096,
          inputPrice: 0.03,
          outputPrice: 0.06,
          capabilities: ['chat'],
          isActive: true,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01')
        }
      ];

      mockDb.models.findMany.mockResolvedValue(mockModels);
      mockDb.providers.findUnique.mockResolvedValue({ id: 'prov-1', name: 'OpenAI' });

      const response = await app.request('/models?provider=OpenAI');
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
      expect(mockDb.models.findMany).toHaveBeenCalledWith({
        include: { provider: true },
        where: { isActive: true, providerId: 'prov-1' },
        skip: 0,
        take: 10,
        orderBy: { name: 'asc' }
      });
    });

    it('should filter models by capability', async () => {
      const mockModels = [
        {
          id: 'model-1',
          name: 'gpt-4-vision',
          provider: { id: 'prov-1', name: 'OpenAI' },
          contextWindow: 128000,
          maxTokens: 4096,
          inputPrice: 0.01,
          outputPrice: 0.03,
          capabilities: ['chat', 'vision'],
          isActive: true,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01')
        }
      ];

      mockDb.models.findMany.mockResolvedValue(mockModels);

      const response = await app.request('/models?capability=vision');
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data[0].capabilities).toContain('vision');
    });

    it('should handle empty model list', async () => {
      mockDb.models.findMany.mockResolvedValue([]);

      const response = await app.request('/models');
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toEqual([]);
      expect(data.pagination.total).toBe(0);
    });

    it('should validate pagination parameters', async () => {
      const response = await app.request('/models?page=-1&limit=0');
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain('validation');
    });

    it('should use default pagination values', async () => {
      mockDb.models.findMany.mockResolvedValue([]);

      await app.request('/models');

      expect(mockDb.models.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 10
        })
      );
    });

    it('should handle database errors', async () => {
      mockDb.models.findMany.mockRejectedValue(new Error('Database connection failed'));

      const response = await app.request('/models');
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain('Internal server error');
    });
  });

  describe('GET /models/:id', () => {
    it('should return model metadata by ID', async () => {
      const mockModel = {
        id: 'model-1',
        name: 'gpt-4',
        displayName: 'GPT-4',
        provider: { id: 'prov-1', name: 'OpenAI' },
        description: 'Most capable GPT-4 model',
        contextWindow: 8192,
        maxTokens: 4096,
        inputPrice: 0.03,
        outputPrice: 0.06,
        capabilities: ['chat', 'completion', 'function-calling'],
        supportsStreaming: true,
        supportsJsonMode: true,
        isActive: true,
        config: {
          temperature: { min: 0, max: 2, default: 1 },
          topP: { min: 0, max: 1, default: 1 },
          maxTokens: { min: 1, max: 4096, default: 2048 }
        },
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01')
      };

      mockDb.models.findUnique.mockResolvedValue(mockModel);

      const response = await app.request('/models/model-1');
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({
        success: true,
        data: mockModel
      });
      expect(mockDb.models.findUnique).toHaveBeenCalledWith({
        where: { id: 'model-1' },
        include: { provider: true }
      });
    });

    it('should return 404 for non-existent model', async () => {
      mockDb.models.findUnique.mockResolvedValue(null);

      const response = await app.request('/models/non-existent');
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error).toContain('not found');
    });

    it('should validate model ID format', async () => {
      const response = await app.request('/models/invalid-id-format!');
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
    });

    it('should handle database errors gracefully', async () => {
      mockDb.models.findUnique.mockRejectedValue(new Error('Query timeout'));

      const response = await app.request('/models/model-1');
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
    });
  });

  describe('POST /models', () => {
    it('should create a new model with valid data', async () => {
      const newModelData = {
        name: 'gpt-4-turbo',
        displayName: 'GPT-4 Turbo',
        providerId: 'prov-1',
        description: 'Faster version of GPT-4',
        contextWindow: 128000,
        maxTokens: 4096,
        inputPrice: 0.01,
        outputPrice: 0.03,
        capabilities: ['chat', 'vision', 'function-calling'],
        supportsStreaming: true,
        supportsJsonMode: true,
        config: {
          temperature: { min: 0, max: 2, default: 1 },
          topP: { min: 0, max: 1, default: 1 }
        }
      };

      const createdModel = {
        id: 'model-3',
        ...newModelData,
        isActive: true,
        createdAt: new Date('2024-01-03'),
        updatedAt: new Date('2024-01-03')
      };

      mockDb.models.create.mockResolvedValue(createdModel);
      mockDb.providers.findUnique.mockResolvedValue({ id: 'prov-1', name: 'OpenAI' });

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newModelData)
      });

      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
      expect(data.data).toEqual(createdModel);
      expect(mockDb.models.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'gpt-4-turbo',
          providerId: 'prov-1'
        })
      });
    });

    it('should validate required fields', async () => {
      const invalidModel = {
        name: 'test-model'
        // Missing required fields
      };

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidModel)
      });

      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain('validation');
    });

    it('should validate model name format', async () => {
      const invalidModel = {
        name: 'Invalid Name!',
        providerId: 'prov-1',
        contextWindow: 8192,
        maxTokens: 4096
      };

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidModel)
      });

      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
    });

    it('should validate numeric ranges', async () => {
      const invalidModel = {
        name: 'test-model',
        providerId: 'prov-1',
        contextWindow: -100,
        maxTokens: 0,
        inputPrice: -0.01,
        outputPrice: 'invalid'
      };

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidModel)
      });

      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
    });

    it('should validate capabilities array', async () => {
      const invalidModel = {
        name: 'test-model',
        providerId: 'prov-1',
        capabilities: 'not-an-array'
      };

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidModel)
      });

      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
    });

    it('should reject duplicate model names', async () => {
      const newModelData = {
        name: 'gpt-4',
        providerId: 'prov-1',
        contextWindow: 8192,
        maxTokens: 4096
      };

      mockDb.models.create.mockRejectedValue(
        new Error('Unique constraint failed on the fields: (name)')
      );

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newModelData)
      });

      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.success).toBe(false);
      expect(data.error).toContain('already exists');
    });

    it('should validate provider exists', async () => {
      const newModelData = {
        name: 'test-model',
        providerId: 'non-existent',
        contextWindow: 8192,
        maxTokens: 4096
      };

      mockDb.providers.findUnique.mockResolvedValue(null);

      const response = await app.request('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newModelData)
      });

      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain('provider');
    });
  });

  describe('PUT /models/:id', () => {
    it('should update an existing model', async () => {
      const updateData = {
        displayName: 'GPT-4 Updated',
        description: 'Updated description',
        inputPrice: 0.025,
        outputPrice: 0.05
      };

      const updatedModel = {
        id: 'model-1',
        name: 'gpt-4',
        displayName: 'GPT-4 Updated',
        provider: { id: 'prov-1', name: 'OpenAI' },
        description: 'Updated description',
        contextWindow: 8192,
        maxTokens: 4096,
        inputPrice: 0.025,
        outputPrice: 0.05,
        capabilities: ['chat'],
        isActive: true,
        updatedAt: new Date('2024-01-15')
      };

      mockDb.models.findUnique.mockResolvedValue(updatedModel);
      mockDb.models.update.mockResolvedValue(updatedModel);

      const response = await app.request('/models/model-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData)
      });

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toEqual(updatedModel);
      expect(mockDb.models.update).toHaveBeenCalledWith({
        where: { id: 'model-1' },
        data: updateData
      });
    });

    it('should return 404 when updating non-existent model', async () => {
      mockDb.models.findUnique.mockResolvedValue(null);

      const response = await app.request('/models/non-existent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Updated' })
      });

      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
    });

    it('should prevent updating model name', async () => {
      const response = await app.request('/models/model-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'new-name' })
      });

      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain('cannot be changed');
    });

    it('should validate update data', async () => {
      const response = await app.request('/models/model-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextWindow: 'invalid' })
      });

      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
    });
  });

  describe('DELETE /models/:id', () => {
    it('should soft delete a model', async () => {
      const deactivatedModel = {
        id: 'model-1',
        name: 'gpt-4',
        isActive: false,
        updatedAt: new Date('2024-01-15')
      };

      mockDb.models.findUnique.mockResolvedValue({ id: 'model-1', isActive: true });
      mockDb.models.update.mockResolvedValue(deactivatedModel);

      const response = await app.request('/models/model-1', {
        method: 'DELETE'
      });

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockDb.models.update).toHaveBeenCalledWith({
        where: { id: 'model-1' },
        data: { isActive: false }
      });
    });

    it('should return 404 for non-existent model', async () => {
      mockDb.models.findUnique.mockResolvedValue(null);

      const response = await app.request('/models/non-existent', {
        method: 'DELETE'
      });

      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
    });

    it('should handle already deleted model', async () => {
      mockDb.models.findUnique.mockResolvedValue({ id: 'model-1', isActive: false });

      const response = await app.request('/models/model-1', {
        method: 'DELETE'
      });

      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain('already inactive');
    });
  });

  describe('Schema Validation', () => {
    it('should validate model object structure', async () => {
      const mockModel = {
        id: 'model-1',
        name: 'gpt-4',
        displayName: 'GPT-4',
        provider: { id: 'prov-1', name: 'OpenAI' },
        contextWindow: 8192,
        maxTokens: 4096,
        inputPrice: 0.03,
        outputPrice: 0.06,
        capabilities: ['chat', 'completion'],
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      mockDb.models.findUnique.mockResolvedValue(mockModel);

      const response = await app.request('/models/model-1');
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        provider: expect.objectContaining({
          id: expect.any(String),
          name: expect.any(String)
        }),
        contextWindow: expect.any(Number),
        maxTokens: expect.any(Number),
        inputPrice: expect.any(Number),
        outputPrice: expect.any(Number),
        capabilities: expect.any(Array),
        isActive: expect.any(Boolean)
      });
    });

    it('should validate config schema', async () => {
      const mockModel = {
        id: 'model-1',
        name: 'gpt-4',
        provider: { id: 'prov-1', name: 'OpenAI' },
        config: {
          temperature: { min: 0, max: 2, default: 1 },
          topP: { min: 0, max: 1, default: 1 },
          maxTokens: { min: 1, max: 4096, default: 2048 }
        }
      };

      mockDb.models.findUnique.mockResolvedValue(mockModel);

      const response = await app.request('/models/model-1');
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.config).toMatchObject({
        temperature: expect.objectContaining({
          min: expect.any(Number),
          max: expect.any(Number),
          default: expect.any(Number)
        }),
        topP: expect.objectContaining({
          min: expect.any(Number),
          max: expect.any(Number),
          default: expect.any(Number)
        }),
        maxTokens: expect.objectContaining({
          min: expect.any(Number),
          max: expect.any(Number),
          default: expect.any(Number)
        })
      });
    });

    it('should validate capability enum values', async () => {
      const validCapabilities = ['chat', 'completion', 'vision', 'function-calling', 'embedding', 'json-mode'];
      
      const mockModel = {
        id: 'model-1',
        name: 'gpt-4',
        provider: { id: 'prov-1', name: 'OpenAI' },
        capabilities: validCapabilities
      };

      mockDb.models.findUnique.mockResolvedValue(mockModel);

      const response = await app.request('/models/model-1');
      const data = await response.json();

      expect(response.status).toBe(200);
      data.data.capabilities.forEach(cap => {
        expect(validCapabilities).toContain(cap);
      });
    });
  });

  describe('Response Formats', () => {
    it('should return consistent error response format', async () => {
      mockDb.models.findMany.mockRejectedValue(new Error('Database error'));

      const response = await app.request('/models');
      const data = await response.json();

      expect(data).toMatchObject({
        success: false,
        error: expect.any(String)
      });
    });

    it('should return consistent success response format', async () => {
      const mockModels = [{ id: 'model-1', name: 'gpt-4', provider: { id: 'prov-1', name: 'OpenAI' } }];
      mockDb.models.findMany.mockResolvedValue(mockModels);

      const response = await app.request('/models');
      const data = await response.json();

      expect(data).toMatchObject({
        success: true,
        data: expect.any(Array),
        pagination: expect.objectContaining({
          page: expect.any(Number),
          limit: expect.any(Number),
          total: expect.any(Number)
        })
      });
    });
  });
});