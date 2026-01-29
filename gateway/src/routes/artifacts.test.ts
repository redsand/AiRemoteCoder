import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { Readable } from 'stream';
import { join, basename } from 'path';
import { artifactsRoutes } from './artifacts.js';
import { db } from '../services/database.js';
import { config } from '../config.js';
import { broadcastToRun } from '../services/websocket.js';

// Mock dependencies
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    createReadStream: vi.fn(),
    createWriteStream: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    statSync: vi.fn(),
  };
});

vi.mock('../services/database.js');
vi.mock('../config.js');
vi.mock('../services/websocket.js');

import { existsSync, createReadStream, createWriteStream, mkdirSync, unlinkSync, statSync } from 'fs';

describe('artifactsRoutes', () => {
  let fastify: ReturnType<typeof Fastify>;
  let testRunId: string;
  let testArtifactPath: string;

  beforeEach(async () => {
    fastify = Fastify();
    await fastify.register(artifactsRoutes);
    testRunId = 'test-run-123';
    testArtifactPath = join('/tmp', 'artifacts', testRunId);

    vi.clearAllMocks();
    
    // Default mock implementations
    vi.mocked(config).artifactsDir = '/tmp/artifacts';
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(unlinkSync).mockReturnValue(undefined);
  });

  afterEach(async () => {
    await fastify.close();
  });

  describe('GET /artifacts/:runId', () => {
    it('should list all artifacts for a run', async () => {
      const mockStat = {
        isFile: () => true,
        isDirectory: () => false,
        size: 1024,
        mtime: new Date('2024-01-01'),
      };
      vi.mocked(statSync).mockReturnValue(mockStat as any);
      vi.mocked(existsSync).mockReturnValue(true);

      // Mock database to return run info
      vi.mocked(db.getRun).mockResolvedValue({
        id: testRunId,
        status: 'completed',
        created_at: new Date(),
        updated_at: new Date(),
      } as any);

      const response = await fastify.inject({
        method: 'GET',
        url: `/artifacts/${testRunId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toBeInstanceOf(Array);
    });

    it('should return 404 if run does not exist', async () => {
      vi.mocked(db.getRun).mockResolvedValue(null);

      const response = await fastify.inject({
        method: 'GET',
        url: `/artifacts/nonexistent-run`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toHaveProperty('error', 'Run not found');
    });

    it('should return empty array if no artifacts directory exists', async () => {
      vi.mocked(db.getRun).mockResolvedValue({
        id: testRunId,
        status: 'completed',
        created_at: new Date(),
        updated_at: new Date(),
      } as any);
      vi.mocked(existsSync).mockReturnValue(false);

      const response = await fastify.inject({
        method: 'GET',
        url: `/artifacts/${testRunId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });
  });

  describe('GET /artifacts/:runId/:filename', () => {
    it('should download an artifact file', async () => {
      const mockStream = new Readable();
      mockStream._read = () => {};
      mockStream.push('test content');
      mockStream.push(null);

      vi.mocked(createReadStream).mockReturnValue(mockStream as any);
      vi.mocked(existsSync).mockReturnValue(true);

      const response = await fastify.inject({
        method: 'GET',
        url: `/artifacts/${testRunId}/test-file.txt`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.headers['content-disposition']).toContain('test-file.txt');
    });

    it('should return 404 if artifact file does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const response = await fastify.inject({
        method: 'GET',
        url: `/artifacts/${testRunId}/nonexistent.txt`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toHaveProperty('error', 'Artifact not found');
    });

    it('should set appropriate content-type based on file extension', async () => {
      const mockStream = new Readable();
      mockStream._read = () => {};
      mockStream.push('test');
      mockStream.push(null);

      vi.mocked(createReadStream).mockReturnValue(mockStream as any);
      vi.mocked(existsSync).mockReturnValue(true);

      const jsonResponse = await fastify.inject({
        method: 'GET',
        url: `/artifacts/${testRunId}/data.json`,
      });

      expect(jsonResponse.headers['content-type']).toContain('application/json');

      const htmlResponse = await fastify.inject({
        method: 'GET',
        url: `/artifacts/${testRunId}/page.html`,
      });

      expect(htmlResponse.headers['content-type']).toContain('text/html');
    });

    it('should handle file stream errors', async () => {
      const mockStream = new Readable();
      mockStream._read = () => {};
      mockStream.emit('error', new Error('Stream error'));

      vi.mocked(createReadStream).mockReturnValue(mockStream as any);
      vi.mocked(existsSync).mockReturnValue(true);

      const response = await fastify.inject({
        method: 'GET',
        url: `/artifacts/${testRunId}/error-file.txt`,
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    });
  });

  describe('POST /artifacts/:runId', () => {
    it('should upload an artifact file successfully', async () => {
      const mockWriteStream = {
        write: vi.fn((chunk, encoding, callback) => callback?.()),
        end: vi.fn((callback) => callback?.()),
        on: vi.fn(function(this: any, event: string, handler: any) {
          if (event === 'finish') {
            setTimeout(() => handler(), 10);
          }
          return this;
        }),
      } as any;

      vi.mocked(createWriteStream).mockReturnValue(mockWriteStream);
      vi.mocked(mkdirSync).mockReturnValue(undefined);
      vi.mocked(broadcastToRun).mockResolvedValue(undefined);

      const response = await fastify.inject({
        method: 'POST',
        url: `/artifacts/${testRunId}`,
        headers: {
          'content-type': 'multipart/form-data',
        },
        payload: {
          file: {
            filename: 'upload.txt',
            mimetype: 'text/plain',
            data: Buffer.from('test upload content'),
          },
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toHaveProperty('filename', 'upload.txt');
      expect(broadcastToRun).toHaveBeenCalledWith(testRunId, {
        type: 'artifact_uploaded',
        data: expect.objectContaining({
          filename: 'upload.txt',
        }),
      });
    });

    it('should create artifacts directory if it does not exist', async () => {
      const mockWriteStream = {
        write: vi.fn((chunk, encoding, callback) => callback?.()),
        end: vi.fn((callback) => callback?.()),
        on: vi.fn(function(this: any, event: string, handler: any) {
          if (event === 'finish') setTimeout(() => handler(), 10);
          return this;
        }),
      } as any;

      vi.mocked(createWriteStream).mockReturnValue(mockWriteStream);
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(mkdirSync).mockReturnValue(undefined);

      const response = await fastify.inject({
        method: 'POST',
        url: `/artifacts/${testRunId}`,
        headers: {
          'content-type': 'multipart/form-data',
        },
        payload: {
          file: {
            filename: 'new-file.txt',
            data: Buffer.from('content'),
          },
        },
      });

      expect(response.statusCode).toBe(201);
      expect(mkdirSync).toHaveBeenCalledWith(
        testArtifactPath,
        { recursive: true }
      );
    });

    it('should return 400 when no file is provided', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: `/artifacts/${testRunId}`,
        headers: {
          'content-type': 'multipart/form-data',
        },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty('error', 'No file uploaded');
    });

    it('should handle upload errors gracefully', async () => {
      const mockWriteStream = {
        write: vi.fn((chunk, encoding, callback) => {
          callback?.(new Error('Write error'));
        }),
        end: vi.fn(),
        on: vi.fn(function() { return this; }),
      } as any;

      vi.mocked(createWriteStream).mockReturnValue(mockWriteStream);

      const response = await fastify.inject({
        method: 'POST',
        url: `/artifacts/${testRunId}`,
        headers: {
          'content-type': 'multipart/form-data',
        },
        payload: {
          file: {
            filename: 'error.txt',
            data: Buffer.from('content'),
          },
        },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('should sanitize filenames to prevent directory traversal', async () => {
      const mockWriteStream = {
        write: vi.fn((chunk, encoding, callback) => callback?.()),
        end: vi.fn((callback) => callback?.()),
        on: vi.fn(function(this: any, event: string, handler: any) {
          if (event === 'finish') setTimeout(() => handler(), 10);
          return this;
        }),
      } as any;

      vi.mocked(createWriteStream).mockReturnValue(mockWriteStream);

      const response = await fastify.inject({
        method: 'POST',
        url: `/artifacts/${testRunId}`,
        headers: {
          'content-type': 'multipart/form-data',
        },
        payload: {
          file: {
            filename: '../../../malicious.txt',
            data: Buffer.from('content'),
          },
        },
      });

      expect(response.statusCode).toBe(201);
      // Should sanitize the filename
      expect(createWriteStream).toHaveBeenCalledWith(
        expect.not.stringContaining('../'),
        expect.anything()
      );
    });
  });

  describe('DELETE /artifacts/:runId/:filename', () => {
    it('should delete an artifact file successfully', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(unlinkSync).mockReturnValue(undefined);
      vi.mocked(broadcastToRun).mockResolvedValue(undefined);

      const response = await fastify.inject({
        method: 'DELETE',
        url: `/artifacts/${testRunId}/delete-me.txt`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty(
        'message',
        'Artifact deleted successfully'
      );
      expect(unlinkSync).toHaveBeenCalled();
      expect(broadcastToRun).toHaveBeenCalledWith(testRunId, {
        type: 'artifact_deleted',
        data: expect.objectContaining({
          filename: 'delete-me.txt',
        }),
      });
    });

    it('should return 404 if artifact file does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const response = await fastify.inject({
        method: 'DELETE',
        url: `/artifacts/${testRunId}/nonexistent.txt`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toHaveProperty('error', 'Artifact not found');
      expect(unlinkSync).not.toHaveBeenCalled();
    });

    it('should handle deletion errors', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(unlinkSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const response = await fastify.inject({
        method: 'DELETE',
        url: `/artifacts/${testRunId}/protected.txt`,
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.json()).toHaveProperty('error');
    });
  });

  describe('DELETE /artifacts/:runId', () => {
    it('should delete all artifacts for a run', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(unlinkSync).mockReturnValue(undefined);
      vi.mocked(broadcastToRun).mockResolvedValue(undefined);

      const response = await fastify.inject({
        method: 'DELETE',
        url: `/artifacts/${testRunId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty(
        'message',
        'All artifacts deleted successfully'
      );
      expect(broadcastToRun).toHaveBeenCalledWith(testRunId, {
        type: 'artifacts_cleared',
        data: { runId: testRunId },
      });
    });

    it('should return 404 if artifacts directory does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const response = await fastify.inject({
        method: 'DELETE',
        url: `/artifacts/${testRunId}`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toHaveProperty('error', 'Artifacts directory not found');
    });

    it('should handle errors when clearing all artifacts', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(unlinkSync).mockImplementation(() => {
        throw new Error('Directory not empty');
      });

      const response = await fastify.inject({
        method: 'DELETE',
        url: `/artifacts/${testRunId}`,
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.json()).toHaveProperty('error');
    });
  });

  describe('HEAD /artifacts/:runId/:filename', () => {
    it('should return artifact metadata without content', async () => {
      const mockStat = {
        isFile: () => true,
        size: 2048,
        mtime: new Date('2024-01-15T10:30:00Z'),
      };
      vi.mocked(statSync).mockReturnValue(mockStat as any);
      vi.mocked(existsSync).mockReturnValue(true);

      const response = await fastify.inject({
        method: 'HEAD',
        url: `/artifacts/${testRunId}/metadata.txt`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-length']).toBe('2048');
      expect(response.payload).toBe('');
    });

    it('should return 404 for non-existent artifact', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const response = await fastify.inject({
        method: 'HEAD',
        url: `/artifacts/${testRunId}/missing.txt`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Rate limiting and security', () => {
    it('should enforce rate limits on artifact uploads', async () => {
      // Assuming rate limit is configured
      const mockWriteStream = {
        write: vi.fn((chunk, encoding, callback) => callback?.()),
        end: vi.fn((callback) => callback?.()),
        on: vi.fn(function(this: any, event: string, handler: any) {
          if (event === 'finish') setTimeout(() => handler(), 10);
          return this;
        }),
      } as any;

      vi.mocked(createWriteStream).mockReturnValue(mockWriteStream);

      // Make multiple rapid requests
      const requests = Array(20).fill(null).map(() =>
        fastify.inject({
          method: 'POST',
          url: `/artifacts/${testRunId}`,
          headers: { 'content-type': 'multipart/form-data' },
          payload: {
            file: {
              filename: 'test.txt',
              data: Buffer.from('content'),
            },
          },
        })
      );

      const responses = await Promise.all(requests);
      const rateLimitedResponses = responses.filter(
        (r) => r.statusCode === 429
      );

      // At least some requests should be rate limited
      expect(rateLimitedResponses.length).toBeGreaterThan(0);
    });

    it('should validate file size limits', async () => {
      const largeFile = Buffer.alloc(100 * 1024 * 1024); // 100MB

      const response = await fastify.inject({
        method: 'POST',
        url: `/artifacts/${testRunId}`,
        headers: {
          'content-type': 'multipart/form-data',
        },
        payload: {
          file: {
            filename: 'large.bin',
            data: largeFile,
          },
        },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.json()).toHaveProperty('error');
    });
  });

  describe('WebSocket integration', () => {
    it('should broadcast artifact upload events', async () => {
      const mockWriteStream = {
        write: vi.fn((chunk, encoding, callback) => callback?.()),
        end: vi.fn((callback) => callback?.()),
        on: vi.fn(function(this: any, event: string, handler: any) {
          if (event === 'finish') setTimeout(() => handler(), 10);
          return this;
        }),
      } as any;

      vi.mocked(createWriteStream).mockReturnValue(mockWriteStream);
      vi.mocked(broadcastToRun).mockResolvedValue(undefined);

      await fastify.inject({
        method: 'POST',
        url: `/artifacts/${testRunId}`,
        headers: { 'content-type': 'multipart/form-data' },
        payload: {
          file: {
            filename: 'broadcast.txt',
            data: Buffer.from('test'),
          },
        },
      });

      expect(broadcastToRun).toHaveBeenCalledWith(testRunId, {
        type: 'artifact_uploaded',
        data: expect.objectContaining({
          filename: 'broadcast.txt',
          runId: testRunId,
          timestamp: expect.any(String),
        }),
      });
    });

    it('should broadcast artifact deletion events', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(unlinkSync).mockReturnValue(undefined);
      vi.mocked(broadcastToRun).mockResolvedValue(undefined);

      await fastify.inject({
        method: 'DELETE',
        url: `/artifacts/${testRunId}/delete.txt`,
      });

      expect(broadcastToRun).toHaveBeenCalledWith(testRunId, {
        type: 'artifact_deleted',
        data: expect.objectContaining({
          filename: 'delete.txt',
          runId: testRunId,
        }),
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle special characters in filenames', async () => {
      const mockStream = new Readable();
      mockStream._read = () => {};
      mockStream.push('test');
      mockStream.push(null);

      vi.mocked(createReadStream).mockReturnValue(mockStream as any);
      vi.mocked(existsSync).mockReturnValue(true);

      const response = await fastify.inject({
        method: 'GET',
        url: `/artifacts/${testRunId}/file with spaces & special@chars.txt`,
      });

      expect(response.statusCode).toBe(200);
    });

    it('should handle very long filenames', async () => {
      const longFilename = 'a'.repeat(255) + '.txt';
      const mockStream = new Readable();
      mockStream._read = () => {};
      mockStream.push('test');
      mockStream.push(null);

      vi.mocked(createReadStream).mockReturnValue(mockStream as any);
      vi.mocked(existsSync).mockReturnValue(true);

      const response = await fastify.inject({
        method: 'GET',
        url: `/artifacts/${testRunId}/${encodeURIComponent(longFilename)}`,
      });

      expect([200, 400, 414]).toContain(response.statusCode);
    });

    it('should handle concurrent uploads', async () => {
      const mockWriteStream = {
        write: vi.fn((chunk, encoding, callback) => callback?.()),
        end: vi.fn((callback) => callback?.()),
        on: vi.fn(function(this: any, event: string, handler: any) {
          if (event === 'finish') setTimeout(() => handler(), 10);
          return this;
        }),
      } as any;

      vi.mocked(createWriteStream).mockReturnValue(mockWriteStream);

      const concurrentUploads = Array(5).fill(null).map((_, i) =>
        fastify.inject({
          method: 'POST',
          url: `/artifacts/${testRunId}`,
          headers: { 'content-type': 'multipart/form-data' },
          payload: {
            file: {
              filename: `concurrent-${i}.txt`,
              data: Buffer.from(`content ${i}`),
            },
          },
        })
      );

      const responses = await Promise.all(concurrentUploads);
      responses.forEach((response) => {
        expect(response.statusCode).toBe(201);
      });
    });
  });
});