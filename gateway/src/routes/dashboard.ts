import type { FastifyInstance } from 'fastify';
import { db } from '../services/database.js';
import { uiAuth, type AuthenticatedRequest } from '../middleware/auth.js';

export async function dashboardRoutes(fastify: FastifyInstance) {
  // Get dashboard summary - "Needs Attention" section
  fastify.get('/api/dashboard/needs-attention', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    // Runs waiting approval
    const waitingApproval = db.prepare(`
      SELECT r.id, r.label, r.command, r.created_at, r.client_id,
             c.display_name as client_name
      FROM runs r
      LEFT JOIN clients c ON r.client_id = c.id
      WHERE r.waiting_approval = 1
      ORDER BY r.created_at ASC
    `).all();

    // Failed runs (last 24 hours)
    const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
    const failedRuns = db.prepare(`
      SELECT r.id, r.label, r.command, r.finished_at, r.error_message, r.client_id,
             c.display_name as client_name
      FROM runs r
      LEFT JOIN clients c ON r.client_id = c.id
      WHERE r.status = 'failed' AND r.finished_at > ?
      ORDER BY r.finished_at DESC
      LIMIT 10
    `).all(oneDayAgo);

    // Disconnected clients with active runs
    const disconnectedWithRuns = db.prepare(`
      SELECT c.id, c.display_name, c.last_seen_at, c.status,
             COUNT(r.id) as active_runs
      FROM clients c
      JOIN runs r ON r.client_id = c.id AND r.status = 'running'
      WHERE c.status = 'offline'
      GROUP BY c.id
    `).all();

    // Unacknowledged alerts
    const unacknowledgedAlerts = db.prepare(`
      SELECT id, type, severity, title, message, target_type, target_id, created_at
      FROM alerts
      WHERE acknowledged = 0
      ORDER BY created_at DESC
      LIMIT 10
    `).all();

    return {
      waitingApproval,
      failedRuns,
      disconnectedWithRuns,
      unacknowledgedAlerts,
      counts: {
        waitingApproval: waitingApproval.length,
        failedRuns: failedRuns.length,
        disconnectedWithRuns: disconnectedWithRuns.length,
        unacknowledgedAlerts: unacknowledgedAlerts.length
      }
    };
  });

  // Get active runs for dashboard
  fastify.get('/api/dashboard/active-runs', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    const { limit = '10' } = request.query as { limit?: string };

    const runs = db.prepare(`
      SELECT r.id, r.status, r.label, r.command, r.repo_name, r.created_at, r.started_at,
             r.waiting_approval, r.client_id,
             c.display_name as client_name, c.status as client_status,
             (SELECT COUNT(*) FROM artifacts WHERE run_id = r.id) as artifact_count,
             (SELECT data FROM events WHERE run_id = r.id ORDER BY id DESC LIMIT 1) as last_event
      FROM runs r
      LEFT JOIN clients c ON r.client_id = c.id
      WHERE r.status IN ('running', 'pending')
      ORDER BY
        CASE r.status WHEN 'running' THEN 0 ELSE 1 END,
        r.created_at DESC
      LIMIT ?
    `).all(parseInt(limit, 10));

    return runs;
  });

  // Get recent activity timeline
  fastify.get('/api/dashboard/activity', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    const { limit = '50', types } = request.query as { limit?: string; types?: string };

    // Combine different event sources into a unified timeline
    const activities: any[] = [];
    const limitNum = Math.min(parseInt(limit, 10), 100);

    // Recent run events (status changes via markers)
    const runEvents = db.prepare(`
      SELECT
        'run_event' as activity_type,
        e.id, e.run_id, e.type, e.data, e.timestamp,
        r.label as run_label, r.command as run_command,
        c.display_name as client_name
      FROM events e
      JOIN runs r ON e.run_id = r.id
      LEFT JOIN clients c ON r.client_id = c.id
      WHERE e.type = 'marker'
      ORDER BY e.timestamp DESC
      LIMIT ?
    `).all(limitNum);

    activities.push(...runEvents.map((e: any) => ({
      type: 'run_event',
      id: `event-${e.id}`,
      timestamp: e.timestamp,
      data: {
        runId: e.run_id,
        eventType: e.type,
        eventData: e.data,
        runLabel: e.run_label,
        runCommand: e.run_command,
        clientName: e.client_name
      }
    })));

    // Recent commands
    const commands = db.prepare(`
      SELECT
        'command' as activity_type,
        cmd.id, cmd.run_id, cmd.command, cmd.status, cmd.created_at, cmd.acked_at,
        r.label as run_label,
        c.display_name as client_name
      FROM commands cmd
      JOIN runs r ON cmd.run_id = r.id
      LEFT JOIN clients c ON r.client_id = c.id
      ORDER BY cmd.created_at DESC
      LIMIT ?
    `).all(limitNum);

    activities.push(...commands.map((cmd: any) => ({
      type: 'command',
      id: `command-${cmd.id}`,
      timestamp: cmd.created_at,
      data: {
        commandId: cmd.id,
        command: cmd.command,
        status: cmd.status,
        runId: cmd.run_id,
        runLabel: cmd.run_label,
        clientName: cmd.client_name,
        ackedAt: cmd.acked_at
      }
    })));

    // Recent artifacts
    const artifacts = db.prepare(`
      SELECT
        'artifact' as activity_type,
        a.id, a.run_id, a.name, a.type, a.size, a.created_at,
        r.label as run_label,
        c.display_name as client_name
      FROM artifacts a
      JOIN runs r ON a.run_id = r.id
      LEFT JOIN clients c ON r.client_id = c.id
      ORDER BY a.created_at DESC
      LIMIT ?
    `).all(limitNum);

    activities.push(...artifacts.map((a: any) => ({
      type: 'artifact',
      id: `artifact-${a.id}`,
      timestamp: a.created_at,
      data: {
        artifactId: a.id,
        name: a.name,
        artifactType: a.type,
        size: a.size,
        runId: a.run_id,
        runLabel: a.run_label,
        clientName: a.client_name
      }
    })));

    // Sort all activities by timestamp and limit
    activities.sort((a, b) => b.timestamp - a.timestamp);

    return activities.slice(0, limitNum);
  });

  // Get overall stats
  fastify.get('/api/dashboard/stats', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    const runStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM runs
    `).get() as { total: number; running: number; pending: number; done: number; failed: number };

    const clientStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online,
        SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as offline
      FROM clients
    `).get() as { total: number; online: number; offline: number };

    const alertStats = db.prepare(`
      SELECT COUNT(*) as unacknowledged
      FROM alerts WHERE acknowledged = 0
    `).get() as { unacknowledged: number };

    // Get today's activity count
    const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    const todayEvents = db.prepare(`
      SELECT COUNT(*) as count FROM events WHERE timestamp >= ?
    `).get(todayStart) as { count: number };

    return {
      runs: runStats,
      clients: clientStats,
      alerts: alertStats,
      todayEvents: todayEvents.count
    };
  });
}
