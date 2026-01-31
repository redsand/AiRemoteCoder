/**
 * VNC Routes - API endpoints for VNC tunnel management
 *
 * Endpoints:
 * - GET /api/runs/:runId/vnc - Get VNC connection status
 * - POST /api/runs/:runId/vnc/start - Send command to start VNC streaming
 * - DELETE /api/runs/:runId/vnc - Close VNC tunnel
 * - GET /api/vnc/stats - Get tunnel statistics
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { db } from '../services/database.js';
import { vncTunnelManager } from '../services/vnc-tunnel.js';

interface Run {
  id: string;
  worker_type: string;
}

export async function vncRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/runs/:runId/vnc
   * Get VNC connection status for a run
   */
  fastify.get<{ Params: { runId: string } }>(
    '/api/runs/:runId/vnc',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { runId } = request.params as { runId: string };

      try {
        // Verify run exists
        const run = db.prepare('SELECT id, worker_type FROM runs WHERE id = ?').get(runId) as Run | undefined;
        if (!run) {
          return reply.code(404).send({ error: 'Run not found' });
        }

        // Only VNC workers have VNC access
        if (run.worker_type !== 'vnc') {
          return reply.code(400).send({ error: 'Run is not a VNC worker' });
        }

        const tunnel = vncTunnelManager.getTunnel(runId);
        const stats = vncTunnelManager.getTunnelStats(runId);

        return {
          runId,
          available: !!tunnel,
          status: stats?.status || 'disconnected',
          clientConnected: stats?.clientConnected || false,
          viewerConnected: stats?.viewerConnected || false,
          wsUrl: `/ws/vnc/${runId}`,
          stats: stats || null
        };
      } catch (err: any) {
        fastify.log.error(`Error getting VNC status: ${err.message}`);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }
  );

  /**
   * POST /api/runs/:runId/vnc/start
   * Send __START_VNC_STREAM__ command to Python VNC runner
   */
  fastify.post<{ Params: { runId: string } }>(
    '/api/runs/:runId/vnc/start',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { runId } = request.params as { runId: string };

      try {
        // Verify run exists
        const run = db.prepare('SELECT id, worker_type FROM runs WHERE id = ?').get(runId) as Run | undefined;
        if (!run) {
          return reply.code(404).send({ error: 'Run not found' });
        }

        // Only VNC workers can start streaming
        if (run.worker_type !== 'vnc') {
          return reply.code(400).send({ error: 'Run is not a VNC worker' });
        }

        // Create tunnel if it doesn't exist
        if (!vncTunnelManager.getTunnel(runId)) {
          vncTunnelManager.createTunnel(runId);
        }

        // Send __START_VNC_STREAM__ command to the VNC runner
        const commandColumns = db.prepare("PRAGMA table_info(commands)").all() as Array<{ name: string }>;
        const hasArguments = commandColumns.some((col) => col.name === 'arguments');

        const id = nanoid(12);
        const commandId = hasArguments
          ? db.prepare(
              `INSERT INTO commands (id, run_id, command, arguments, created_at)
               VALUES (?, ?, ?, ?, datetime('now'))
               RETURNING id`
            ).get(id, runId, '__START_VNC_STREAM__', JSON.stringify({})) as any
          : db.prepare(
              `INSERT INTO commands (id, run_id, command, created_at)
               VALUES (?, ?, ?, datetime('now'))
               RETURNING id`
            ).get(id, runId, '__START_VNC_STREAM__') as any;

        return reply.code(200).send({
          runId,
          command: '__START_VNC_STREAM__',
          commandId: commandId.id,
          wsUrl: `/ws/vnc/${runId}`,
          message: 'VNC streaming started - client should connect to WebSocket now'
        });
      } catch (err: any) {
        fastify.log.error(`Error starting VNC streaming: ${err.message}`);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }
  );

  /**
   * DELETE /api/runs/:runId/vnc
   * Close VNC tunnel and stop streaming
   */
  fastify.delete<{ Params: { runId: string } }>(
    '/api/runs/:runId/vnc',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { runId } = request.params as { runId: string };

      try {
        // Verify run exists
        const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(runId) as Run | undefined;
        if (!run) {
          return reply.code(404).send({ error: 'Run not found' });
        }

        // Close tunnel
        vncTunnelManager.closeTunnel(runId);

        return reply.code(200).send({
          runId,
          message: 'VNC tunnel closed'
        });
      } catch (err: any) {
        fastify.log.error(`Error closing VNC tunnel: ${err.message}`);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }
  );

  /**
   * GET /api/vnc/stats
   * Get statistics for all active VNC tunnels
   */
  fastify.get('/api/vnc/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const stats = {
        activeTunnels: vncTunnelManager.getActiveTunnelCount(),
        pendingTunnels: vncTunnelManager.getPendingTunnelCount(),
        tunnels: vncTunnelManager.getAllTunnelStats()
      };

      return reply.code(200).send(stats);
    } catch (err: any) {
      fastify.log.error(`Error getting VNC stats: ${err.message}`);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}
