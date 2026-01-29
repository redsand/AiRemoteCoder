import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { alertsRouter } from './alerts.js';

// Mock the database service
const mockPrepare = vi.fn();
const mockExec = vi.fn();
const mockAll = vi.fn();
const mockGet = vi.fn();
const mockRun = vi.fn();

vi.mock('../services/database.js', () => ({
  db: {
    prepare: vi.fn(() => ({
      all: mockAll,
      get: mockGet,
      run: mockRun,
      bind: vi.fn(() => ({
        all: mockAll,
        get: mockGet,
        run: mockRun
      }))
    })),
    exec: mockExec
  }
}));

// Mock auth middleware
vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No token provided' });
    }
    try {
      const token = authHeader.split(' ')[1];
      if (token === 'invalid') {
        return res.status(403).json({ error: 'Invalid token' });
      }
      req.user = {
        id: 'user-123',
        email: 'test@example.com',
        role: token === 'admin-token' ? 'admin' : 'user'
      };
      next();
    } catch (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
  },
  requireRole: (roles: string[]) => (req: any, res: any, next: any) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  }
}));

// Mock notification service
const mockSendNotification = vi.fn();
vi.mock('../services/notifications.js', () => ({
  sendNotification: mockSendNotification
}));

describe('Alerts Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/alerts', alertsRouter);
    
    // Clear all mocks
    vi.clearAllMocks();
    
    // Setup default mock behavior
    mockPrepare.mockReturnValue({
      all: mockAll,
      get: mockGet,
      run: mockRun,
      bind: vi.fn(() => ({
        all: mockAll,
        get: mockGet,
        run: mockRun
      }))
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/alerts - List Alerts', () => {
    it('should return list of alerts with valid token', async () => {
      const mockAlerts = [
        { id: 'alert-1', name: 'High CPU Usage', severity: 'high', status: 'active', created_at: '2024-01-01T00:00:00Z' },
        { id: 'alert-2', name: 'Memory Warning', severity: 'medium', status: 'active', created_at: '2024-01-02T00:00:00Z' }
      ];
      mockAll.mockResolvedValue(mockAlerts);

      const response = await request(app)
        .get('/api/alerts')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ alerts: mockAlerts });
      expect(mockPrepare).toHaveBeenCalled();
    });

    it('should return 401 without authentication', async () => {
      const response = await request(app)
        .get('/api/alerts');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'No token provided' });
    });

    it('should return 403 with invalid token', async () => {
      const response = await request(app)
        .get('/api/alerts')
        .set('Authorization', 'Bearer invalid');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Invalid token' });
    });

    it('should filter alerts by severity', async () => {
      const mockAlerts = [
        { id: 'alert-1', name: 'High CPU Usage', severity: 'high', status: 'active' }
      ];
      mockAll.mockResolvedValue(mockAlerts);

      const response = await request(app)
        .get('/api/alerts?severity=high')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('severity = ?')
      );
    });

    it('should filter alerts by status', async () => {
      const mockAlerts = [
        { id: 'alert-1', name: 'Resolved Alert', severity: 'high', status: 'resolved' }
      ];
      mockAll.mockResolvedValue(mockAlerts);

      const response = await request(app)
        .get('/api/alerts?status=resolved')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('status = ?')
      );
    });

    it('should support pagination', async () => {
      mockAll.mockResolvedValue([]);

      const response = await request(app)
        .get('/api/alerts?page=1&limit=10')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT ? OFFSET ?')
      );
    });

    it('should handle database errors', async () => {
      mockAll.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .get('/api/alerts')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('GET /api/alerts/:id - Get Alert by ID', () => {
    it('should return alert with valid ID', async () => {
      const mockAlert = {
        id: 'alert-1',
        name: 'High CPU Usage',
        severity: 'high',
        status: 'active',
        description: 'CPU usage exceeds 90%',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z'
      };
      mockGet.mockResolvedValue(mockAlert);

      const response = await request(app)
        .get('/api/alerts/alert-1')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ alert: mockAlert });
      expect(mockGet).toHaveBeenCalled();
    });

    it('should return 404 for non-existent alert', async () => {
      mockGet.mockResolvedValue(undefined);

      const response = await request(app)
        .get('/api/alerts/non-existent')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Alert not found' });
    });

    it('should return 401 without authentication', async () => {
      const response = await request(app)
        .get('/api/alerts/alert-1');

      expect(response.status).toBe(401);
    });

    it('should handle database errors', async () => {
      mockGet.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .get('/api/alerts/alert-1')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(500);
    });
  });

  describe('POST /api/alerts - Create Alert', () => {
    const newAlert = {
      name: 'Disk Space Low',
      severity: 'high',
      status: 'active',
      description: 'Disk space below 10%'
    };

    it('should create alert with valid data and admin role', async () => {
      const createdAlert = {
        id: 'alert-3',
        ...newAlert,
        created_at: '2024-01-03T00:00:00Z',
        updated_at: '2024-01-03T00:00:00Z',
        created_by: 'user-123'
      };
      mockRun.mockResolvedValue({ lastInsertRowid: 3 });
      mockGet.mockResolvedValue(createdAlert);
      mockSendNotification.mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/api/alerts')
        .set('Authorization', 'Bearer admin-token')
        .send(newAlert);

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ alert: createdAlert });
      expect(mockRun).toHaveBeenCalled();
      expect(mockSendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'alert_created',
          severity: 'high'
        })
      );
    });

    it('should return 403 for non-admin user', async () => {
      const response = await request(app)
        .post('/api/alerts')
        .set('Authorization', 'Bearer valid-token')
        .send(newAlert);

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Insufficient permissions' });
    });

    it('should return 400 for missing required fields', async () => {
      const incompleteAlert = { name: 'Test Alert' };

      const response = await request(app)
        .post('/api/alerts')
        .set('Authorization', 'Bearer admin-token')
        .send(incompleteAlert);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should return 400 for invalid severity', async () => {
      const invalidAlert = { ...newAlert, severity: 'invalid' };

      const response = await request(app)
        .post('/api/alerts')
        .set('Authorization', 'Bearer admin-token')
        .send(invalidAlert);

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid status', async () => {
      const invalidAlert = { ...newAlert, status: 'invalid' };

      const response = await request(app)
        .post('/api/alerts')
        .set('Authorization', 'Bearer admin-token')
        .send(invalidAlert);

      expect(response.status).toBe(400);
    });

    it('should handle database errors', async () => {
      mockRun.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/api/alerts')
        .set('Authorization', 'Bearer admin-token')
        .send(newAlert);

      expect(response.status).toBe(500);
    });

    it('should handle notification service errors gracefully', async () => {
      mockRun.mockResolvedValue({ lastInsertRowid: 3 });
      mockGet.mockResolvedValue({
        id: 'alert-3',
        ...newAlert,
        created_at: '2024-01-03T00:00:00Z'
      });
      mockSendNotification.mockRejectedValue(new Error('Notification failed'));

      const response = await request(app)
        .post('/api/alerts')
        .set('Authorization', 'Bearer admin-token')
        .send(newAlert);

      expect(response.status).toBe(201);
    });
  });

  describe('PUT /api/alerts/:id - Update Alert', () => {
    const updateData = {
      name: 'Updated Alert Name',
      severity: 'medium',
      status: 'resolved'
    };

    it('should update alert with valid data and admin role', async () => {
      const existingAlert = {
        id: 'alert-1',
        name: 'Old Name',
        severity: 'high',
        status: 'active'
      };
      const updatedAlert = {
        ...existingAlert,
        ...updateData,
        updated_at: '2024-01-04T00:00:00Z'
      };

      mockGet.mockResolvedValueOnce(existingAlert);
      mockRun.mockResolvedValue({ changes: 1 });
      mockGet.mockResolvedValueOnce(updatedAlert);
      mockSendNotification.mockResolvedValue({ success: true });

      const response = await request(app)
        .put('/api/alerts/alert-1')
        .set('Authorization', 'Bearer admin-token')
        .send(updateData);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ alert: updatedAlert });
      expect(mockRun).toHaveBeenCalled();
      expect(mockSendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'alert_updated',
          alertId: 'alert-1'
        })
      );
    });

    it('should return 404 for non-existent alert', async () => {
      mockGet.mockResolvedValue(undefined);

      const response = await request(app)
        .put('/api/alerts/non-existent')
        .set('Authorization', 'Bearer admin-token')
        .send(updateData);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Alert not found' });
    });

    it('should return 403 for non-admin user', async () => {
      const response = await request(app)
        .put('/api/alerts/alert-1')
        .set('Authorization', 'Bearer valid-token')
        .send(updateData);

      expect(response.status).toBe(403);
    });

    it('should return 400 for invalid severity', async () => {
      mockGet.mockResolvedValue({ id: 'alert-1' });

      const response = await request(app)
        .put('/api/alerts/alert-1')
        .set('Authorization', 'Bearer admin-token')
        .send({ ...updateData, severity: 'invalid' });

      expect(response.status).toBe(400);
    });

    it('should allow partial updates', async () => {
      const existingAlert = { id: 'alert-1', name: 'Test', severity: 'high', status: 'active' };
      const partialUpdate = { status: 'resolved' };

      mockGet.mockResolvedValueOnce(existingAlert);
      mockRun.mockResolvedValue({ changes: 1 });
      mockGet.mockResolvedValueOnce({ ...existingAlert, ...partialUpdate });

      const response = await request(app)
        .put('/api/alerts/alert-1')
        .set('Authorization', 'Bearer admin-token')
        .send(partialUpdate);

      expect(response.status).toBe(200);
    });

    it('should handle database errors', async () => {
      mockGet.mockResolvedValue({ id: 'alert-1' });
      mockRun.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .put('/api/alerts/alert-1')
        .set('Authorization', 'Bearer admin-token')
        .send(updateData);

      expect(response.status).toBe(500);
    });
  });

  describe('DELETE /api/alerts/:id - Delete Alert', () => {
    it('should delete alert with admin role', async () => {
      const existingAlert = { id: 'alert-1', name: 'Test Alert' };
      mockGet.mockResolvedValue(existingAlert);
      mockRun.mockResolvedValue({ changes: 1 });
      mockSendNotification.mockResolvedValue({ success: true });

      const response = await request(app)
        .delete('/api/alerts/alert-1')
        .set('Authorization', 'Bearer admin-token');

      expect(response.status).toBe(204);
      expect(mockRun).toHaveBeenCalled();
      expect(mockSendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'alert_deleted',
          alertId: 'alert-1'
        })
      );
    });

    it('should return 404 for non-existent alert', async () => {
      mockGet.mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/alerts/non-existent')
        .set('Authorization', 'Bearer admin-token');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Alert not found' });
    });

    it('should return 403 for non-admin user', async () => {
      const response = await request(app)
        .delete('/api/alerts/alert-1')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(403);
    });

    it('should return 401 without authentication', async () => {
      const response = await request(app)
        .delete('/api/alerts/alert-1');

      expect(response.status).toBe(401);
    });

    it('should handle database errors', async () => {
      mockGet.mockResolvedValue({ id: 'alert-1' });
      mockRun.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .delete('/api/alerts/alert-1')
        .set('Authorization', 'Bearer admin-token');

      expect(response.status).toBe(500);
    });

    it('should handle notification service errors gracefully', async () => {
      mockGet.mockResolvedValue({ id: 'alert-1' });
      mockRun.mockResolvedValue({ changes: 1 });
      mockSendNotification.mockRejectedValue(new Error('Notification failed'));

      const response = await request(app)
        .delete('/api/alerts/alert-1')
        .set('Authorization', 'Bearer admin-token');

      expect(response.status).toBe(204);
    });
  });

  describe('POST /api/alerts/:id/acknowledge - Acknowledge Alert', () => {
    it('should acknowledge alert with valid token', async () => {
      const existingAlert = {
        id: 'alert-1',
        name: 'Test Alert',
        status: 'active'
      };
      const acknowledgedAlert = {
        ...existingAlert,
        status: 'acknowledged',
        acknowledged_by: 'user-123',
        acknowledged_at: '2024-01-04T00:00:00Z'
      };

      mockGet.mockResolvedValueOnce(existingAlert);
      mockRun.mockResolvedValue({ changes: 1 });
      mockGet.mockResolvedValueOnce(acknowledgedAlert);
      mockSendNotification.mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/api/alerts/alert-1/acknowledge')
        .set('Authorization', 'Bearer valid-token')
        .send({ note: 'Investigating the issue' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ alert: acknowledgedAlert });
      expect(mockSendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'alert_acknowledged',
          alertId: 'alert-1'
        })
      );
    });

    it('should return 404 for non-existent alert', async () => {
      mockGet.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/alerts/non-existent/acknowledge')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(404);
    });

    it('should return 400 if already acknowledged', async () => {
      mockGet.mockResolvedValue({
        id: 'alert-1',
        status: 'acknowledged'
      });

      const response = await request(app)
        .post('/api/alerts/alert-1/acknowledge')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Alert already acknowledged' });
    });

    it('should handle database errors', async () => {
      mockGet.mockResolvedValue({ id: 'alert-1', status: 'active' });
      mockRun.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/api/alerts/alert-1/acknowledge')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(500);
    });
  });

  describe('POST /api/alerts/:id/resolve - Resolve Alert', () => {
    it('should resolve alert with admin role', async () => {
      const existingAlert = {
        id: 'alert-1',
        name: 'Test Alert',
        status: 'acknowledged'
      };
      const resolvedAlert = {
        ...existingAlert,
        status: 'resolved',
        resolved_by: 'user-123',
        resolved_at: '2024-01-04T00:00:00Z'
      };

      mockGet.mockResolvedValueOnce(existingAlert);
      mockRun.mockResolvedValue({ changes: 1 });
      mockGet.mockResolvedValueOnce(resolvedAlert);
      mockSendNotification.mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/api/alerts/alert-1/resolve')
        .set('Authorization', 'Bearer admin-token')
        .send({ resolution: 'Fixed the underlying issue' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ alert: resolvedAlert });
      expect(mockSendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'alert_resolved',
          alertId: 'alert-1'
        })
      );
    });

    it('should return 403 for non-admin user', async () => {
      const response = await request(app)
        .post('/api/alerts/alert-1/resolve')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(403);
    });

    it('should return 400 if already resolved', async () => {
      mockGet.mockResolvedValue({
        id: 'alert-1',
        status: 'resolved'
      });

      const response = await request(app)
        .post('/api/alerts/alert-1/resolve')
        .set('Authorization', 'Bearer admin-token');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Alert already resolved' });
    });

    it('should handle database errors', async () => {
      mockGet.mockResolvedValue({ id: 'alert-1', status: 'active' });
      mockRun.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/api/alerts/alert-1/resolve')
        .set('Authorization', 'Bearer admin-token');

      expect(response.status).toBe(500);
    });
  });

  describe('GET /api/alerts/stats - Alert Statistics', () => {
    it('should return alert statistics', async () => {
      const mockStats = {
        total: 100,
        active: 25,
        acknowledged: 15,
        resolved: 60,
        by_severity: {
          critical: 5,
          high: 20,
          medium: 45,
          low: 30
        }
      };
      mockGet.mockResolvedValueOnce({ total: 100 });
      mockAll.mockResolvedValueOnce([
        { status: 'active', count: 25 },
        { status: 'acknowledged', count: 15 },
        { status: 'resolved', count: 60 }
      ]);
      mockAll.mockResolvedValueOnce([
        { severity: 'critical', count: 5 },
        { severity: 'high', count: 20 },
        { severity: 'medium', count: 45 },
        { severity: 'low', count: 30 }
      ]);

      const response = await request(app)
        .get('/api/alerts/stats')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ stats: mockStats });
    });

    it('should return 401 without authentication', async () => {
      const response = await request(app)
        .get('/api/alerts/stats');

      expect(response.status).toBe(401);
    });

    it('should handle database errors', async () => {
      mockGet.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .get('/api/alerts/stats')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(500);
    });
  });

  describe('POST /api/alerts/:id/subscribe - Subscribe to Alert Notifications', () => {
    it('should subscribe to alert notifications', async () => {
      const existingAlert = { id: 'alert-1', name: 'Test Alert' };
      mockGet.mockResolvedValue(existingAlert);
      mockRun.mockResolvedValue({ changes: 1 });

      const response = await request(app)
        .post('/api/alerts/alert-1/subscribe')
        .set('Authorization', 'Bearer valid-token')
        .send({ notificationMethod: 'email' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'Successfully subscribed to alert notifications'
      });
      expect(mockRun).toHaveBeenCalled();
    });

    it('should return 404 for non-existent alert', async () => {
      mockGet.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/alerts/non-existent/subscribe')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(404);
    });

    it('should return 400 for invalid notification method', async () => {
      mockGet.mockResolvedValue({ id: 'alert-1' });

      const response = await request(app)
        .post('/api/alerts/alert-1/subscribe')
        .set('Authorization', 'Bearer valid-token')
        .send({ notificationMethod: 'invalid' });

      expect(response.status).toBe(400);
    });

    it('should handle duplicate subscriptions gracefully', async () => {
      mockGet.mockResolvedValue({ id: 'alert-1' });
      mockRun.mockRejectedValue(new Error('UNIQUE constraint failed'));

      const response = await request(app)
        .post('/api/alerts/alert-1/subscribe')
        .set('Authorization', 'Bearer valid-token')
        .send({ notificationMethod: 'email' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'Already subscribed to alert notifications'
      });
    });
  });

  describe('DELETE /api/alerts/:id/subscribe - Unsubscribe from Alert Notifications', () => {
    it('should unsubscribe from alert notifications', async () => {
      const existingAlert = { id: 'alert-1', name: 'Test Alert' };
      mockGet.mockResolvedValue(existingAlert);
      mockRun.mockResolvedValue({ changes: 1 });

      const response = await request(app)
        .delete('/api/alerts/alert-1/subscribe')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'Successfully unsubscribed from alert notifications'
      });
      expect(mockRun).toHaveBeenCalled();
    });

    it('should return 404 for non-existent alert', async () => {
      mockGet.mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/alerts/non-existent/subscribe')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(404);
    });

    it('should handle non-existent subscription gracefully', async () => {
      mockGet.mockResolvedValue({ id: 'alert-1' });
      mockRun.mockResolvedValue({ changes: 0 });

      const response = await request(app)
        .delete('/api/alerts/alert-1/subscribe')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'Not subscribed to alert notifications'
      });
    });
  });

  describe('POST /api/alerts/bulk - Bulk Operations', () => {
    it('should bulk update alerts with admin role', async () => {
      const bulkUpdate = {
        ids: ['alert-1', 'alert-2', 'alert-3'],
        updates: { status: 'resolved' }
      };

      mockGet.mockResolvedValue({ id: 'alert-1', status: 'active' });
      mockRun.mockResolvedValue({ changes: 3 });
      mockSendNotification.mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/api/alerts/bulk')
        .set('Authorization', 'Bearer admin-token')
        .send(bulkUpdate);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'Bulk update completed',
        affected: 3
      });
      expect(mockSendNotification).toHaveBeenCalled();
    });

    it('should return 403 for non-admin user', async () => {
      const response = await request(app)
        .post('/api/alerts/bulk')
        .set('Authorization', 'Bearer valid-token')
        .send({ ids: ['alert-1'], updates: { status: 'resolved' } });

      expect(response.status).toBe(403);
    });

    it('should return 400 for empty ids array', async () => {
      const response = await request(app)
        .post('/api/alerts/bulk')
        .set('Authorization', 'Bearer admin-token')
        .send({ ids: [], updates: { status: 'resolved' } });

      expect(response.status).toBe(400);
    });

    it('should return 400 for missing updates', async () => {
      const response = await request(app)
        .post('/api/alerts/bulk')
        .set('Authorization', 'Bearer admin-token')
        .send({ ids: ['alert-1'] });

      expect(response.status).toBe(400);
    });

    it('should handle bulk delete operation', async () => {
      const bulkDelete = {
        ids: ['alert-1', 'alert-2'],
        operation: 'delete'
      };

      mockRun.mockResolvedValue({ changes: 2 });
      mockSendNotification.mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/api/alerts/bulk')
        .set('Authorization', 'Bearer admin-token')
        .send(bulkDelete);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'Bulk delete completed',
        affected: 2
      });
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle malformed JSON in request body', async () => {
      const response = await request(app)
        .post('/api/alerts')
        .set('Authorization', 'Bearer admin-token')
        .set('Content-Type', 'application/json')
        .send('{ invalid json }');

      expect(response.status).toBe(400);
    });

    it('should handle extremely long alert names', async () => {
      const longName = 'A'.repeat(10000);
      mockGet.mockResolvedValue({ id: 'alert-1' });

      const response = await request(app)
        .put('/api/alerts/alert-1')
        .set('Authorization', 'Bearer admin-token')
        .send({ name: longName });

      expect(response.status).toBe(400);
    });

    it('should handle concurrent updates', async () => {
      const updateData = { status: 'resolved' };
      mockGet.mockResolvedValue({ id: 'alert-1', status: 'active' });
      mockRun.mockRejectedValue(new Error('Database is locked'));

      const response = await request(app)
        .put('/api/alerts/alert-1')
        .set('Authorization', 'Bearer admin-token')
        .send(updateData);

      expect(response.status).toBe(500);
    });

    it('should handle special characters in alert descriptions', async () => {
      const newAlert = {
        name: 'Test Alert',
        severity: 'high',
        status: 'active',
        description: 'Alert with <script>alert("xss")</script> and special chars: @#$%^&*'
      };
      mockRun.mockResolvedValue({ lastInsertRowid: 1 });
      mockGet.mockResolvedValue({
        id: 'alert-1',
        ...newAlert,
        created_at: '2024-01-01T00:00:00Z'
      });

      const response = await request(app)
        .post('/api/alerts')
        .set('Authorization', 'Bearer admin-token')
        .send(newAlert);

      expect(response.status).toBe(201);
    });
  });

  describe('Rate Limiting', () => {
    it('should handle rate limited requests', async () => {
      mockAll.mockResolvedValue([]);

      const promises = Array.from({ length: 101 }, () =>
        request(app)
          .get('/api/alerts')
          .set('Authorization', 'Bearer valid-token')
      );

      const responses = await Promise.all(promises);
      const rateLimitedResponses = responses.filter(r => r.status === 429);

      expect(rateLimitedResponses.length).toBeGreaterThan(0);
    });
  });

  describe('Input Validation', () => {
    it('should validate severity enum values', async () => {
      const validSeverities = ['critical', 'high', 'medium', 'low'];
      
      for (const severity of validSeverities) {
        mockAll.mockResolvedValue([]);
        const response = await request(app)
          .get(`/api/alerts?severity=${severity}`)
          .set('Authorization', 'Bearer valid-token');

        expect(response.status).toBe(200);
      }
    });

    it('should validate status enum values', async () => {
      const validStatuses = ['active', 'acknowledged', 'resolved'];
      
      for (const status of validStatuses) {
        mockAll.mockResolvedValue([]);
        const response = await request(app)
          .get(`/api/alerts?status=${status}`)
          .set('Authorization', 'Bearer valid-token');

        expect(response.status).toBe(200);
      }
    });

    it('should reject invalid pagination parameters', async () => {
      const response = await request(app)
        .get('/api/alerts?page=-1&limit=0')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(400);
    });

    it('should limit maximum pagination size', async () => {
      mockAll.mockResolvedValue([]);
      const response = await request(app)
        .get('/api/alerts?limit=10000')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT ?')
      );
    });
  });
});