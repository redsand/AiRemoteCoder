import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';
import { db } from '../services/database.js';
import { config } from '../config.js';
import { sign } from 'jsonwebtoken';

describe('Dashboard Routes', () => {
  let server: FastifyInstance;
  let testUserId: string;
  let adminUserId: string;
  let regularUserToken: string;
  let adminUserToken: string;
  let authHeader: string;
  let adminAuthHeader: string;

  // Mock database
  const mockDb = {
    query: vi.fn(),
  };

  beforeAll(async () => {
    // Mock database service
    vi.mock('../services/database.js', () => ({
      db: mockDb,
    }));

    server = await buildServer();
    await server.ready();

    // Create test users and tokens
    testUserId = 'user-test-123';
    adminUserId = 'admin-test-456';

    regularUserToken = sign(
      { userId: testUserId, role: 'user' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );

    adminUserToken = sign(
      { userId: adminUserId, role: 'admin' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );

    authHeader = `Bearer ${regularUserToken}`;
    adminAuthHeader = `Bearer ${adminUserToken}`;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await server.close();
  });

  describe('GET /dashboard', () => {
    it('should return dashboard data for authenticated user', async () => {
      const dashboardData = {
        totalProjects: 5,
        activeProjects: 3,
        totalTasks: 25,
        completedTasks: 18,
        pendingTasks: 7,
        recentActivity: [
          { id: 1, type: 'task_completed', timestamp: new Date().toISOString() },
          { id: 2, type: 'project_created', timestamp: new Date().toISOString() },
        ],
      };

      mockDb.query.mockResolvedValueOnce({ rows: [dashboardData] });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload).toHaveProperty('totalProjects', 5);
      expect(payload).toHaveProperty('activeProjects', 3);
      expect(payload).toHaveProperty('totalTasks', 25);
      expect(payload).toHaveProperty('recentActivity');
      expect(Array.isArray(payload.recentActivity)).toBe(true);
    });

    it('should return 401 for unauthenticated request', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
      });

      expect(response.statusCode).toBe(401);
      const payload = JSON.parse(response.payload);
      expect(payload).toHaveProperty('error', 'Unauthorized');
    });

    it('should return 401 for invalid token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: 'Bearer invalid-token',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 401 for malformed authorization header', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: 'InvalidFormat token',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 500 on database error', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Database connection failed'));

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(500);
      const payload = JSON.parse(response.payload);
      expect(payload).toHaveProperty('error');
    });
  });

  describe('GET /dashboard/metrics', () => {
    it('should return aggregated metrics for authenticated user', async () => {
      const metricsData = {
        totalRequests: 1250,
        successfulRequests: 1180,
        failedRequests: 70,
        averageResponseTime: 145,
        uptime: 99.8,
        cpuUsage: 45.2,
        memoryUsage: 512,
        diskUsage: 23.4,
        activeConnections: 12,
      };

      mockDb.query.mockResolvedValueOnce({ rows: [metricsData] });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/metrics',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload).toHaveProperty('totalRequests', 1250);
      expect(payload).toHaveProperty('successfulRequests', 1180);
      expect(payload).toHaveProperty('failedRequests', 70);
      expect(payload).toHaveProperty('averageResponseTime', 145);
      expect(payload).toHaveProperty('uptime', 99.8);
    });

    it('should accept time range query parameter', async () => {
      const metricsData = {
        totalRequests: 500,
        successfulRequests: 480,
        failedRequests: 20,
        averageResponseTime: 120,
        uptime: 99.5,
      };

      mockDb.query.mockResolvedValueOnce({ rows: [metricsData] });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/metrics?range=7d',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('7d'),
        expect.any(Array)
      );
    });

    it('should validate time range parameter', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/metrics?range=invalid',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(400);
      const payload = JSON.parse(response.payload);
      expect(payload).toHaveProperty('error');
    });

    it('should return 401 for unauthenticated metrics request', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/metrics',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 500 on metrics aggregation error', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Aggregation failed'));

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/metrics',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('GET /dashboard/statistics', () => {
    it('should return user statistics for authenticated user', async () => {
      const statsData = {
        userId: testUserId,
        totalProjects: 3,
        activeProjects: 2,
        totalTasks: 15,
        completedTasks: 10,
        pendingTasks: 5,
        overdueTasks: 1,
        totalHoursLogged: 42.5,
        averageTaskCompletionTime: 2.3,
        productivityScore: 85,
        weeklyProgress: [
          { week: '2024-01-01', tasks: 5, hours: 8.5 },
          { week: '2024-01-08', tasks: 7, hours: 12.0 },
        ],
      };

      mockDb.query.mockResolvedValueOnce({ rows: [statsData] });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/statistics',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload).toHaveProperty('userId', testUserId);
      expect(payload).toHaveProperty('totalProjects', 3);
      expect(payload).toHaveProperty('totalTasks', 15);
      expect(payload).toHaveProperty('productivityScore', 85);
      expect(payload).toHaveProperty('weeklyProgress');
      expect(Array.isArray(payload.weeklyProgress)).toBe(true);
    });

    it('should allow admin to view other user statistics', async () => {
      const targetUserId = 'other-user-789';
      const statsData = {
        userId: targetUserId,
        totalProjects: 5,
        activeProjects: 3,
        totalTasks: 20,
      };

      mockDb.query.mockResolvedValueOnce({ rows: [statsData] });

      const response = await server.inject({
        method: 'GET',
        url: `/dashboard/statistics?userId=${targetUserId}`,
        headers: {
          authorization: adminAuthHeader,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload).toHaveProperty('userId', targetUserId);
    });

    it('should deny regular user from viewing other user statistics', async () => {
      const targetUserId = 'other-user-789';

      const response = await server.inject({
        method: 'GET',
        url: `/dashboard/statistics?userId=${targetUserId}`,
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(403);
      const payload = JSON.parse(response.payload);
      expect(payload).toHaveProperty('error', 'Forbidden');
    });

    it('should return 401 for unauthenticated statistics request', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/statistics',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 404 when user statistics not found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/statistics',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 500 on statistics retrieval error', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Statistics query failed'));

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/statistics',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('GET /dashboard/activity', () => {
    it('should return recent activity for authenticated user', async () => {
      const activityData = [
        {
          id: 1,
          type: 'task_completed',
          description: 'Completed task "API Integration"',
          timestamp: new Date().toISOString(),
          userId: testUserId,
        },
        {
          id: 2,
          type: 'project_created',
          description: 'Created project "New Dashboard"',
          timestamp: new Date(Date.now() - 3600000).toISOString(),
          userId: testUserId,
        },
        {
          id: 3,
          type: 'comment_added',
          description: 'Added comment to task #42',
          timestamp: new Date(Date.now() - 7200000).toISOString(),
          userId: testUserId,
        },
      ];

      mockDb.query.mockResolvedValueOnce({ rows: activityData });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/activity',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(Array.isArray(payload)).toBe(true);
      expect(payload).toHaveLength(3);
      expect(payload[0]).toHaveProperty('type', 'task_completed');
      expect(payload[0]).toHaveProperty('timestamp');
      expect(payload[0]).toHaveProperty('userId', testUserId);
    });

    it('should respect limit query parameter', async () => {
      const activityData = Array.from({ length: 5 }, (_, i) => ({
        id: i + 1,
        type: 'activity',
        description: `Activity ${i + 1}`,
        timestamp: new Date().toISOString(),
        userId: testUserId,
      }));

      mockDb.query.mockResolvedValueOnce({ rows: activityData });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/activity?limit=5',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT'),
        expect.arrayContaining([5])
      );
    });

    it('should validate limit parameter', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/activity?limit=invalid',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should enforce maximum limit', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/activity?limit=1000',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(400);
      const payload = JSON.parse(response.payload);
      expect(payload.error).toContain('limit');
    });

    it('should return 401 for unauthenticated activity request', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/activity',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /dashboard/performance', () => {
    it('should return performance metrics for authenticated user', async () => {
      const performanceData = {
        period: '30d',
        tasksCompleted: 45,
        tasksCreated: 52,
        completionRate: 86.5,
        averageTaskDuration: 2.8,
        onTimeDeliveryRate: 92.3,
        qualityScore: 88.7,
        trend: 'improving',
        breakdown: {
          byType: {
            development: 20,
            review: 15,
            planning: 10,
          },
          byPriority: {
            high: 12,
            medium: 25,
            low: 8,
          },
        },
      };

      mockDb.query.mockResolvedValueOnce({ rows: [performanceData] });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/performance',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload).toHaveProperty('completionRate', 86.5);
      expect(payload).toHaveProperty('averageTaskDuration', 2.8);
      expect(payload).toHaveProperty('trend', 'improving');
      expect(payload).toHaveProperty('breakdown');
      expect(payload.breakdown).toHaveProperty('byType');
      expect(payload.breakdown).toHaveProperty('byPriority');
    });

    it('should accept period query parameter', async () => {
      const performanceData = {
        period: '7d',
        tasksCompleted: 12,
        completionRate: 90.0,
      };

      mockDb.query.mockResolvedValueOnce({ rows: [performanceData] });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/performance?period=7d',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('7d'),
        expect.any(Array)
      );
    });

    it('should validate period parameter', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/performance?period=invalid',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 401 for unauthenticated performance request', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/performance',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('Role-based Access Control', () => {
    it('should allow admin to access all dashboard endpoints', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{}] });

      const endpoints = [
        '/dashboard',
        '/dashboard/metrics',
        '/dashboard/statistics',
        '/dashboard/activity',
        '/dashboard/performance',
      ];

      for (const endpoint of endpoints) {
        const response = await server.inject({
          method: 'GET',
          url: endpoint,
          headers: {
            authorization: adminAuthHeader,
          },
        });

        expect([200, 404]).toContain(response.statusCode);
        expect(response.statusCode).not.toBe(403);
      }
    });

    it('should allow regular user to access their own dashboard data', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{}] });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: authHeader,
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should deny access with expired token', async () => {
      const expiredToken = sign(
        { userId: testUserId, role: 'user' },
        config.jwtSecret,
        { expiresIn: '-1h' }
      );

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: `Bearer ${expiredToken}`,
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should deny access with invalid signature', async () => {
      const invalidToken = sign(
        { userId: testUserId, role: 'user' },
        'wrong-secret',
        { expiresIn: '1h' }
      );

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: `Bearer ${invalidToken}`,
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('Database Mocking', () => {
    it('should correctly mock database query for dashboard data', async () => {
      const expectedData = { totalProjects: 10, activeProjects: 5 };
      mockDb.query.mockResolvedValueOnce({ rows: [expectedData] });

      await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: { authorization: authHeader },
      });

      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([testUserId])
      );
    });

    it('should handle database connection errors gracefully', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Connection timeout'));

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: { authorization: authHeader },
      });

      expect(response.statusCode).toBe(500);
      expect(mockDb.query).toHaveBeenCalled();
    });

    it('should handle empty results from database', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: { authorization: authHeader },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should handle malformed database responses', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [null] });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: { authorization: authHeader },
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('Input Validation', () => {
    it('should validate query parameters for metrics endpoint', async () => {
      const invalidParams = ['range=invalid', 'start=not-a-date', 'end=not-a-date'];

      for (const param of invalidParams) {
        const response = await server.inject({
          method: 'GET',
          url: `/dashboard/metrics?${param}`,
          headers: { authorization: authHeader },
        });

        expect(response.statusCode).toBe(400);
      }
    });

    it('should validate limit parameter for activity endpoint', async () => {
      const invalidLimits = ['-1', '0', 'abc', '1001'];

      for (const limit of invalidLimits) {
        const response = await server.inject({
          method: 'GET',
          url: `/dashboard/activity?limit=${limit}`,
          headers: { authorization: authHeader },
        });

        expect(response.statusCode).toBe(400);
      }
    });

    it('should validate period parameter for performance endpoint', async () => {
      const invalidPeriods = ['invalid', '100d', '1y', '0d'];

      for (const period of invalidPeriods) {
        const response = await server.inject({
          method: 'GET',
          url: `/dashboard/performance?period=${period}`,
          headers: { authorization: authHeader },
        });

        expect(response.statusCode).toBe(400);
      }
    });

    it('should validate userId parameter for statistics endpoint', async () => {
      const invalidUserIds = ['', 'not-a-uuid', '123'];

      for (const userId of invalidUserIds) {
        const response = await server.inject({
          method: 'GET',
          url: `/dashboard/statistics?userId=${userId}`,
          headers: { authorization: adminAuthHeader },
        });

        expect([400, 404]).toContain(response.statusCode);
      }
    });
  });

  describe('Response Format', () => {
    it('should return JSON content type for all endpoints', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{}] });

      const endpoints = [
        '/dashboard',
        '/dashboard/metrics',
        '/dashboard/statistics',
        '/dashboard/activity',
        '/dashboard/performance',
      ];

      for (const endpoint of endpoints) {
        const response = await server.inject({
          method: 'GET',
          url: endpoint,
          headers: { authorization: authHeader },
        });

        expect(response.headers['content-type']).toContain('application/json');
      }
    });

    it('should include proper error responses', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
      });

      expect(response.statusCode).toBe(401);
      const payload = JSON.parse(response.payload);
      expect(payload).toHaveProperty('error');
    });

    it('should include CORS headers', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{}] });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: {
          authorization: authHeader,
          origin: 'http://localhost:3000',
        },
      });

      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });
  });

  describe('Rate Limiting', () => {
    it('should enforce rate limiting on dashboard endpoints', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{}] });

      // Make multiple rapid requests
      const requests = Array.from({ length: 15 }, () =>
        server.inject({
          method: 'GET',
          url: '/dashboard',
          headers: { authorization: authHeader },
        })
      );

      const responses = await Promise.all(requests);
      const rateLimitedResponses = responses.filter((r) => r.statusCode === 429);

      expect(rateLimitedResponses.length).toBeGreaterThan(0);
    });

    it('should include rate limit headers in response', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{}] });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard',
        headers: { authorization: authHeader },
      });

      expect(
        response.headers['x-ratelimit-limit'] ||
          response.headers['ratelimit-limit']
      ).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle concurrent requests', async () => {
      mockDb.query.mockResolvedValue({ rows: [{}] });

      const concurrentRequests = Array.from({ length: 5 }, () =>
        server.inject({
          method: 'GET',
          url: '/dashboard',
          headers: { authorization: authHeader },
        })
      );

      const responses = await Promise.all(concurrentRequests);

      responses.forEach((response) => {
        expect([200, 500]).toContain(response.statusCode);
      });
    });

    it('should handle very large result sets', async () => {
      const largeDataset = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        type: 'activity',
        description: `Activity ${i}`,
        timestamp: new Date().toISOString(),
      }));

      mockDb.query.mockResolvedValueOnce({ rows: largeDataset });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/activity?limit=1000',
        headers: { authorization: authHeader },
      });

      // Should be rejected due to limit validation
      expect(response.statusCode).toBe(400);
    });

    it('should handle special characters in parameters', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{}] });

      const response = await server.inject({
        method: 'GET',
        url: '/dashboard/activity?limit=5&filter=test%20%26%20more',
        headers: { authorization: authHeader },
      });

      expect([200, 400, 500]).toContain(response.statusCode);
    });

    it('should handle malformed JSON in request body (for POST endpoints)', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/dashboard/preferences',
        headers: {
          authorization: authHeader,
          'content-type': 'application/json',
        },
        payload: '{ invalid json }',
      });

      expect([400, 404, 405]).toContain(response.statusCode);
    });
  });
});