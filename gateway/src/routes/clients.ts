import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../services/database.js';
import { uiAuth, wrapperAuth, requireRole, logAudit, type AuthenticatedRequest } from '../middleware/auth.js';
import { broadcastAll } from '../services/websocket.js';

// Validation schemas
const registerClientSchema = z.object({
  displayName: z.string().min(1).max(100),
  agentId: z.string().min(1).max(100),
  version: z.string().optional(),
  capabilities: z.array(z.string()).optional()
});

const updateClientSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  operatorEnabled: z.boolean().optional()
});

const heartbeatSchema = z.object({
  agentId: z.string().min(1).max(100)
});

export interface Client {
  id: string;
  display_name: string;
  agent_id: string;
  last_seen_at: number;
  version: string | null;
  capabilities: string | null;
  status: string;
  operator_enabled: number;
  metadata: string | null;
  created_at: number;
}

export async function clientsRoutes(fastify: FastifyInstance) {
  // Register or update a client (from wrapper)
  fastify.post('/api/clients/register', {
    preHandler: [wrapperAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const body = registerClientSchema.parse(request.body);
    const now = Math.floor(Date.now() / 1000);

    // Check if client already exists by agentId
    const existing = db.prepare(
      'SELECT id FROM clients WHERE agent_id = ?'
    ).get(body.agentId) as { id: string } | undefined;

    if (existing) {
      // Update existing client
      db.prepare(`
        UPDATE clients
        SET display_name = ?, last_seen_at = ?, version = ?, capabilities = ?, status = 'online'
        WHERE agent_id = ?
      `).run(
        body.displayName,
        now,
        body.version || null,
        body.capabilities ? JSON.stringify(body.capabilities) : null,
        body.agentId
      );

      broadcastAll({
        type: 'client_updated',
        clientId: existing.id,
        status: 'online'
      });

      return { id: existing.id, updated: true };
    }

    // Create new client
    const id = nanoid(12);
    db.prepare(`
      INSERT INTO clients (id, display_name, agent_id, last_seen_at, version, capabilities, status)
      VALUES (?, ?, ?, ?, ?, ?, 'online')
    `).run(
      id,
      body.displayName,
      body.agentId,
      now,
      body.version || null,
      body.capabilities ? JSON.stringify(body.capabilities) : null
    );

    broadcastAll({
      type: 'client_registered',
      clientId: id,
      displayName: body.displayName
    });

    return { id, created: true };
  });

  // Heartbeat from wrapper
  fastify.post('/api/clients/heartbeat', {
    preHandler: [wrapperAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const body = heartbeatSchema.parse(request.body);
    const now = Math.floor(Date.now() / 1000);

    const result = db.prepare(`
      UPDATE clients
      SET last_seen_at = ?, status = 'online'
      WHERE agent_id = ?
    `).run(now, body.agentId);

    if (result.changes === 0) {
      return reply.code(404).send({ error: 'Client not registered' });
    }

    return { ok: true, timestamp: now };
  });

  // List clients (UI)
  fastify.get('/api/clients', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    const { status, search, limit = '50', offset = '0' } = request.query as {
      status?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };

    let query = 'SELECT * FROM clients WHERE 1=1';
    const params: any[] = [];

    if (status && status !== 'all') {
      query += ' AND status = ?';
      params.push(status);
    }

    if (search) {
      query += ' AND (display_name LIKE ? OR agent_id LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY last_seen_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const clients = db.prepare(query).all(...params) as Client[];

    // Get run counts for each client
    const clientsWithCounts = clients.map(client => {
      const runCounts = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM runs WHERE client_id = ?
      `).get(client.id) as { total: number; running: number; failed: number };

      return {
        ...client,
        capabilities: client.capabilities ? JSON.parse(client.capabilities) : null,
        metadata: client.metadata ? JSON.parse(client.metadata) : null,
        runCounts
      };
    });

    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) as count FROM clients WHERE 1=1';
    const countParams: any[] = [];
    if (status && status !== 'all') {
      countQuery += ' AND status = ?';
      countParams.push(status);
    }
    if (search) {
      countQuery += ' AND (display_name LIKE ? OR agent_id LIKE ?)';
      countParams.push(`%${search}%`, `%${search}%`);
    }
    const { count } = db.prepare(countQuery).get(...countParams) as { count: number };

    return {
      clients: clientsWithCounts,
      total: count,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    };
  });

  // Get single client with runs
  fastify.get('/api/clients/:clientId', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const { clientId } = request.params as { clientId: string };

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) as Client | undefined;
    if (!client) {
      return reply.code(404).send({ error: 'Client not found' });
    }

    // Get recent runs for this client
    const runs = db.prepare(`
      SELECT id, status, label, command, repo_name, created_at, started_at, finished_at
      FROM runs
      WHERE client_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(clientId);

    // Get recent events for this client's runs
    const recentEvents = db.prepare(`
      SELECT e.id, e.run_id, e.type, e.data, e.timestamp
      FROM events e
      JOIN runs r ON e.run_id = r.id
      WHERE r.client_id = ?
      ORDER BY e.timestamp DESC
      LIMIT 50
    `).all(clientId);

    return {
      ...client,
      capabilities: client.capabilities ? JSON.parse(client.capabilities) : null,
      metadata: client.metadata ? JSON.parse(client.metadata) : null,
      runs,
      recentEvents
    };
  });

  // Update client settings (operator only)
  fastify.patch('/api/clients/:clientId', {
    preHandler: [uiAuth, requireRole('admin', 'operator')]
  }, async (request: AuthenticatedRequest, reply) => {
    const { clientId } = request.params as { clientId: string };
    const body = updateClientSchema.parse(request.body);

    const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
    if (!client) {
      return reply.code(404).send({ error: 'Client not found' });
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (body.displayName !== undefined) {
      updates.push('display_name = ?');
      params.push(body.displayName);
    }
    if (body.operatorEnabled !== undefined) {
      updates.push('operator_enabled = ?');
      params.push(body.operatorEnabled ? 1 : 0);
    }

    if (updates.length > 0) {
      params.push(clientId);
      db.prepare(`UPDATE clients SET ${updates.join(', ')} WHERE id = ?`).run(...params);

      logAudit(request.user?.id, 'client.update', 'client', clientId, body, request.ip);
    }

    return { ok: true };
  });

  // Delete client (admin only)
  fastify.delete('/api/clients/:clientId', {
    preHandler: [uiAuth, requireRole('admin')]
  }, async (request: AuthenticatedRequest, reply) => {
    const { clientId } = request.params as { clientId: string };

    const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
    if (!client) {
      return reply.code(404).send({ error: 'Client not found' });
    }

    db.prepare('DELETE FROM clients WHERE id = ?').run(clientId);
    logAudit(request.user?.id, 'client.delete', 'client', clientId, {}, request.ip);

    return { ok: true };
  });

  // Get client stats for dashboard
  fastify.get('/api/clients/stats', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online,
        SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) as degraded,
        SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as offline
      FROM clients
    `).get() as { total: number; online: number; degraded: number; offline: number };

    return stats;
  });
}
