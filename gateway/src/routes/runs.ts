import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../services/database.js';
import { config } from '../config.js';
import { uiAuth, requireRole, logAudit, type AuthenticatedRequest } from '../middleware/auth.js';
import { generateCapabilityToken, redactSecrets } from '../utils/crypto.js';
import { broadcastToRun } from '../services/websocket.js';
import { findLatestMcpSessionByTokenId, getMcpSession, upsertMcpRunnerHost } from '../mcp/session-registry.js';
import { assertScopes, extractBearerToken, validateMcpSessionAccess, validateMcpToken } from '../mcp/auth.js';
import type { McpScope } from '../domain/types.js';

const MCP_SESSION_FRESHNESS_SECONDS = 90;

function providerFromTokenLabel(label: string | undefined): string | null {
  if (!label) return null;
  const normalized = label.trim().toLowerCase();
  if (!normalized.startsWith('auto:')) return null;
  const provider = normalized.slice('auto:'.length);
  return provider || null;
}

// Validation schemas
const createRunSchema = z.object({
  command: z.string().optional(),
  label: z.string().max(200).optional(),
  repoPath: z.string().optional(),
  repoName: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
  workingDir: z.string().optional(),
  autonomous: z.boolean().optional(),
  workerType: z.enum(['claude', 'ollama-launch', 'codex', 'gemini', 'opencode', 'zenflow', 'rev', 'vnc', 'hands-on']).optional().default('claude'),
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
  type: z.enum(['stdout', 'stderr', 'marker', 'info', 'error', 'assist', 'prompt_waiting', 'prompt_resolved', 'tool_use']),
  data: z.string(),
  sequence: z.number().int().min(0).optional()
});

const commandSchema = z.object({
  command: z.string()
});

const ackSchema = z.object({
  result: z.string().nullable().optional(),
  error: z.string().nullable().optional()
});

const mcpClaimRunSchema = z.object({
  provider: z.string().optional(),
});

function resolveAuthorizedMcpWorker(
  request: FastifyRequest,
  reply: FastifyReply,
  requiredScopes: McpScope[]
) {
  const authHeader = request.headers.authorization;
  const rawToken = extractBearerToken(authHeader);
  if (!rawToken) {
    reply.code(401).send({ error: 'Unauthorized: valid MCP Bearer token required' });
    return null;
  }
  const tokenCtx = validateMcpToken(rawToken);
  if (!tokenCtx) {
    reply.code(401).send({ error: 'Unauthorized: valid MCP Bearer token required' });
    return null;
  }

  const scopeError = assertScopes(tokenCtx, requiredScopes);
  if (scopeError) {
    reply.code(403).send({ error: scopeError });
    return null;
  }

  const headerSessionId = request.headers['mcp-session-id'] as string | undefined;
  const session = headerSessionId
    ? getMcpSession(headerSessionId)
    : findLatestMcpSessionByTokenId(tokenCtx.tokenId);

  const runnerIdHeader = request.headers['x-airc-runner-id'];
  const runnerId = typeof runnerIdHeader === 'string' ? runnerIdHeader.trim() : '';
  const runnerIdValid = /^[a-zA-Z0-9._:@/-]{3,128}$/.test(runnerId);

  // Explicit runner identity takes precedence over ambient MCP session presence.
  if (runnerIdValid) {
    const projectDirHeader = request.headers['x-airc-project-dir'];
    const projectDir = typeof projectDirHeader === 'string' && projectDirHeader.trim().length > 0
      ? projectDirHeader.trim()
      : null;
    upsertMcpRunnerHost({
      tokenId: tokenCtx.tokenId,
      runnerId,
      provider: providerFromTokenLabel(tokenCtx.tokenLabel),
      user: tokenCtx.user,
      scopes: tokenCtx.scopes,
      lastSeenAt: Math.floor(Date.now() / 1000),
      projectDir,
    });
    return {
      sessionId: null,
      session: null,
      claimTag: `mcp-runner:${tokenCtx.tokenId}:${runnerId}`,
      tokenContext: tokenCtx,
      runnerId,
    };
  }

  if (session) {
    const authCheck = validateMcpSessionAccess(session.authContext, authHeader);
    if (!authCheck.ok) {
      reply.code(authCheck.statusCode).send({ error: authCheck.message });
      return null;
    }

    return { sessionId: session.id, session, claimTag: `mcp:${session.id}`, tokenContext: tokenCtx, runnerId: null as string | null };
  }

  // Standalone MCP runner fallback: authorize by token identity when no live MCP session exists.
  reply.code(400).send({ error: 'x-airc-runner-id header is required for standalone runner mode' });
  return null;
}

export async function runsRoutes(fastify: FastifyInstance) {
  // Create a new run from the UI/MCP control plane
  fastify.post('/api/runs', {
    preHandler: [uiAuth, requireRole('admin', 'operator')]
  }, async (request: AuthenticatedRequest, reply) => {
    const body = createRunSchema.parse(request.body);
    const id = nanoid(12);
    const capabilityToken = generateCapabilityToken();
    const now = Math.floor(Date.now() / 1000);

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
    const mcpMode = typeof body.metadata?.mcpMode === 'string'
      ? body.metadata.mcpMode
      : null;
    const mcpSessionId = typeof body.metadata?.mcpSessionId === 'string'
      ? body.metadata.mcpSessionId
      : null;
    const mcpRunnerId = typeof body.metadata?.mcpRunnerId === 'string'
      ? body.metadata.mcpRunnerId
      : null;

    const shouldAttachSession = Boolean(mcpSessionId) && mcpMode !== 'agent';
    const attachedSession = shouldAttachSession ? getMcpSession(mcpSessionId!) : undefined;
    if (shouldAttachSession && !attachedSession) {
      return reply.code(409).send({ error: 'Selected MCP host is no longer connected. Refresh sessions and retry.' });
    }
    if (attachedSession) {
      const isAdmin = request.user?.role === 'admin';
      if (!isAdmin && attachedSession.authContext.user.id !== request.user?.id) {
        return reply.code(403).send({ error: 'Cannot attach run to another user\'s MCP session' });
      }
      if ((now - attachedSession.lastSeenAt) > MCP_SESSION_FRESHNESS_SECONDS) {
        return reply.code(409).send({ error: 'Selected MCP host is stale. Wait for reconnect and retry.' });
      }
      const sessionProvider = providerFromTokenLabel(attachedSession.authContext.tokenLabel);
    if (workerType !== 'vnc' && workerType !== 'hands-on' && sessionProvider && workerType !== sessionProvider) {
        return reply.code(400).send({
          error: `Worker type (${workerType}) does not match connected MCP provider (${sessionProvider})`,
        });
      }
      (metadata as any).mcpAttachedAt = now;
      (metadata as any).mcpSessionId = attachedSession.id;
      (metadata as any).mcpProvider = sessionProvider ?? (metadata as any).mcpProvider ?? null;
    }

    const initialStatus = attachedSession ? 'running' : 'pending';
    const claimedBy = attachedSession ? `mcp:${attachedSession.id}` : null;
    if (!attachedSession && mcpMode === 'agent' && mcpRunnerId) {
      (metadata as any).mcpRunnerId = mcpRunnerId;
    } else if (!attachedSession && mcpMode === 'agent' && mcpSessionId && !mcpRunnerId) {
      // Backward-compat: stale UI may still send mcpSessionId for agent mode.
      // Treat it as runner identity instead of auto-attaching to MCP session claim.
      (metadata as any).mcpRunnerId = mcpSessionId;
      delete (metadata as any).mcpSessionId;
    }

    db.transaction(() => {
      db.prepare(`
        INSERT INTO runs (id, label, command, repo_path, repo_name, tags, capability_token, metadata, worker_type, status, started_at, claimed_by, claimed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        body.label || null,
        body.command || null,
        body.repoPath || null,
        body.repoName || null,
        body.tags ? JSON.stringify(body.tags) : null,
        capabilityToken,
        JSON.stringify(metadata),
        workerType,
        initialStatus,
        attachedSession ? now : null,
        claimedBy,
        attachedSession ? now : null
      );

      // Save initial run state for resume capability
      if (body.workingDir) {
        db.prepare(`
          INSERT INTO run_state (run_id, working_dir, original_command)
          VALUES (?, ?, ?)
        `).run(id, body.workingDir, body.command || null);
      }
    })();

    logAudit(request.user?.id, 'run.create', 'run', id, { command: body.command, autonomous: body.autonomous }, request.ip);

    return {
      id,
      capabilityToken, // Only returned on creation
      status: initialStatus,
      attachedMcpSessionId: attachedSession?.id ?? null,
      autonomous: body.autonomous || false
    };
  });

  // List runs with filtering, search, and pagination
  fastify.get('/api/runs', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    const {
      status,
      search,
      repo,
      waitingApproval,
      tags,
      workerType,
      claim,
      limit = '50',
      offset = '0',
      cursor,
      sortBy = 'created_at',
      sortOrder = 'desc'
    } = request.query as {
      status?: string;
      search?: string;
      repo?: string;
      waitingApproval?: string;
      tags?: string;
      workerType?: string;
      claim?: string;
      limit?: string;
      offset?: string;
      cursor?: string;
      sortBy?: string;
      sortOrder?: string;
    };

    let query = `
      SELECT r.id, r.status, r.label, r.command, r.repo_path, r.repo_name,
             r.waiting_approval, r.created_at, r.started_at, r.finished_at,
             r.exit_code, r.error_message, r.metadata, r.tags,
             (SELECT COUNT(*) FROM artifacts WHERE run_id = r.id) as artifact_count,
             (SELECT data FROM events WHERE run_id = r.id AND type = 'assist' LIMIT 1) as assist_data,
             r.worker_type, r.claimed_by, r.claimed_at
      FROM runs r
      WHERE 1=1
    `;
    const params: any[] = [];

    if (status && status !== 'all') {
      query += ' AND r.status = ?';
      params.push(status);
    }

    if (workerType && workerType !== 'all') {
      query += ' AND r.worker_type = ?';
      params.push(workerType);
    }

    if (claim === 'claimed') {
      query += ' AND r.claimed_by IS NOT NULL';
    } else if (claim === 'unclaimed') {
      query += ' AND r.claimed_by IS NULL';
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
    if (claim === 'claimed') {
      countQuery += ' AND r.claimed_by IS NOT NULL';
    } else if (claim === 'unclaimed') {
      countQuery += ' AND r.claimed_by IS NULL';
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

  // MCP worker: claim next pending run for this connected MCP session
  fastify.post('/api/mcp/runs/claim', async (request, reply) => {
    const auth = resolveAuthorizedMcpWorker(request, reply, ['runs:write']);
    if (!auth) return;
    const { session, claimTag } = auth;
    const body = mcpClaimRunSchema.parse(request.body ?? {});

    const provider = (body.provider ?? providerFromTokenLabel(session?.authContext.tokenLabel) ?? '').trim().toLowerCase();
    if (!provider) {
      return reply.code(400).send({ error: 'Unable to resolve provider for MCP claim' });
    }

    const now = Math.floor(Date.now() / 1000);
    const claimTransaction = db.transaction(() => {
      const targetRunnerId = auth.runnerId ?? null;
      const run = db.prepare(`
        SELECT id, command, metadata, worker_type, capability_token
        FROM runs
        WHERE status = 'pending'
          AND waiting_approval = 0
          AND worker_type = ?
          AND (
            json_extract(metadata, '$.mcpRunnerId') IS NULL
            OR json_extract(metadata, '$.mcpRunnerId') = ?
          )
          AND (claimed_by IS NULL OR claimed_by = ?)
        ORDER BY created_at ASC
        LIMIT 1
      `).get(provider, targetRunnerId, claimTag) as any;

      if (!run) {
        return null;
      }

      const updated = db.prepare(`
        UPDATE runs
        SET claimed_by = ?, claimed_at = ?, status = 'running', started_at = COALESCE(started_at, ?)
        WHERE id = ? AND status = 'pending'
      `).run(claimTag, now, now, run.id);

      if (updated.changes === 0) {
        return null;
      }

      return run;
    });

    const claimed = claimTransaction();
    if (!claimed) {
      return { run: null };
    }

    return {
      run: {
        id: claimed.id,
        capabilityToken: claimed.capability_token,
        command: claimed.command,
        workerType: claimed.worker_type,
        metadata: claimed.metadata ? JSON.parse(claimed.metadata) : null,
      },
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
             r.exit_code, r.error_message, r.metadata, r.tags,
             r.worker_type, r.claimed_by, r.claimed_at
      FROM runs r
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
      SELECT id, command, arguments, status, created_at, acked_at, result, error
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
      SELECT id, command, arguments, status, created_at, acked_at, result, error
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

  // UI: send command to runner
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
      INSERT INTO commands (id, run_id, command, arguments)
      VALUES (?, ?, ?, ?)
    `).run(id, runId, '__EXEC__', body.command);

    logAudit(request.user?.id, 'command.sent', 'run', runId, { commandId: id, command: body.command }, request.ip);

    // Notify via WebSocket
    broadcastToRun(runId, {
      type: 'command_queued',
      commandId: id,
      command: body.command
    });

    return { commandId: id };
  });

  // MCP worker: poll pending commands for a claimed run
  fastify.get('/api/mcp/runs/:runId/commands', async (request, reply) => {
    const auth = resolveAuthorizedMcpWorker(request, reply, ['runs:read', 'sessions:write']);
    if (!auth) return;
    const { runId } = request.params as { runId: string };
    const { claimTag } = auth;

    const run = db.prepare('SELECT id, worker_type, claimed_by, claimed_at FROM runs WHERE id = ?').get(runId) as {
      id: string;
      worker_type: string;
      claimed_by: string | null;
      claimed_at: number | null;
    } | undefined;
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    if (run.claimed_by !== claimTag && claimTag.startsWith('mcp-runner:') && run.claimed_by?.startsWith('mcp:')) {
      const claimedSessionId = run.claimed_by.slice('mcp:'.length);
      const claimedSession = getMcpSession(claimedSessionId);
      const provider = providerFromTokenLabel(auth.tokenContext.tokenLabel);
      const claimExpiredAt = Math.floor(Date.now() / 1000) - config.claimLeaseSeconds;
      const staleClaim = !claimedSession || !run.claimed_at || run.claimed_at < claimExpiredAt;
      if (provider && run.worker_type === provider && staleClaim) {
        const adoption = db.prepare(`
          UPDATE runs
          SET claimed_by = ?, claimed_at = unixepoch()
          WHERE id = ? AND claimed_by = ?
        `).run(claimTag, runId, run.claimed_by);
        if (adoption.changes > 0) {
          run.claimed_by = claimTag;
        }
      }
    }

    if (run.claimed_by !== claimTag) {
      return reply.code(403).send({ error: 'Run is not claimed by this MCP session' });
    }

    const rows = db.prepare(`
      SELECT id, command, arguments, created_at
      FROM commands
      WHERE run_id = ? AND status = 'pending'
      ORDER BY created_at ASC
    `).all(runId);

    const commands = rows.map((row: any) => {
      if (typeof row.command === 'string' && row.command.startsWith('__INPUT__:')) {
        return {
          ...row,
          command: '__INPUT__',
          arguments: row.arguments ?? row.command.substring('__INPUT__:'.length),
        };
      }
      return row;
    });

    return commands;
  });

  // MCP worker: acknowledge command delivery/execution
  fastify.post('/api/mcp/runs/:runId/commands/:commandId/ack', async (request, reply) => {
    const auth = resolveAuthorizedMcpWorker(request, reply, ['sessions:write']);
    if (!auth) return;
    const { runId, commandId } = request.params as { runId: string; commandId: string };
    const body = ackSchema.parse(request.body ?? {});
    const { claimTag } = auth;

    const run = db.prepare('SELECT id, claimed_by FROM runs WHERE id = ?').get(runId) as {
      id: string;
      claimed_by: string | null;
    } | undefined;
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    if (run.claimed_by !== claimTag) {
      return reply.code(403).send({ error: 'Run is not claimed by this MCP session' });
    }

    db.prepare(`
      UPDATE commands
      SET status = 'completed', acked_at = unixepoch(), result = ?, error = ?
      WHERE id = ? AND run_id = ?
    `).run(body.result || null, body.error || null, commandId, runId);

    broadcastToRun(runId, {
      type: 'command_completed',
      commandId,
      result: body.result,
      error: body.error,
    });

    return { ok: true };
  });

  // MCP worker: ingest run event stream
  fastify.post('/api/mcp/runs/:runId/events', async (request, reply) => {
    const auth = resolveAuthorizedMcpWorker(request, reply, ['sessions:write']);
    if (!auth) return;
    const { runId } = request.params as { runId: string };
    const body = eventSchema.parse(request.body);
    const { claimTag } = auth;

    const run = db.prepare('SELECT id, claimed_by FROM runs WHERE id = ?').get(runId) as {
      id: string;
      claimed_by: string | null;
    } | undefined;
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    if (run.claimed_by !== claimTag) {
      return reply.code(403).send({ error: 'Run is not claimed by this MCP session' });
    }

    const sanitizedData = redactSecrets(body.data);
    const result = db.prepare(`
      INSERT INTO events (run_id, type, data, sequence)
      VALUES (?, ?, ?, ?)
    `).run(runId, body.type, sanitizedData, body.sequence || 0);

    if (body.type === 'marker') {
      try {
        const marker = JSON.parse(body.data);
        if (marker.event === 'started') {
          db.prepare('UPDATE runs SET status = ?, started_at = unixepoch() WHERE id = ?')
            .run('running', runId);
        } else if (marker.event === 'finished') {
          db.prepare('UPDATE runs SET status = ?, finished_at = unixepoch(), exit_code = ? WHERE id = ?')
            .run(marker.exitCode === 0 ? 'done' : 'failed', marker.exitCode, runId);
        }
      } catch {
        // ignore malformed marker payloads
      }
    }

    broadcastToRun(runId, {
      type: 'event',
      eventId: Number(result.lastInsertRowid),
      eventType: body.type,
      data: sanitizedData,
      timestamp: Math.floor(Date.now() / 1000),
    });

    return { ok: true, eventId: Number(result.lastInsertRowid) };
  });

  // Stop run request
  fastify.post('/api/runs/:runId/stop', {
    preHandler: [uiAuth, requireRole('admin', 'operator')]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };

    const run = db.prepare('SELECT status, claimed_by FROM runs WHERE id = ?').get(runId) as {
      status: string;
      claimed_by: string | null;
    } | undefined;
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

  // Release a pending run claim (operator/admin)
  fastify.post('/api/runs/:runId/release', {
    preHandler: [uiAuth, requireRole('admin', 'operator')]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };

    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as any;
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    if (run.status !== 'pending') {
      return reply.code(400).send({ error: 'Only pending runs can be released' });
    }

    db.prepare(`
      UPDATE runs
      SET claimed_by = NULL, claimed_at = NULL
      WHERE id = ?
    `).run(runId);

    logAudit(request.user?.id, 'run.release', 'run', runId, {}, request.ip);

    return { ok: true };
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
    if (run.claimed_by?.startsWith('mcp:')) {
      db.prepare(`
        INSERT INTO commands (id, run_id, command, arguments)
        VALUES (?, ?, ?, ?)
      `).run(id, runId, '__INPUT__', inputData);
    } else {
      db.prepare(`
        INSERT INTO commands (id, run_id, command, arguments)
        VALUES (?, ?, ?, ?)
      `).run(id, runId, `__INPUT__:${inputData}`, inputData);
    }

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

}
