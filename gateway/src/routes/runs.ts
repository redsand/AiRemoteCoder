import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../services/database.js';
import { config } from '../config.js';
import { wrapperAuth, uiAuth, requireRole, logAudit, type AuthenticatedRequest } from '../middleware/auth.js';
import { generateCapabilityToken, redactSecrets } from '../utils/crypto.js';
import { broadcastToRun } from '../services/websocket.js';

// Validation schemas
const createRunSchema = z.object({
  command: z.string().optional(),
  metadata: z.record(z.any()).optional()
});

const eventSchema = z.object({
  type: z.enum(['stdout', 'stderr', 'marker', 'info', 'error', 'assist']),
  data: z.string(),
  sequence: z.number().int().min(0).optional()
});

const commandSchema = z.object({
  command: z.string()
});

const ackSchema = z.object({
  result: z.string().optional(),
  error: z.string().optional()
});

export async function runsRoutes(fastify: FastifyInstance) {
  // Create a new run (from UI or self-registration by wrapper)
  fastify.post('/api/runs', {
    preHandler: [uiAuth, requireRole('admin', 'operator')],
    schema: {
      body: createRunSchema
    }
  }, async (request: AuthenticatedRequest, reply) => {
    const body = createRunSchema.parse(request.body);
    const id = nanoid(12);
    const capabilityToken = generateCapabilityToken();

    db.prepare(`
      INSERT INTO runs (id, command, capability_token, metadata)
      VALUES (?, ?, ?, ?)
    `).run(id, body.command || null, capabilityToken, body.metadata ? JSON.stringify(body.metadata) : null);

    logAudit(request.user?.id, 'run.create', 'run', id, { command: body.command }, request.ip);

    return {
      id,
      capabilityToken, // Only returned on creation
      status: 'pending'
    };
  });

  // List runs
  fastify.get('/api/runs', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    const runs = db.prepare(`
      SELECT id, status, command, created_at, started_at, finished_at, exit_code, error_message, metadata
      FROM runs
      ORDER BY created_at DESC
      LIMIT 100
    `).all();

    return runs.map((r: any) => ({
      ...r,
      metadata: r.metadata ? JSON.parse(r.metadata) : null
    }));
  });

  // Get single run
  fastify.get('/api/runs/:runId', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };

    const run = db.prepare(`
      SELECT id, status, command, created_at, started_at, finished_at, exit_code, error_message, metadata
      FROM runs WHERE id = ?
    `).get(runId) as any;

    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    const artifacts = db.prepare(`
      SELECT id, name, type, size, created_at
      FROM artifacts WHERE run_id = ?
    `).all(runId);

    return {
      ...run,
      metadata: run.metadata ? JSON.parse(run.metadata) : null,
      artifacts
    };
  });

  // Get run events (with pagination)
  fastify.get('/api/runs/:runId/events', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };
    const { after, limit } = request.query as { after?: string; limit?: string };

    const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(runId);
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    const afterId = after ? parseInt(after, 10) : 0;
    const limitNum = Math.min(parseInt(limit || '100', 10), 1000);

    const events = db.prepare(`
      SELECT id, type, data, timestamp, sequence
      FROM events
      WHERE run_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(runId, afterId, limitNum);

    return events;
  });

  // Wrapper: ingest event
  fastify.post('/api/ingest/event', {
    preHandler: [wrapperAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const body = eventSchema.parse(request.body);
    const runId = request.runAuth?.runId;

    if (!runId) {
      return reply.code(400).send({ error: 'Run ID required' });
    }

    // Redact secrets from data
    const sanitizedData = redactSecrets(body.data);

    const result = db.prepare(`
      INSERT INTO events (run_id, type, data, sequence)
      VALUES (?, ?, ?, ?)
    `).run(runId, body.type, sanitizedData, body.sequence || 0);

    // Update run status if needed
    if (body.type === 'marker') {
      const marker = JSON.parse(body.data);
      if (marker.event === 'started') {
        db.prepare('UPDATE runs SET status = ?, started_at = unixepoch() WHERE id = ?')
          .run('running', runId);
      } else if (marker.event === 'finished') {
        db.prepare('UPDATE runs SET status = ?, finished_at = unixepoch(), exit_code = ? WHERE id = ?')
          .run(marker.exitCode === 0 ? 'done' : 'failed', marker.exitCode, runId);
      }
    }

    // Broadcast to WebSocket subscribers
    broadcastToRun(runId, {
      type: 'event',
      eventId: result.lastInsertRowid,
      eventType: body.type,
      data: sanitizedData,
      timestamp: Math.floor(Date.now() / 1000)
    });

    return { ok: true, eventId: result.lastInsertRowid };
  });

  // UI: send command to wrapper
  fastify.post('/api/runs/:runId/command', {
    preHandler: [uiAuth, requireRole('admin', 'operator')]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };
    const body = commandSchema.parse(request.body);

    // Validate run exists and is running
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as any;
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }
    if (run.status !== 'running') {
      return reply.code(400).send({ error: 'Run is not active' });
    }

    // Validate command is allowlisted
    const cmdBase = body.command.trim();
    const isAllowed = config.allowlistedCommands.some(allowed =>
      cmdBase === allowed || cmdBase.startsWith(allowed + ' ')
    );

    if (!isAllowed) {
      logAudit(request.user?.id, 'command.rejected', 'run', runId, { command: body.command }, request.ip);
      return reply.code(403).send({
        error: 'Command not in allowlist',
        allowedCommands: config.allowlistedCommands
      });
    }

    const id = nanoid(12);
    db.prepare(`
      INSERT INTO commands (id, run_id, command)
      VALUES (?, ?, ?)
    `).run(id, runId, body.command);

    logAudit(request.user?.id, 'command.sent', 'run', runId, { commandId: id, command: body.command }, request.ip);

    // Notify via WebSocket
    broadcastToRun(runId, {
      type: 'command_queued',
      commandId: id,
      command: body.command
    });

    return { commandId: id };
  });

  // Wrapper: poll for commands
  fastify.get('/api/runs/:runId/commands', {
    preHandler: [wrapperAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };

    if (request.runAuth?.runId !== runId) {
      return reply.code(403).send({ error: 'Capability token mismatch' });
    }

    const commands = db.prepare(`
      SELECT id, command, created_at
      FROM commands
      WHERE run_id = ? AND status = 'pending'
      ORDER BY created_at ASC
    `).all(runId);

    return commands;
  });

  // Wrapper: acknowledge command
  fastify.post('/api/runs/:runId/commands/:commandId/ack', {
    preHandler: [wrapperAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId, commandId } = request.params as { runId: string; commandId: string };
    const body = ackSchema.parse(request.body);

    if (request.runAuth?.runId !== runId) {
      return reply.code(403).send({ error: 'Capability token mismatch' });
    }

    db.prepare(`
      UPDATE commands
      SET status = 'completed', acked_at = unixepoch(), result = ?, error = ?
      WHERE id = ? AND run_id = ?
    `).run(body.result || null, body.error || null, commandId, runId);

    // Broadcast result to UI
    broadcastToRun(runId, {
      type: 'command_completed',
      commandId,
      result: body.result,
      error: body.error
    });

    return { ok: true };
  });

  // Stop run request
  fastify.post('/api/runs/:runId/stop', {
    preHandler: [uiAuth, requireRole('admin', 'operator')]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };

    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as any;
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    // Queue stop command
    const id = nanoid(12);
    db.prepare(`
      INSERT INTO commands (id, run_id, command)
      VALUES (?, ?, ?)
    `).run(id, runId, '__STOP__');

    logAudit(request.user?.id, 'run.stop_requested', 'run', runId, {}, request.ip);

    broadcastToRun(runId, {
      type: 'stop_requested',
      commandId: id
    });

    return { ok: true, commandId: id };
  });

  // Delete run
  fastify.delete('/api/runs/:runId', {
    preHandler: [uiAuth, requireRole('admin')]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };

    const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(runId);
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
    logAudit(request.user?.id, 'run.delete', 'run', runId, {}, request.ip);

    return { ok: true };
  });
}
