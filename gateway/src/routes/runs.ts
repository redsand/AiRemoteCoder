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
  label: z.string().max(200).optional(),
  clientId: z.string().optional(),
  agentId: z.string().optional(), // For auto-associating with client
  repoPath: z.string().optional(),
  repoName: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
  workingDir: z.string().optional(),
  autonomous: z.boolean().optional(),
  workerType: z.enum(['claude', 'ollama-launch', 'codex', 'gemini', 'rev', 'vnc', 'hands-on']).optional().default('claude'),
  model: z.string().optional(),
  integration: z.enum(['claude', 'codex', 'opencode', 'droid']).optional(), // For ollama-launch
  provider: z.string().optional() // For rev
});

const listRunsSchema = z.object({
  status: z.enum(['pending', 'running', 'done', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().optional()
});

const stdinInputSchema = z.object({
  input: z.string(),
  escape: z.boolean().optional() // Send escape sequence
});

const restartSchema = z.object({
  command: z.string().optional(), // Override command
  workingDir: z.string().optional() // Override working directory
});

const eventSchema = z.object({
  type: z.enum(['stdout', 'stderr', 'marker', 'info', 'error', 'assist', 'prompt_waiting', 'prompt_resolved']),
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
    preHandler: [uiAuth, requireRole('admin', 'operator')]
  }, async (request: AuthenticatedRequest, reply) => {
    const body = createRunSchema.parse(request.body);
    const id = nanoid(12);
    const capabilityToken = generateCapabilityToken();

    // Find client by agentId if provided
    let clientId = body.clientId || null;
    if (!clientId && body.agentId) {
      const client = db.prepare('SELECT id FROM clients WHERE agent_id = ?').get(body.agentId) as { id: string } | undefined;
      if (client) {
        clientId = client.id;
      }
    }

    // Merge metadata with workflow control fields
    const metadata = {
      ...body.metadata,
      autonomous: body.autonomous || false,
      workingDir: body.workingDir,
      workerType: body.workerType || 'claude',
      model: body.model,
      ...(body.integration && { integration: body.integration }),
      ...(body.provider && { provider: body.provider })
    };

    const workerType = body.workerType || 'claude';

    db.prepare(`
      INSERT INTO runs (id, client_id, label, command, repo_path, repo_name, tags, capability_token, metadata, worker_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      clientId,
      body.label || null,
      body.command || null,
      body.repoPath || null,
      body.repoName || null,
      body.tags ? JSON.stringify(body.tags) : null,
      capabilityToken,
      JSON.stringify(metadata),
      workerType
    );

    // Save initial run state for resume capability
    if (body.workingDir) {
      db.prepare(`
        INSERT INTO run_state (run_id, working_dir, original_command)
        VALUES (?, ?, ?)
      `).run(id, body.workingDir, body.command || null);
    }

    logAudit(request.user?.id, 'run.create', 'run', id, { command: body.command, clientId, autonomous: body.autonomous }, request.ip);

    return {
      id,
      capabilityToken, // Only returned on creation
      status: 'pending',
      autonomous: body.autonomous || false
    };
  });

  // List runs with filtering, search, and pagination
  fastify.get('/api/runs', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    const {
      status,
      clientId,
      search,
      repo,
      waitingApproval,
      tags,
      workerType,
      limit = '50',
      offset = '0',
      cursor,
      sortBy = 'created_at',
      sortOrder = 'desc'
    } = request.query as {
      status?: string;
      clientId?: string;
      search?: string;
      repo?: string;
      waitingApproval?: string;
      tags?: string;
      workerType?: string;
      limit?: string;
      offset?: string;
      cursor?: string;
      sortBy?: string;
      sortOrder?: string;
    };

    let query = `
      SELECT r.id, r.status, r.label, r.command, r.repo_path, r.repo_name,
             r.waiting_approval, r.created_at, r.started_at, r.finished_at,
             r.exit_code, r.error_message, r.metadata, r.tags, r.client_id,
             c.display_name as client_name, c.status as client_status,
             (SELECT COUNT(*) FROM artifacts WHERE run_id = r.id) as artifact_count,
             (SELECT data FROM events WHERE run_id = r.id AND type = 'assist' LIMIT 1) as assist_data,
             r.worker_type
      FROM runs r
      LEFT JOIN clients c ON r.client_id = c.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (status && status !== 'all') {
      query += ' AND r.status = ?';
      params.push(status);
    }

    if (clientId) {
      query += ' AND r.client_id = ?';
      params.push(clientId);
    }

    if (workerType && workerType !== 'all') {
      query += ' AND r.worker_type = ?';
      params.push(workerType);
    }

    if (search) {
      query += ' AND (r.id LIKE ? OR r.label LIKE ? OR r.command LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (repo) {
      query += ' AND (r.repo_path LIKE ? OR r.repo_name LIKE ?)';
      params.push(`%${repo}%`, `%${repo}%`);
    }

    if (waitingApproval === 'true') {
      query += ' AND r.waiting_approval = 1';
    }

    if (tags) {
      const tagList = tags.split(',');
      tagList.forEach(tag => {
        query += ' AND r.tags LIKE ?';
        params.push(`%"${tag}"%`);
      });
    }

    // Cursor-based pagination (for WebSocket real-time updates)
    if (cursor) {
      query += ' AND r.id < ?';
      params.push(cursor);
    }

    // Validate sort column
    const allowedSorts = ['created_at', 'started_at', 'finished_at', 'status'];
    const sortCol = allowedSorts.includes(sortBy) ? sortBy : 'created_at';
    const sortDir = sortOrder === 'asc' ? 'ASC' : 'DESC';

    query += ` ORDER BY r.${sortCol} ${sortDir} LIMIT ? OFFSET ?`;
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const runs = db.prepare(query).all(...params);

    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) as count FROM runs r WHERE 1=1';
    const countParams: any[] = [];
    if (status && status !== 'all') {
      countQuery += ' AND r.status = ?';
      countParams.push(status);
    }
    if (clientId) {
      countQuery += ' AND r.client_id = ?';
      countParams.push(clientId);
    }
    if (search) {
      countQuery += ' AND (r.id LIKE ? OR r.label LIKE ? OR r.command LIKE ?)';
      countParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (repo) {
      countQuery += ' AND (r.repo_path LIKE ? OR r.repo_name LIKE ?)';
      countParams.push(`%${repo}%`, `%${repo}%`);
    }
    if (waitingApproval === 'true') {
      countQuery += ' AND r.waiting_approval = 1';
    }

    const { count } = db.prepare(countQuery).get(...countParams) as { count: number };

    return {
      runs: runs.map((r: any) => ({
        ...r,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
        tags: r.tags ? JSON.parse(r.tags) : null,
        hasAssist: !!r.assist_data
      })),
      total: count,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      hasMore: parseInt(offset, 10) + runs.length < count
    };
  });

  // Get single run with full details
  fastify.get('/api/runs/:runId', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };

    const run = db.prepare(`
      SELECT r.id, r.status, r.label, r.command, r.repo_path, r.repo_name,
             r.waiting_approval, r.created_at, r.started_at, r.finished_at,
             r.exit_code, r.error_message, r.metadata, r.tags, r.client_id,
             c.display_name as client_name, c.agent_id as client_agent_id, c.status as client_status,
             r.worker_type
      FROM runs r
      LEFT JOIN clients c ON r.client_id = c.id
      WHERE r.id = ?
    `).get(runId) as any;

    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    // Get artifacts
    const artifacts = db.prepare(`
      SELECT id, name, type, size, created_at
      FROM artifacts WHERE run_id = ?
      ORDER BY created_at DESC
    `).all(runId);

    // Get commands/audit trail
    const commands = db.prepare(`
      SELECT id, command, status, created_at, acked_at, result, error
      FROM commands WHERE run_id = ?
      ORDER BY created_at DESC
    `).all(runId);

    // Get assist session if any
    const assistEvent = db.prepare(`
      SELECT data FROM events WHERE run_id = ? AND type = 'assist' ORDER BY timestamp DESC LIMIT 1
    `).get(runId) as { data: string } | undefined;

    // Calculate duration
    let duration = null;
    if (run.started_at) {
      const endTime = run.finished_at || Math.floor(Date.now() / 1000);
      duration = endTime - run.started_at;
    }

    return {
      ...run,
      metadata: run.metadata ? JSON.parse(run.metadata) : null,
      tags: run.tags ? JSON.parse(run.tags) : null,
      artifacts,
      commands,
      assistUrl: assistEvent ? JSON.parse(assistEvent.data).url : null,
      duration
    };
  });

  // Get run commands/audit separately (for tab)
  fastify.get('/api/runs/:runId/audit', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };

    const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(runId);
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    const commands = db.prepare(`
      SELECT id, command, status, created_at, acked_at, result, error
      FROM commands WHERE run_id = ?
      ORDER BY created_at DESC
    `).all(runId);

    // Get related audit entries
    const auditEntries = db.prepare(`
      SELECT id, user_id, action, details, ip_address, timestamp
      FROM audit_log
      WHERE target_type = 'run' AND target_id = ?
      ORDER BY timestamp DESC
      LIMIT 50
    `).all(runId);

    return { commands, auditEntries };
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

  // Hard halt run (immediate SIGKILL)
  fastify.post('/api/runs/:runId/halt', {
    preHandler: [uiAuth, requireRole('admin', 'operator')]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };

    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as any;
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    if (run.status !== 'running') {
      return reply.code(400).send({ error: 'Run is not active' });
    }

    // Queue hard halt command
    const id = nanoid(12);
    db.prepare(`
      INSERT INTO commands (id, run_id, command)
      VALUES (?, ?, ?)
    `).run(id, runId, '__HALT__');

    logAudit(request.user?.id, 'run.halt_requested', 'run', runId, {}, request.ip);

    broadcastToRun(runId, {
      type: 'halt_requested',
      commandId: id
    });

    return { ok: true, commandId: id };
  });

  // Restart run with same or new configuration
  fastify.post('/api/runs/:runId/restart', {
    preHandler: [uiAuth, requireRole('admin', 'operator')]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };
    const body = restartSchema.parse(request.body || {});

    const run = db.prepare(`
      SELECT id, status, command, metadata FROM runs WHERE id = ?
    `).get(runId) as any;
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    // Get saved run state
    const state = db.prepare(`
      SELECT working_dir, original_command FROM run_state WHERE run_id = ?
    `).get(runId) as any;

    // Create new run with same/overridden config
    const newId = nanoid(12);
    const newToken = generateCapabilityToken();
    const metadata = run.metadata ? JSON.parse(run.metadata) : {};

    const newCommand = body.command || run.command || state?.original_command;
    const newWorkingDir = body.workingDir || metadata.workingDir || state?.working_dir;

    const newMetadata = {
      ...metadata,
      workingDir: newWorkingDir,
      restartedFrom: runId
    };

    db.prepare(`
      INSERT INTO runs (id, command, capability_token, metadata)
      VALUES (?, ?, ?, ?)
    `).run(newId, newCommand, newToken, JSON.stringify(newMetadata));

    // Save state for new run
    if (newWorkingDir) {
      db.prepare(`
        INSERT INTO run_state (run_id, working_dir, original_command)
        VALUES (?, ?, ?)
      `).run(newId, newWorkingDir, newCommand);
    }

    logAudit(request.user?.id, 'run.restart', 'run', newId, {
      originalRunId: runId,
      command: newCommand
    }, request.ip);

    return {
      id: newId,
      capabilityToken: newToken,
      status: 'pending',
      restartedFrom: runId
    };
  });

  // Send stdin input to running process
  fastify.post('/api/runs/:runId/input', {
    preHandler: [uiAuth, requireRole('admin', 'operator')]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };
    const body = stdinInputSchema.parse(request.body);

    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as any;
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    if (run.status !== 'running') {
      return reply.code(400).send({ error: 'Run is not active' });
    }

    // Build the input command with optional escape
    let inputData = body.input;
    if (body.escape) {
      // Send escape sequence (Ctrl+C equivalent)
      inputData = '\x03' + inputData;
    }

    const id = nanoid(12);
    db.prepare(`
      INSERT INTO commands (id, run_id, command)
      VALUES (?, ?, ?)
    `).run(id, runId, `__INPUT__:${inputData}`);

    logAudit(request.user?.id, 'run.input_sent', 'run', runId, {
      escape: body.escape,
      length: body.input.length
    }, request.ip);

    broadcastToRun(runId, {
      type: 'input_sent',
      commandId: id,
      escape: body.escape
    });

    return { ok: true, commandId: id };
  });

  // Send escape/interrupt to running process
  fastify.post('/api/runs/:runId/escape', {
    preHandler: [uiAuth, requireRole('admin', 'operator')]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };

    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as any;
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    if (run.status !== 'running') {
      return reply.code(400).send({ error: 'Run is not active' });
    }

    const id = nanoid(12);
    db.prepare(`
      INSERT INTO commands (id, run_id, command)
      VALUES (?, ?, ?)
    `).run(id, runId, '__ESCAPE__');

    logAudit(request.user?.id, 'run.escape_sent', 'run', runId, {}, request.ip);

    broadcastToRun(runId, {
      type: 'escape_sent',
      commandId: id
    });

    return { ok: true, commandId: id };
  });

  // Get run state for resume
  fastify.get('/api/runs/:runId/state', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };

    const run = db.prepare(`
      SELECT id, status, command, created_at, started_at, finished_at, exit_code, metadata
      FROM runs WHERE id = ?
    `).get(runId) as any;

    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    const state = db.prepare(`
      SELECT working_dir, original_command, last_sequence, stdin_buffer, environment
      FROM run_state WHERE run_id = ?
    `).get(runId) as any;

    // Get last few events for context
    const recentEvents = db.prepare(`
      SELECT id, type, data, timestamp, sequence
      FROM events
      WHERE run_id = ?
      ORDER BY id DESC
      LIMIT 50
    `).all(runId);

    return {
      run: {
        ...run,
        metadata: run.metadata ? JSON.parse(run.metadata) : null
      },
      state: state || null,
      recentEvents: recentEvents.reverse(),
      canResume: run.status === 'done' || run.status === 'failed'
    };
  });

  // Wrapper: update run state
  fastify.post('/api/runs/:runId/state', {
    preHandler: [wrapperAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };
    const body = request.body as {
      workingDir?: string;
      lastSequence?: number;
      stdinBuffer?: string;
      environment?: Record<string, string>;
    };

    if (request.runAuth?.runId !== runId) {
      return reply.code(403).send({ error: 'Capability token mismatch' });
    }

    // Upsert run state
    db.prepare(`
      INSERT INTO run_state (run_id, working_dir, last_sequence, stdin_buffer, environment)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        working_dir = COALESCE(excluded.working_dir, run_state.working_dir),
        last_sequence = COALESCE(excluded.last_sequence, run_state.last_sequence),
        stdin_buffer = COALESCE(excluded.stdin_buffer, run_state.stdin_buffer),
        environment = COALESCE(excluded.environment, run_state.environment),
        updated_at = unixepoch()
    `).run(
      runId,
      body.workingDir || process.cwd(),
      body.lastSequence || 0,
      body.stdinBuffer || null,
      body.environment ? JSON.stringify(body.environment) : null
    );

    return { ok: true };
  });
}
