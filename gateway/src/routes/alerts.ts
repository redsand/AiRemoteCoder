import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../services/database.js';
import { uiAuth, requireRole, logAudit, type AuthenticatedRequest } from '../middleware/auth.js';
import { broadcastAll } from '../services/websocket.js';

// Alert rule types
const alertRuleTypes = ['run_failed', 'waiting_approval_timeout', 'client_offline_active_runs'] as const;

// Validation schemas
const createAlertRuleSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(alertRuleTypes),
  config: z.object({
    timeoutMinutes: z.number().int().min(1).max(1440).optional() // For waiting_approval_timeout
  }).optional(),
  enabled: z.boolean().optional()
});

const updateAlertRuleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  config: z.object({
    timeoutMinutes: z.number().int().min(1).max(1440).optional()
  }).optional(),
  enabled: z.boolean().optional()
});

export interface AlertRule {
  id: string;
  name: string;
  type: string;
  config: string;
  enabled: number;
  created_at: number;
}

export interface Alert {
  id: string;
  rule_id: string | null;
  type: string;
  severity: string;
  title: string;
  message: string | null;
  target_type: string | null;
  target_id: string | null;
  acknowledged: number;
  acknowledged_by: string | null;
  acknowledged_at: number | null;
  created_at: number;
}

export async function alertsRoutes(fastify: FastifyInstance) {
  // List alert rules
  fastify.get('/api/alerts/rules', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    const rules = db.prepare(`
      SELECT * FROM alert_rules ORDER BY created_at DESC
    `).all() as AlertRule[];

    return rules.map(rule => ({
      ...rule,
      config: JSON.parse(rule.config)
    }));
  });

  // Create alert rule (operator only)
  fastify.post('/api/alerts/rules', {
    preHandler: [uiAuth, requireRole('admin', 'operator')]
  }, async (request: AuthenticatedRequest) => {
    const body = createAlertRuleSchema.parse(request.body);
    const id = nanoid(12);

    db.prepare(`
      INSERT INTO alert_rules (id, name, type, config, enabled)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, body.name, body.type, JSON.stringify(body.config || {}), body.enabled !== false ? 1 : 0);

    logAudit(request.user?.id, 'alert_rule.create', 'alert_rule', id, body, request.ip);

    return { id };
  });

  // Update alert rule
  fastify.patch('/api/alerts/rules/:ruleId', {
    preHandler: [uiAuth, requireRole('admin', 'operator')]
  }, async (request: AuthenticatedRequest, reply) => {
    const { ruleId } = request.params as { ruleId: string };
    const body = updateAlertRuleSchema.parse(request.body);

    const rule = db.prepare('SELECT id FROM alert_rules WHERE id = ?').get(ruleId);
    if (!rule) {
      return reply.code(404).send({ error: 'Alert rule not found' });
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      params.push(body.name);
    }
    if (body.config !== undefined) {
      updates.push('config = ?');
      params.push(JSON.stringify(body.config));
    }
    if (body.enabled !== undefined) {
      updates.push('enabled = ?');
      params.push(body.enabled ? 1 : 0);
    }

    if (updates.length > 0) {
      params.push(ruleId);
      db.prepare(`UPDATE alert_rules SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      logAudit(request.user?.id, 'alert_rule.update', 'alert_rule', ruleId, body, request.ip);
    }

    return { ok: true };
  });

  // Delete alert rule
  fastify.delete('/api/alerts/rules/:ruleId', {
    preHandler: [uiAuth, requireRole('admin')]
  }, async (request: AuthenticatedRequest, reply) => {
    const { ruleId } = request.params as { ruleId: string };

    const rule = db.prepare('SELECT id FROM alert_rules WHERE id = ?').get(ruleId);
    if (!rule) {
      return reply.code(404).send({ error: 'Alert rule not found' });
    }

    db.prepare('DELETE FROM alert_rules WHERE id = ?').run(ruleId);
    logAudit(request.user?.id, 'alert_rule.delete', 'alert_rule', ruleId, {}, request.ip);

    return { ok: true };
  });

  // List alerts
  fastify.get('/api/alerts', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    const { acknowledged, severity, limit = '50', offset = '0' } = request.query as {
      acknowledged?: string;
      severity?: string;
      limit?: string;
      offset?: string;
    };

    let query = 'SELECT * FROM alerts WHERE 1=1';
    const params: any[] = [];

    if (acknowledged !== undefined) {
      query += ' AND acknowledged = ?';
      params.push(acknowledged === 'true' ? 1 : 0);
    }

    if (severity) {
      query += ' AND severity = ?';
      params.push(severity);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const alerts = db.prepare(query).all(...params) as Alert[];

    // Get unacknowledged count
    const { unacknowledged } = db.prepare(
      'SELECT COUNT(*) as unacknowledged FROM alerts WHERE acknowledged = 0'
    ).get() as { unacknowledged: number };

    return {
      alerts,
      unacknowledged
    };
  });

  // Acknowledge alert
  fastify.post('/api/alerts/:alertId/acknowledge', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const { alertId } = request.params as { alertId: string };

    const alert = db.prepare('SELECT id FROM alerts WHERE id = ?').get(alertId);
    if (!alert) {
      return reply.code(404).send({ error: 'Alert not found' });
    }

    db.prepare(`
      UPDATE alerts
      SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = unixepoch()
      WHERE id = ?
    `).run(request.user?.id || null, alertId);

    broadcastAll({
      type: 'alert_acknowledged',
      alertId
    });

    return { ok: true };
  });

  // Acknowledge all alerts
  fastify.post('/api/alerts/acknowledge-all', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    const result = db.prepare(`
      UPDATE alerts
      SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = unixepoch()
      WHERE acknowledged = 0
    `).run(request.user?.id || null);

    broadcastAll({
      type: 'alerts_all_acknowledged'
    });

    return { ok: true, count: result.changes };
  });

  // Get alert stats for dashboard
  fastify.get('/api/alerts/stats', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN acknowledged = 0 THEN 1 ELSE 0 END) as unacknowledged,
        SUM(CASE WHEN severity = 'critical' AND acknowledged = 0 THEN 1 ELSE 0 END) as critical,
        SUM(CASE WHEN severity = 'warning' AND acknowledged = 0 THEN 1 ELSE 0 END) as warning
      FROM alerts
    `).get() as { total: number; unacknowledged: number; critical: number; warning: number };

    return stats;
  });
}

// Helper function to create an alert (called from other parts of the system)
export function createAlert(
  type: string,
  title: string,
  options: {
    ruleId?: string;
    severity?: 'info' | 'warning' | 'critical';
    message?: string;
    targetType?: string;
    targetId?: string;
  } = {}
) {
  const id = nanoid(12);

  db.prepare(`
    INSERT INTO alerts (id, rule_id, type, severity, title, message, target_type, target_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    options.ruleId || null,
    type,
    options.severity || 'info',
    title,
    options.message || null,
    options.targetType || null,
    options.targetId || null
  );

  broadcastAll({
    type: 'new_alert',
    alertId: id,
    alertType: type,
    severity: options.severity || 'info',
    title
  });

  return id;
}
