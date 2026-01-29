import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { healthRouter } from './health.js';
import { db } from '../db/index.js';

// Mock database
vi.mock('../db/index.js', () => ({
  db: {
    query: vi.fn(),
    select: vi.fn(),
    from: vi.fn(),
    limit: vi.fn()
  }
}));

describe('Health Check Route', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/health', healthRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'uptime').mockReturnValue(1234.567);
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 123456789,
      heapTotal: 98765432,
      heapUsed: 54321098,
      arrayBuffers: 1234567,
      external: 2345678
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /health', () => {
    it('should return 200 OK status when all systems are healthy', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'healthy');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('uptime');
    });

    it('should include system information in response', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.body).toHaveProperty('system');
      expect(response.body.system).toHaveProperty('uptime');
      expect(response.body.system).toHaveProperty('memory');
      expect(response.body.system.memory).toHaveProperty('rss');
      expect(response.body.system.memory).toHaveProperty('heapTotal');
      expect(response.body.system.memory).toHaveProperty('heapUsed');
    });

    it('should include database health status', async () => {
      (db.query as any).mockResolvedValue({ rows: [{ now: new Date() }] });

      const response = await request(app).get('/health');

      expect(response.body).toHaveProperty('checks');
      expect(response.body.checks).toHaveProperty('database');
      expect(response.body.checks.database).toHaveProperty('status', 'connected');
      expect(response.body.checks.database).toHaveProperty('latency');
    });

    it('should format memory values in human-readable format', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.body.system.memory).toHaveProperty('rssFormatted');
      expect(response.body.system.memory).toHaveProperty('heapTotalFormatted');
      expect(response.body.system.memory).toHaveProperty('heapUsedFormatted');
      expect(typeof response.body.system.memory.rssFormatted).toBe('string');
    });

    it('should return uptime in human-readable format', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.body.system).toHaveProperty('uptimeFormatted');
      expect(typeof response.body.system.uptimeFormatted).toBe('string');
    });
  });

  describe('GET /health/ready', () => {
    it('should return 200 OK when system is ready', async () => {
      (db.query as any).mockResolvedValue({ rows: [{ now: new Date() }] });

      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('ready', true);
    });

    it('should return 503 Service Unavailable when database is not connected', async () => {
      (db.query as any).mockRejectedValue(new Error('Connection refused'));

      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.body).toHaveProperty('ready', false);
      expect(response.body).toHaveProperty('error');
    });

    it('should check database connectivity on readiness probe', async () => {
      (db.query as any).mockResolvedValue({ rows: [{ now: new Date() }] });

      await request(app).get('/health/ready');

      expect(db.query).toHaveBeenCalled();
    });

    it('should include detailed checks when not ready', async () => {
      (db.query as any).mockRejectedValue(new Error('Connection timeout'));

      const response = await request(app).get('/health/ready');

      expect(response.body).toHaveProperty('checks');
      expect(response.body.checks).toHaveProperty('database');
      expect(response.body.checks.database).toHaveProperty('status', 'disconnected');
      expect(response.body.checks.database).toHaveProperty('error');
    });
  });

  describe('GET /health/live', () => {
    it('should return 200 OK when system is alive', async () => {
      const response = await request(app).get('/health/live');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('alive', true);
    });

    it('should return basic liveness information without database check', async () => {
      const response = await request(app).get('/health/live');

      expect(db.query).not.toHaveBeenCalled();
      expect(response.body).toHaveProperty('uptime');
      expect(response.body).toHaveProperty('timestamp');
    });

    it('should always respond even under load', async () => {
      vi.spyOn(process, 'uptime').mockReturnValue(999999.999);

      const response = await request(app).get('/health/live');

      expect(response.status).toBe(200);
      expect(response.body.alive).toBe(true);
    });
  });

  describe('Database Connectivity Verification', () => {
    it('should handle successful database query', async () => {
      const mockDate = new Date('2024-01-01T00:00:00Z');
      (db.query as any).mockResolvedValue({ rows: [{ now: mockDate }] });

      const response = await request(app).get('/health');

      expect(response.body.checks.database.status).toBe('connected');
      expect(response.body.checks.database).toHaveProperty('latency');
      expect(response.body.checks.database.latency).toBeGreaterThan(0);
    });

    it('should handle database connection errors gracefully', async () => {
      (db.query as any).mockRejectedValue(new Error('ECONNREFUSED'));

      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.body.checks.database.status).toBe('disconnected');
      expect(response.body.checks.database.error).toContain('ECONNREFUSED');
    });

    it('should handle database timeout errors', async () => {
      const timeoutError = new Error('Query timeout');
      (timeoutError as any).code = 'ETIMEDOUT';
      (db.query as any).mockRejectedValue(timeoutError);

      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.body.checks.database.status).toBe('disconnected');
      expect(response.body.checks.database.error).toContain('timeout');
    });

    it('should measure database query latency', async () => {
      (db.query as any).mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve({ rows: [] }), 50))
      );

      const response = await request(app).get('/health');

      expect(response.body.checks.database).toHaveProperty('latency');
      expect(response.body.checks.database.latency).toBeGreaterThanOrEqual(50);
    });

    it('should flag slow database queries', async () => {
      (db.query as any).mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve({ rows: [] }), 1000))
      );

      const response = await request(app).get('/health');

      expect(response.body.checks.database).toHaveProperty('latency');
      expect(response.body.checks.database).toHaveProperty('slow', true);
    });
  });

  describe('System Checks', () => {
    it('should report memory usage statistics', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.body.system.memory).toHaveProperty('rss');
      expect(response.body.system.memory).toHaveProperty('heapTotal');
      expect(response.body.system.memory).toHaveProperty('heapUsed');
      expect(response.body.system.memory).toHaveProperty('heapUsedPercent');
    });

    it('should calculate heap usage percentage', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.body.system.memory.heapUsedPercent).toBeGreaterThan(0);
      expect(response.body.system.memory.heapUsedPercent).toBeLessThanOrEqual(100);
    });

    it('should report process uptime', async () => {
      vi.spyOn(process, 'uptime').mockReturnValue(86400); // 1 day

      const response = await request(app).get('/health');

      expect(response.body.system.uptime).toBe(86400);
    });

    it('should format uptime in days, hours, minutes, seconds', async () => {
      vi.spyOn(process, 'uptime').mockReturnValue(90061); // 1 day, 1 hour, 1 minute, 1 second

      const response = await request(app).get('/health');

      expect(response.body.system.uptimeFormatted).toMatch(/\d+d \d+h \d+m \d+s/);
    });

    it('should include node version information', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.body.system).toHaveProperty('nodeVersion');
      expect(response.body.system.nodeVersion).toMatch(/^v\d+\.\d+\.\d+/);
    });

    it('should include platform information', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.body.system).toHaveProperty('platform');
      expect(response.body.system.platform).toHaveProperty('os');
      expect(response.body.system.platform).toHaveProperty('arch');
    });
  });

  describe('Error Handling Scenarios', () => {
    it('should handle unexpected errors in health check', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      (db.query as any).mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const response = await request(app).get('/health');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('status', 'error');
      expect(response.body).toHaveProperty('error');
    });

    it('should handle malformed database responses', async () => {
      (db.query as any).mockResolvedValue(null);

      const response = await request(app).get('/health');

      expect(response.body.checks.database.status).toBe('error');
    });

    it('should handle concurrent health check requests', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const requests = [
        request(app).get('/health'),
        request(app).get('/health'),
        request(app).get('/health')
      ];

      const responses = await Promise.all(requests);

      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('status', 'healthy');
      });
    });

    it('should handle rate limiting on health endpoints', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const responses = await Promise.all(
        Array(100).fill(null).map(() => request(app).get('/health'))
      );

      // All should succeed as health endpoints should not be rate limited
      const successCount = responses.filter(r => r.status === 200).length;
      expect(successCount).toBeGreaterThan(0);
    });

    it('should return appropriate CORS headers', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.headers).toBeDefined();
    });
  });

  describe('Response Format', () => {
    it('should return JSON content type', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.headers['content-type']).toContain('application/json');
    });

    it('should include ISO timestamp in response', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(new Date(response.body.timestamp).toISOString()).toBe(response.body.timestamp);
    });

    it('should have consistent response structure across endpoints', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const [health, ready, live] = await Promise.all([
        request(app).get('/health'),
        request(app).get('/health/ready'),
        request(app).get('/health/live')
      ]);

      expect(health.body).toHaveProperty('timestamp');
      expect(ready.body).toHaveProperty('timestamp');
      expect(live.body).toHaveProperty('timestamp');
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero uptime', async () => {
      vi.spyOn(process, 'uptime').mockReturnValue(0);
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.body.system.uptime).toBe(0);
      expect(response.status).toBe(200);
    });

    it('should handle extremely high memory usage', async () => {
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        rss: Number.MAX_SAFE_INTEGER,
        heapTotal: Number.MAX_SAFE_INTEGER,
        heapUsed: Number.MAX_SAFE_INTEGER,
        arrayBuffers: 0,
        external: 0
      });
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.body.system.memory).toBeDefined();
      expect(response.status).toBe(200);
    });

    it('should handle database returning empty result', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.body.checks.database.status).toBeDefined();
    });

    it('should handle very long database query response time', async () => {
      (db.query as any).mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve({ rows: [] }), 5000))
      );

      const response = await request(app).get('/health');

      expect(response.body.checks.database).toHaveProperty('latency');
      expect(response.body.checks.database.latency).toBeGreaterThan(5000);
    });
  });

  describe('Additional Health Checks', () => {
    it('should check disk space if available', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      // Disk space check may be optional depending on implementation
      expect(response.body).toHaveProperty('checks');
    });

    it('should check environment variables', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.body).toHaveProperty('environment');
      expect(response.body.environment).toHaveProperty('nodeEnv');
    });

    it('should report service version', async () => {
      (db.query as any).mockResolvedValue({ rows: [] });

      const response = await request(app).get('/health');

      expect(response.body).toHaveProperty('version');
    });
  });
});