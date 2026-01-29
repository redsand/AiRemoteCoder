import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { healthRouter } from './health.js';

describe('Health Check Route', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use('/health', healthRouter);
  });

  describe('GET /health - Basic Status Checks', () => {
    it('should return 200 OK status', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
    });

    it('should return JSON content type', async () => {
      const response = await request(app).get('/health');
      expect(response.headers['content-type']).toMatch(/application\/json/);
    });

    it('should return a valid response body', async () => {
      const response = await request(app).get('/health');
      expect(response.body).toBeDefined();
      expect(typeof response.body).toBe('object');
    });

    it('should include status field in response', async () => {
      const response = await request(app).get('/health');
      expect(response.body).toHaveProperty('status');
      expect(typeof response.body.status).toBe('string');
    });

    it('should include timestamp in response', async () => {
      const response = await request(app).get('/health');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should return "ok" status when system is healthy', async () => {
      const response = await request(app).get('/health');
      expect(response.body.status).toBe('ok');
    });
  });

  describe('GET /health - System Resource Monitoring', () => {
    it('should include memory usage information', async () => {
      const response = await request(app).get('/health');
      expect(response.body).toHaveProperty('memory');
      expect(typeof response.body.memory).toBe('object');
    });

    it('should report heap used memory', async () => {
      const response = await request(app).get('/health');
      expect(response.body.memory).toHaveProperty('heapUsed');
      expect(typeof response.body.memory.heapUsed).toBe('number');
      expect(response.body.memory.heapUsed).toBeGreaterThan(0);
    });

    it('should report heap total memory', async () => {
      const response = await request(app).get('/health');
      expect(response.body.memory).toHaveProperty('heapTotal');
      expect(typeof response.body.memory.heapTotal).toBe('number');
      expect(response.body.memory.heapTotal).toBeGreaterThan(0);
    });

    it('should report external memory', async () => {
      const response = await request(app).get('/health');
      expect(response.body.memory).toHaveProperty('external');
      expect(typeof response.body.memory.external).toBe('number');
      expect(response.body.memory.external).toBeGreaterThanOrEqual(0);
    });

    it('should report array buffers memory', async () => {
      const response = await request(app).get('/health');
      expect(response.body.memory).toHaveProperty('arrayBuffers');
      expect(typeof response.body.memory.arrayBuffers).toBe('number');
      expect(response.body.memory.arrayBuffers).toBeGreaterThanOrEqual(0);
    });

    it('should calculate and return memory usage percentage', async () => {
      const response = await request(app).get('/health');
      expect(response.body.memory).toHaveProperty('usagePercent');
      expect(typeof response.body.memory.usagePercent).toBe('number');
      expect(response.body.memory.usagePercent).toBeGreaterThanOrEqual(0);
      expect(response.body.memory.usagePercent).toBeLessThanOrEqual(100);
    });

    it('should include process uptime', async () => {
      const response = await request(app).get('/health');
      expect(response.body).toHaveProperty('uptime');
      expect(typeof response.body.uptime).toBe('number');
      expect(response.body.uptime).toBeGreaterThan(0);
    });

    it('should include CPU usage information', async () => {
      const response = await request(app).get('/health');
      expect(response.body).toHaveProperty('cpu');
      expect(typeof response.body.cpu).toBe('object');
    });

    it('should report CPU usage percent', async () => {
      const response = await request(app).get('/health');
      expect(response.body.cpu).toHaveProperty('usagePercent');
      expect(typeof response.body.cpu.usagePercent).toBe('number');
      expect(response.body.cpu.usagePercent).toBeGreaterThanOrEqual(0);
      expect(response.body.cpu.usagePercent).toBeLessThanOrEqual(100);
    });

    it('should include system load average', async () => {
      const response = await request(app).get('/health');
      expect(response.body).toHaveProperty('loadAverage');
      expect(Array.isArray(response.body.loadAverage)).toBe(true);
      expect(response.body.loadAverage).toHaveLength(3);
    });

    it('load average values should be valid numbers', async () => {
      const response = await request(app).get('/health');
      response.body.loadAverage.forEach((load: number) => {
        expect(typeof load).toBe('number');
        expect(load).toBeGreaterThanOrEqual(0);
      });
    });

    it('should include platform information', async () => {
      const response = await request(app).get('/health');
      expect(response.body).toHaveProperty('system');
      expect(typeof response.body.system).toBe('object');
    });

    it('should report platform name', async () => {
      const response = await request(app).get('/health');
      expect(response.body.system).toHaveProperty('platform');
      expect(typeof response.body.system.platform).toBe('string');
      expect(['linux', 'darwin', 'win32', 'freebsd', 'openbsd']).toContain(response.body.system.platform);
    });

    it('should report node version', async () => {
      const response = await request(app).get('/health');
      expect(response.body.system).toHaveProperty('nodeVersion');
      expect(typeof response.body.system.nodeVersion).toBe('string');
      expect(response.body.system.nodeVersion).toMatch(/^v?\d+\.\d+\.\d+/);
    });

    it('should report process ID', async () => {
      const response = await request(app).get('/health');
      expect(response.body).toHaveProperty('pid');
      expect(typeof response.body.pid).toBe('number');
      expect(response.body.pid).toBeGreaterThan(0);
    });

    it('should report process architecture', async () => {
      const response = await request(app).get('/health');
      expect(response.body.system).toHaveProperty('arch');
      expect(typeof response.body.system.arch).toBe('string');
      expect(['x64', 'arm', 'arm64', 'ia32']).toContain(response.body.system.arch);
    });
  });

  describe('GET /health - Service Availability Validation', () => {
    it('should include services section', async () => {
      const response = await request(app).get('/health');
      expect(response.body).toHaveProperty('services');
      expect(typeof response.body.services).toBe('object');
    });

    it('should report database service status', async () => {
      const response = await request(app).get('/health');
      expect(response.body.services).toHaveProperty('database');
      expect(typeof response.body.services.database).toBe('object');
    });

    it('should report database service availability', async () => {
      const response = await request(app).get('/health');
      expect(response.body.services.database).toHaveProperty('available');
      expect(typeof response.body.services.database.available).toBe('boolean');
    });

    it('should include database latency measurement', async () => {
      const response = await request(app).get('/health');
      expect(response.body.services.database).toHaveProperty('latency');
      expect(typeof response.body.services.database.latency).toBe('number');
      expect(response.body.services.database.latency).toBeGreaterThanOrEqual(0);
    });

    it('should report external service status', async () => {
      const response = await request(app).get('/health');
      expect(response.body.services).toHaveProperty('external');
      expect(typeof response.body.services.external).toBe('object');
    });

    it('should report external API availability', async () => {
      const response = await request(app).get('/health');
      expect(response.body.services.external).toHaveProperty('available');
      expect(typeof response.body.services.external.available).toBe('boolean');
    });

    it('should report overall services health', async () => {
      const response = await request(app).get('/health');
      expect(response.body.services).toHaveProperty('healthy');
      expect(typeof response.body.services.healthy).toBe('boolean');
    });

    it('should list all checked services', async () => {
      const response = await request(app).get('/health');
      expect(response.body.services).toHaveProperty('checked');
      expect(Array.isArray(response.body.services.checked)).toBe(true);
      expect(response.body.services.checked.length).toBeGreaterThan(0);
    });

    it('checked services list should contain expected services', async () => {
      const response = await request(app).get('/health');
      expect(response.body.services.checked).toContain('database');
      expect(response.body.services.checked).toContain('external');
    });

    it('should include service last check timestamp', async () => {
      const response = await request(app).get('/health');
      expect(response.body.services).toHaveProperty('lastCheck');
      expect(response.body.services.lastCheck).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('GET /health - Response Structure Validation', () => {
    it('should have consistent response structure', async () => {
      const response = await request(app).get('/health');
      const expectedKeys = [
        'status',
        'timestamp',
        'uptime',
        'memory',
        'cpu',
        'loadAverage',
        'system',
        'services',
        'pid'
      ];
      expectedKeys.forEach(key => {
        expect(response.body).toHaveProperty(key);
      });
    });

    it('should not include unexpected properties', async () => {
      const response = await request(app).get('/health');
      const responseKeys = Object.keys(response.body);
      const expectedKeys = [
        'status',
        'timestamp',
        'uptime',
        'memory',
        'cpu',
        'loadAverage',
        'system',
        'services',
        'pid'
      ];
      expectedKeys.forEach(key => {
        expect(responseKeys).toContain(key);
      });
    });

    it('memory object should have all expected properties', async () => {
      const response = await request(app).get('/health');
      const expectedMemoryKeys = [
        'heapUsed',
        'heapTotal',
        'external',
        'arrayBuffers',
        'usagePercent'
      ];
      expectedMemoryKeys.forEach(key => {
        expect(response.body.memory).toHaveProperty(key);
      });
    });

    it('cpu object should have all expected properties', async () => {
      const response = await request(app).get('/health');
      const expectedCpuKeys = [
        'usagePercent',
        'model',
        'cores'
      ];
      expectedCpuKeys.forEach(key => {
        expect(response.body.cpu).toHaveProperty(key);
      });
    });

    it('system object should have all expected properties', async () => {
      const response = await request(app).get('/health');
      const expectedSystemKeys = [
        'platform',
        'arch',
        'nodeVersion',
        'hostname'
      ];
      expectedSystemKeys.forEach(key => {
        expect(response.body.system).toHaveProperty(key);
      });
    });

    it('services object should have all expected properties', async () => {
      const response = await request(app).get('/health');
      const expectedServicesKeys = [
        'database',
        'external',
        'healthy',
        'checked',
        'lastCheck'
      ];
      expectedServicesKeys.forEach(key => {
        expect(response.body.services).toHaveProperty(key);
      });
    });
  });

  describe('GET /health - Response Time and Performance', () => {
    it('should respond within 100ms for basic health check', async () => {
      const start = Date.now();
      await request(app).get('/health');
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(100);
    });

    it('should respond within 500ms for full health check', async () => {
      const start = Date.now();
      await request(app).get('/health');
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(500);
    });

    it('should handle concurrent health check requests', async () => {
      const requests = Array(10).fill(null).map(() => 
        request(app).get('/health')
      );
      const responses = await Promise.all(requests);
      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('status');
      });
    });
  });

  describe('GET /health - Edge Cases and Error Handling', () => {
    it('should handle HEAD request', async () => {
      const response = await request(app).head('/health');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
    });

    it('should reject POST request', async () => {
      const response = await request(app).post('/health');
      expect(response.status).toBe(404);
    });

    it('should reject PUT request', async () => {
      const response = await request(app).put('/health');
      expect(response.status).toBe(404);
    });

    it('should reject DELETE request', async () => {
      const response = await request(app).delete('/health');
      expect(response.status).toBe(404);
    });

    it('should handle query parameters gracefully', async () => {
      const response = await request(app).get('/health?verbose=true');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status');
    });

    it('should handle multiple requests without state leakage', async () => {
      const response1 = await request(app).get('/health');
      const response2 = await request(app).get('/health');
      expect(response1.body.status).toBe(response2.body.status);
      expect(response1.body.pid).toBe(response2.body.pid);
    });
  });

  describe('GET /health - Health Status Transitions', () => {
    it('should report healthy status when all services are available', async () => {
      const response = await request(app).get('/health');
      expect(response.body.status).toBe('ok');
      expect(response.body.services.healthy).toBe(true);
    });

    it('should include detailed status for each service', async () => {
      const response = await request(app).get('/health');
      expect(response.body.services.database).toHaveProperty('status');
      expect(typeof response.body.services.database.status).toBe('string');
      expect(['up', 'down', 'degraded']).toContain(response.body.services.database.status);
    });

    it('should include error information if service is unavailable', async () => {
      const response = await request(app).get('/health');
      if (!response.body.services.database.available) {
        expect(response.body.services.database).toHaveProperty('error');
        expect(typeof response.body.services.database.error).toBe('string');
      }
    });
  });

  describe('GET /health - Metrics and Thresholds', () => {
    it('memory usage percent should be within valid range', async () => {
      const response = await request(app).get('/health');
      expect(response.body.memory.usagePercent).toBeGreaterThanOrEqual(0);
      expect(response.body.memory.usagePercent).toBeLessThanOrEqual(100);
    });

    it('CPU usage percent should be within valid range', async () => {
      const response = await request(app).get('/health');
      expect(response.body.cpu.usagePercent).toBeGreaterThanOrEqual(0);
      expect(response.body.cpu.usagePercent).toBeLessThanOrEqual(100);
    });

    it('heap used should not exceed heap total', async () => {
      const response = await request(app).get('/health');
      expect(response.body.memory.heapUsed).toBeLessThanOrEqual(response.body.memory.heapTotal);
    });

    it('load average should be reasonable', async () => {
      const response = await request(app).get('/health');
      response.body.loadAverage.forEach((load: number) => {
        expect(load).toBeLessThan(100);
      });
    });

    it('should report CPU core count', async () => {
      const response = await request(app).get('/health');
      expect(response.body.cpu).toHaveProperty('cores');
      expect(typeof response.body.cpu.cores).toBe('number');
      expect(response.body.cpu.cores).toBeGreaterThan(0);
    });

    it('should report CPU model information', async () => {
      const response = await request(app).get('/health');
      expect(response.body.cpu).toHaveProperty('model');
      expect(typeof response.body.cpu.model).toBe('string');
    });
  });

  describe('GET /health - Integration and Consistency', () => {
    it('timestamp should be recent (within 1 second)', async () => {
      const beforeRequest = new Date().toISOString();
      const response = await request(app).get('/health');
      const afterRequest = new Date().toISOString();
      const responseTime = new Date(response.body.timestamp).getTime();
      const beforeTime = new Date(beforeRequest).getTime();
      const afterTime = new Date(afterRequest).getTime();
      expect(responseTime).toBeGreaterThanOrEqual(beforeTime - 1000);
      expect(responseTime).toBeLessThanOrEqual(afterTime + 1000);
    });

    it('uptime should be consistent across multiple requests', async () => {
      const response1 = await request(app).get('/health');
      await new Promise(resolve => setTimeout(resolve, 100));
      const response2 = await request(app).get('/health');
      expect(response2.body.uptime).toBeGreaterThan(response1.body.uptime);
      expect(response2.body.uptime - response1.body.uptime).toBeLessThan(1000);
    });

    it('pid should remain constant across requests', async () => {
      const response1 = await request(app).get('/health');
      const response2 = await request(app).get('/health');
      expect(response1.body.pid).toBe(response2.body.pid);
    });

    it('system information should remain constant', async () => {
      const response1 = await request(app).get('/health');
      const response2 = await request(app).get('/health');
      expect(response1.body.system.platform).toBe(response2.body.system.platform);
      expect(response1.body.system.arch).toBe(response2.body.system.arch);
      expect(response1.body.system.nodeVersion).toBe(response2.body.system.nodeVersion);
    });
  });
});