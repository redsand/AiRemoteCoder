/**
 * AiRemoteCoder MCP Server
 *
 * Exposes the AiRemoteCoder control plane as a remote MCP server using the
 * streamable HTTP transport. AI agent runtimes (Claude Code, Codex, Gemini CLI,
 * OpenCode, Rev, etc.) connect here to manage runs, sessions, artifacts, and
 * approvals without relying on subprocess stdio/pipe parsing.
 *
 * Transport: POST /mcp  (streamable HTTP — may return SSE for subscriptions)
 *            GET  /mcp  (SSE stream for existing sessions)
 *            DELETE /mcp (session termination)
 *
 * Auth: Bearer token (see mcp/auth.ts). Scopes control per-tool access.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../services/database.js';
import { broadcastToRun } from '../services/websocket.js';
import { config } from '../config.js';
import { assertScopes, type McpAuthContext } from './auth.js';
import { createApprovalRequest, resolveApprovalRequest } from '../services/approval-workflow.js';
import { vncTunnelManager } from '../services/vnc-tunnel.js';
import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function scopeError(msg: string) {
  return { content: [{ type: 'text' as const, text: `[auth error] ${msg}` }], isError: true };
}

function notFound(entity: string, id: string) {
  return { content: [{ type: 'text' as const, text: `${entity} not found: ${id}` }], isError: true };
}

function invalidRequest(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// ---------------------------------------------------------------------------
// Factory — creates and configures the MCP server instance.
// Called once at startup; the returned server handles all sessions.
// ---------------------------------------------------------------------------

export function createMcpServer(getAuthContext: () => McpAuthContext | null): McpServer {
  const server = new McpServer(
    { name: 'airemotecoder', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } }
  );

  // -------------------------------------------------------------------------
  // TOOL: healthcheck
  // -------------------------------------------------------------------------
  server.tool(
    'healthcheck',
    'Returns gateway health status and uptime. No auth required.',
    {},
    async () => {
      const runCounts = db.prepare(`
        SELECT status, COUNT(*) as count FROM runs GROUP BY status
      `).all() as { status: string; count: number }[];

      return ok({
        status: 'ok',
        timestamp: new Date().toISOString(),
        gateway: 'airemotecoder',
        version: '1.0.0',
        runs: Object.fromEntries(runCounts.map((r) => [r.status, r.count])),
      });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: heartbeat
  // -------------------------------------------------------------------------
  server.tool(
    'heartbeat',
    'Keep-alive ping. Returns current server timestamp.',
    {},
    async () => ok({ ts: unixNow(), iso: new Date().toISOString() })
  );

  // -------------------------------------------------------------------------
  // TOOL: list_runs
  // -------------------------------------------------------------------------
  server.tool(
    'list_runs',
    'List runs with optional filters. Scope: runs:read.',
    {
      status: z.enum(['pending', 'running', 'waiting_approval', 'done', 'failed', 'cancelled']).optional()
        .describe('Filter by run status'),
      worker_type: z.string().optional().describe('Filter by worker type (claude, codex, gemini, etc.)'),
      limit: z.number().int().min(1).max(200).default(50).describe('Max results'),
      offset: z.number().int().min(0).default(0).describe('Pagination offset'),
    },
    async ({ status, worker_type, limit, offset }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['runs:read']);
      if (err) return scopeError(err);

      let query = 'SELECT * FROM runs WHERE 1=1';
      const params: unknown[] = [];
      if (status) { query += ' AND status = ?'; params.push(status); }
      if (worker_type) { query += ' AND worker_type = ?'; params.push(worker_type); }
      query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const runs = db.prepare(query).all(...params);
      return ok({ runs, total: runs.length, limit, offset });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: get_run
  // -------------------------------------------------------------------------
  server.tool(
    'get_run',
    'Get full details of a single run including state and recent events. Scope: runs:read.',
    {
      run_id: z.string().describe('The run ID'),
      include_events: z.boolean().default(false).describe('Include last 50 events in response'),
    },
    async ({ run_id, include_events }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['runs:read']);
      if (err) return scopeError(err);

      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(run_id);
      if (!run) return notFound('run', run_id);

      const state = db.prepare('SELECT * FROM run_state WHERE run_id = ?').get(run_id);

      let events: unknown[] = [];
      if (include_events) {
        events = db.prepare(
          'SELECT * FROM events WHERE run_id = ? ORDER BY sequence DESC LIMIT 50'
        ).all(run_id).reverse();
      }

      return ok({ run, state: state ?? null, events });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: create_run
  // -------------------------------------------------------------------------
  server.tool(
    'create_run',
    'Create a new run. The run will be in pending status until a worker claims it. Scope: runs:write.',
    {
      label: z.string().optional().describe('Human-readable label'),
      command: z.string().optional().describe('Initial command or prompt for the agent'),
      worker_type: z.enum(['claude', 'codex', 'gemini', 'opencode', 'zenflow', 'rev', 'hands-on', 'vnc']).default('claude')
        .describe('Agent runtime to use'),
      repo_path: z.string().optional().describe('Working directory / repository path on the agent machine'),
      repo_name: z.string().optional().describe('Repository name (display only)'),
      tags: z.array(z.string()).optional().describe('Arbitrary tags for filtering'),
      metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
    },
    async ({ label, command, worker_type, repo_path, repo_name, tags, metadata }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['runs:write']);
      if (err) return scopeError(err);

      const { generateCapabilityToken } = await import('../utils/crypto.js');
      const runId = nanoid();
      const capabilityToken = generateCapabilityToken();

      db.prepare(`
        INSERT INTO runs (id, status, label, command, worker_type, repo_path, repo_name,
          capability_token, tags, metadata, created_at)
        VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `).run(
        runId, label ?? null, command ?? null, worker_type,
        repo_path ?? null, repo_name ?? null,
        capabilityToken,
        tags ? JSON.stringify(tags) : null,
        metadata ? JSON.stringify(metadata) : null
      );

      broadcastToRun(runId, { type: 'run_created', runId });

      return ok({
        run_id: runId,
        status: 'pending',
        capability_token: capabilityToken,
        message: 'Run created. A worker will claim it shortly.',
      });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: resume_run
  // -------------------------------------------------------------------------
  server.tool(
    'resume_run',
    'Resume a completed or failed run by creating a new run that continues from the previous state. Scope: runs:write.',
    {
      run_id: z.string().describe('The run ID to resume from'),
      command: z.string().optional().describe('Override command for the resumed run'),
      working_dir: z.string().optional().describe('Override working directory'),
    },
    async ({ run_id, command, working_dir }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['runs:write']);
      if (err) return scopeError(err);

      const prevRun = db.prepare('SELECT * FROM runs WHERE id = ?').get(run_id) as any;
      if (!prevRun) return notFound('run', run_id);

      const prevState = db.prepare('SELECT * FROM run_state WHERE run_id = ?').get(run_id) as any;

      const { generateCapabilityToken } = await import('../utils/crypto.js');
      const newRunId = nanoid();
      const capabilityToken = generateCapabilityToken();

      db.prepare(`
        INSERT INTO runs (id, status, label, command, worker_type, repo_path, repo_name,
          capability_token, tags, metadata, created_at)
        VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `).run(
        newRunId,
        prevRun.label ? `${prevRun.label} (resumed)` : null,
        command ?? prevRun.command,
        prevRun.worker_type,
        prevRun.repo_path,
        prevRun.repo_name,
        capabilityToken,
        prevRun.tags,
        prevRun.metadata
      );

      // Carry forward state
      if (prevState) {
        db.prepare(`
          INSERT INTO run_state (run_id, working_dir, original_command, last_sequence, stdin_buffer, environment)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          newRunId,
          working_dir ?? prevState.working_dir,
          prevState.original_command,
          prevState.last_sequence,
          prevState.stdin_buffer,
          prevState.environment
        );
      }

      broadcastToRun(newRunId, { type: 'run_created', runId: newRunId, resumedFrom: run_id });

      return ok({
        run_id: newRunId,
        resumed_from: run_id,
        status: 'pending',
        capability_token: capabilityToken,
      });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: cancel_run
  // -------------------------------------------------------------------------
  server.tool(
    'cancel_run',
    'Request graceful cancellation of a running or pending run. Scope: runs:cancel.',
    {
      run_id: z.string().describe('The run ID to cancel'),
      reason: z.string().optional().describe('Reason for cancellation'),
    },
    async ({ run_id, reason }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['runs:cancel']);
      if (err) return scopeError(err);

      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(run_id) as any;
      if (!run) return notFound('run', run_id);

      if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') {
        return ok({ message: `Run is already in terminal state: ${run.status}`, run_id });
      }

      // Post a stop command the runner will pick up
      const cmdId = nanoid();
      db.prepare(`
        INSERT INTO commands (id, run_id, command, status, created_at)
        VALUES (?, ?, '__STOP__', 'pending', unixepoch())
      `).run(cmdId, run_id);

      broadcastToRun(run_id, { type: 'run_cancel_requested', runId: run_id, reason: reason ?? null });

      return ok({ run_id, message: 'Cancellation requested. Worker will stop gracefully.' });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: send_input
  // -------------------------------------------------------------------------
  server.tool(
    'send_input',
    'Send stdin input or a command to an active run session. Scope: sessions:write.',
    {
      run_id: z.string().describe('Target run ID'),
      input: z.string().max(4096).describe('Input text to send to the agent process'),
    },
    async ({ run_id, input }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['sessions:write']);
      if (err) return scopeError(err);

      const run = db.prepare("SELECT * FROM runs WHERE id = ? AND status = 'running'").get(run_id) as any;
      if (!run) return notFound('active run', run_id);

      const cmdId = nanoid();
      db.prepare(`
        INSERT INTO commands (id, run_id, command, arguments, status, created_at)
        VALUES (?, ?, '__INPUT__', ?, 'pending', unixepoch())
      `).run(cmdId, run_id, JSON.stringify({ text: input }));

      broadcastToRun(run_id, { type: 'input_queued', runId: run_id, commandId: cmdId });

      return ok({ command_id: cmdId, status: 'queued', message: 'Input queued for delivery.' });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: interrupt_session
  // -------------------------------------------------------------------------
  server.tool(
    'interrupt_session',
    'Send an interrupt signal (SIGINT equivalent) to the active agent process. Scope: sessions:write.',
    {
      run_id: z.string().describe('Target run ID'),
    },
    async ({ run_id }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['sessions:write']);
      if (err) return scopeError(err);

      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(run_id) as any;
      if (!run) return notFound('run', run_id);

      const cmdId = nanoid();
      db.prepare(`
        INSERT INTO commands (id, run_id, command, status, created_at)
        VALUES (?, ?, '__ESCAPE__', 'pending', unixepoch())
      `).run(cmdId, run_id);

      broadcastToRun(run_id, { type: 'interrupt_requested', runId: run_id });

      return ok({ command_id: cmdId, status: 'queued' });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: get_vnc_status
  // -------------------------------------------------------------------------
  server.tool(
    'get_vnc_status',
    'Get VNC tunnel and connection status for a VNC run. Scope: vnc:read.',
    {
      run_id: z.string().describe('Target run ID'),
    },
    async ({ run_id }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['vnc:read']);
      if (err) return scopeError(err);

      const run = db.prepare('SELECT id, worker_type FROM runs WHERE id = ?').get(run_id) as any;
      if (!run) return notFound('run', run_id);
      if (run.worker_type !== 'vnc') return invalidRequest('Run is not a VNC worker');

      const tunnel = vncTunnelManager.getTunnel(run_id);
      const stats = vncTunnelManager.getTunnelStats(run_id);

      return ok({
        run_id,
        available: Boolean(tunnel),
        status: stats?.status ?? 'disconnected',
        client_connected: Boolean(stats?.clientConnected),
        viewer_connected: Boolean(stats?.viewerConnected),
        ws_url: `/ws/vnc/${run_id}`,
        stats: stats ?? null,
      });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: start_vnc_stream
  // -------------------------------------------------------------------------
  server.tool(
    'start_vnc_stream',
    'Start VNC streaming for a VNC run by enqueueing __START_VNC_STREAM__. Scope: vnc:control.',
    {
      run_id: z.string().describe('Target run ID'),
    },
    async ({ run_id }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['vnc:control']);
      if (err) return scopeError(err);

      const run = db.prepare('SELECT id, worker_type FROM runs WHERE id = ?').get(run_id) as any;
      if (!run) return notFound('run', run_id);
      if (run.worker_type !== 'vnc') return invalidRequest('Run is not a VNC worker');

      if (!vncTunnelManager.getTunnel(run_id)) {
        vncTunnelManager.createTunnel(run_id);
      }

      const cmdId = nanoid();
      db.prepare(`
        INSERT INTO commands (id, run_id, command, arguments, status, created_at)
        VALUES (?, ?, '__START_VNC_STREAM__', ?, 'pending', unixepoch())
      `).run(cmdId, run_id, JSON.stringify({}));

      broadcastToRun(run_id, { type: 'vnc_start_requested', runId: run_id, commandId: cmdId });

      return ok({
        run_id,
        command: '__START_VNC_STREAM__',
        command_id: cmdId,
        ws_url: `/ws/vnc/${run_id}`,
        message: 'VNC stream start queued. Connect viewer to ws_url.',
      });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: stop_vnc_stream
  // -------------------------------------------------------------------------
  server.tool(
    'stop_vnc_stream',
    'Stop VNC streaming by closing the active tunnel for a run. Scope: vnc:control.',
    {
      run_id: z.string().describe('Target run ID'),
    },
    async ({ run_id }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['vnc:control']);
      if (err) return scopeError(err);

      const run = db.prepare('SELECT id, worker_type FROM runs WHERE id = ?').get(run_id) as any;
      if (!run) return notFound('run', run_id);
      if (run.worker_type !== 'vnc') return invalidRequest('Run is not a VNC worker');

      vncTunnelManager.closeTunnel(run_id);
      broadcastToRun(run_id, { type: 'vnc_stop_requested', runId: run_id });

      return ok({
        run_id,
        message: 'VNC tunnel closed',
      });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: get_vnc_tunnel_stats
  // -------------------------------------------------------------------------
  server.tool(
    'get_vnc_tunnel_stats',
    'Get aggregate VNC tunnel stats. Scope: admin.',
    {},
    async () => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['admin']);
      if (err) return scopeError(err);

      return ok({
        active_tunnels: vncTunnelManager.getActiveTunnelCount(),
        pending_tunnels: vncTunnelManager.getPendingTunnelCount(),
        tunnels: vncTunnelManager.getAllTunnelStats(),
      });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: tail_logs
  // -------------------------------------------------------------------------
  server.tool(
    'tail_logs',
    'Retrieve recent log events from a run. Supports cursor-based pagination for replay. Scope: events:read.',
    {
      run_id: z.string().describe('Target run ID'),
      limit: z.number().int().min(1).max(1000).default(100).describe('Number of events to return'),
      after_sequence: z.number().int().optional().describe('Return only events with sequence > this value (for replay)'),
      types: z.array(z.string()).optional().describe('Filter by event types (stdout, stderr, marker, etc.)'),
    },
    async ({ run_id, limit, after_sequence, types }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['events:read']);
      if (err) return scopeError(err);

      const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(run_id);
      if (!run) return notFound('run', run_id);

      let query = 'SELECT * FROM events WHERE run_id = ?';
      const params: unknown[] = [run_id];

      if (after_sequence !== undefined) {
        query += ' AND sequence > ?';
        params.push(after_sequence);
      }
      if (types && types.length > 0) {
        query += ` AND type IN (${types.map(() => '?').join(',')})`;
        params.push(...types);
      }
      query += ' ORDER BY sequence ASC LIMIT ?';
      params.push(limit);

      const events = db.prepare(query).all(...params) as any[];

      return ok({
        run_id,
        events,
        count: events.length,
        cursor: events.length > 0 ? events[events.length - 1].sequence : (after_sequence ?? 0),
        has_more: events.length === limit,
      });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: list_artifacts
  // -------------------------------------------------------------------------
  server.tool(
    'list_artifacts',
    'List artifacts produced by a run. Scope: artifacts:read.',
    {
      run_id: z.string().describe('Target run ID'),
    },
    async ({ run_id }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['artifacts:read']);
      if (err) return scopeError(err);

      const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(run_id);
      if (!run) return notFound('run', run_id);

      const artifacts = db.prepare(
        'SELECT id, name, type, size, created_at FROM artifacts WHERE run_id = ? ORDER BY created_at ASC'
      ).all(run_id);

      return ok({ run_id, artifacts });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: fetch_artifact
  // -------------------------------------------------------------------------
  server.tool(
    'fetch_artifact',
    'Retrieve the content of a text-based artifact (log, diff, json, markdown). Binary artifacts return a download URL instead. Scope: artifacts:read.',
    {
      artifact_id: z.string().describe('Artifact ID'),
    },
    async ({ artifact_id }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['artifacts:read']);
      if (err) return scopeError(err);

      const artifact = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifact_id) as any;
      if (!artifact) return notFound('artifact', artifact_id);

      const textTypes = ['log', 'text', 'json', 'diff', 'patch', 'markdown'];
      if (textTypes.includes(artifact.type)) {
        const { readFileSync, existsSync } = await import('fs');
        if (!existsSync(artifact.path)) {
          return { content: [{ type: 'text' as const, text: 'Artifact file not found on disk.' }], isError: true };
        }
        const content = readFileSync(artifact.path, 'utf-8');
        return ok({ artifact_id, name: artifact.name, type: artifact.type, content });
      }

      // Binary — return metadata and download URL
      return ok({
        artifact_id,
        name: artifact.name,
        type: artifact.type,
        size: artifact.size,
        download_url: `/api/artifacts/${artifact_id}`,
        note: 'Binary artifact — use download_url to retrieve content.',
      });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: get_run_diff
  // -------------------------------------------------------------------------
  server.tool(
    'get_run_diff',
    'Retrieve the most recent git diff artifact from a run, if available. Scope: artifacts:read.',
    {
      run_id: z.string().describe('Target run ID'),
    },
    async ({ run_id }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['artifacts:read']);
      if (err) return scopeError(err);

      const artifact = db.prepare(`
        SELECT * FROM artifacts
        WHERE run_id = ? AND (type = 'diff' OR type = 'patch')
        ORDER BY created_at DESC LIMIT 1
      `).get(run_id) as any;

      if (!artifact) return ok({ run_id, diff: null, message: 'No diff artifact found for this run.' });

      const { readFileSync, existsSync } = await import('fs');
      if (!existsSync(artifact.path)) {
        return ok({ run_id, diff: null, message: 'Diff file not found on disk.' });
      }

      return ok({ run_id, artifact_id: artifact.id, diff: readFileSync(artifact.path, 'utf-8') });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: request_approval_status
  // -------------------------------------------------------------------------
  server.tool(
    'request_approval_status',
    'Check the status of a pending approval request. Scope: approvals:read.',
    {
      approval_request_id: z.string().describe('The approval request ID'),
    },
    async ({ approval_request_id }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['approvals:read']);
      if (err) return scopeError(err);

      const req = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(approval_request_id);
      if (!req) return notFound('approval_request', approval_request_id);

      return ok(req);
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: create_approval_request
  // -------------------------------------------------------------------------
  server.tool(
    'create_approval_request',
    'Create an approval gate for a dangerous or irreversible action. Blocks the agent until a human decides. Scope: approvals:write.',
    {
      run_id: z.string().describe('Run this approval is for'),
      description: z.string().describe('Human-readable description of the action requiring approval'),
      action: z.record(z.unknown()).describe('Structured action payload (what the agent wants to do)'),
      timeout_seconds: z.number().int().min(0).default(300).describe('Seconds before auto-timeout (0 = never)'),
      provider_correlation_id: z.string().optional().describe('Provider-specific ID for unblocking after resolution'),
    },
    async ({ run_id, description, action, timeout_seconds, provider_correlation_id }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['approvals:write']);
      if (err) return scopeError(err);

      try {
        const created = createApprovalRequest(db, {
          runId: run_id,
          description,
          action,
          timeoutSeconds: timeout_seconds,
          providerCorrelationId: provider_correlation_id ?? null,
        });

        broadcastToRun(run_id, {
          type: 'approval_requested',
          runId: run_id,
          approvalRequestId: created.approvalRequestId,
          description,
        });

        return ok({
          approval_request_id: created.approvalRequestId,
          status: 'pending',
          message: 'Approval request created. Waiting for human decision.',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('Run not found:')) {
          return notFound('run', run_id);
        }
        return scopeError(`Failed to create approval request: ${message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: approve_action
  // -------------------------------------------------------------------------
  server.tool(
    'approve_action',
    'Approve a pending approval request. Scope: approvals:decide.',
    {
      approval_request_id: z.string().describe('The approval request ID'),
      resolution: z.string().optional().describe('Optional rationale'),
    },
    async ({ approval_request_id, resolution }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['approvals:decide']);
      if (err) return scopeError(err);
      try {
        const result = resolveApprovalRequest(db, {
          approvalRequestId: approval_request_id,
          decision: 'approved',
          resolvedBy: ctx.user.id,
          resolution: resolution ?? null,
        });

        if (result.wasPending) {
          broadcastToRun(result.runId, {
            type: 'approval_resolved',
            runId: result.runId,
            approvalRequestId: result.requestId,
            decision: result.decision,
            resolvedBy: result.resolvedBy,
          });
        }

        return ok({
          request_id: result.requestId,
          decision: result.currentStatus,
          resolved_by: result.resolvedBy,
          resolution: result.resolution,
          message: result.wasPending
            ? `Action ${result.decision}. Agent will be notified.`
            : `Approval is already in state: ${result.currentStatus}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('Approval request not found:')) {
          return notFound('approval_request', approval_request_id);
        }
        return scopeError(`Failed to approve action: ${message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: deny_action
  // -------------------------------------------------------------------------
  server.tool(
    'deny_action',
    'Deny a pending approval request. Scope: approvals:decide.',
    {
      approval_request_id: z.string().describe('The approval request ID'),
      resolution: z.string().optional().describe('Reason for denial'),
    },
    async ({ approval_request_id, resolution }) => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['approvals:decide']);
      if (err) return scopeError(err);
      try {
        const result = resolveApprovalRequest(db, {
          approvalRequestId: approval_request_id,
          decision: 'denied',
          resolvedBy: ctx.user.id,
          resolution: resolution ?? null,
        });

        if (result.wasPending) {
          broadcastToRun(result.runId, {
            type: 'approval_resolved',
            runId: result.runId,
            approvalRequestId: result.requestId,
            decision: result.decision,
            resolvedBy: result.resolvedBy,
          });
        }

        return ok({
          request_id: result.requestId,
          decision: result.currentStatus,
          resolved_by: result.resolvedBy,
          resolution: result.resolution,
          message: result.wasPending
            ? `Action ${result.decision}. Agent will be notified.`
            : `Approval is already in state: ${result.currentStatus}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('Approval request not found:')) {
          return notFound('approval_request', approval_request_id);
        }
        return scopeError(`Failed to deny action: ${message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: get_agent_capabilities
  // -------------------------------------------------------------------------
  server.tool(
    'get_agent_capabilities',
    'Retrieve capability matrix for all configured provider adapters. Scope: runs:read.',
    {},
    async () => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['runs:read']);
      if (err) return scopeError(err);

      const capabilities = buildCapabilityMatrix();
      return ok({ capabilities, enabledProviders: Object.keys(capabilities) });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: get_policy_snapshot
  // -------------------------------------------------------------------------
  server.tool(
    'get_policy_snapshot',
    'Return the current operational policy for this gateway. Scope: runs:read.',
    {},
    async () => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['runs:read']);
      if (err) return scopeError(err);

      return ok({
        allowlistedCommands: config.allowlistedCommands,
        approvalTimeoutSeconds: config.approvalTimeoutSeconds,
        maxArtifactSizeBytes: config.maxArtifactSize,
        secretRedactionEnabled: true,
        sandboxRootEnforced: true,
        mcpEnabled: config.mcpEnabled,
        providers: config.providers,
      });
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: list_mcp_tokens  (admin)
  // -------------------------------------------------------------------------
  server.tool(
    'list_mcp_tokens',
    'List MCP API tokens for the authenticated user. Scope: admin.',
    {},
    async () => {
      const ctx = getAuthContext();
      if (!ctx) return scopeError('Authentication required');
      const err = assertScopes(ctx, ['admin']);
      if (err) return scopeError(err);

      const tokens = db.prepare(`
        SELECT id, label, user_id, scopes, created_at, expires_at, last_used_at, revoked_at
        FROM mcp_tokens WHERE user_id = ?
        ORDER BY created_at DESC
      `).all(ctx.user.id);

      return ok({ tokens });
    }
  );

  // -------------------------------------------------------------------------
  // RESOURCE: run/{run_id}
  // -------------------------------------------------------------------------
  server.resource(
    'run',
    new ResourceTemplate('run://{run_id}', { list: undefined }),
    async (uri, { run_id }) => {
      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(run_id as string);
      if (!run) {
        return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'not found' }), mimeType: 'application/json' }] };
      }
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify(run, null, 2),
          mimeType: 'application/json',
        }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // RESOURCE: artifacts/{run_id}
  // -------------------------------------------------------------------------
  server.resource(
    'artifacts',
    new ResourceTemplate('artifacts://{run_id}', { list: undefined }),
    async (uri, { run_id }) => {
      const artifacts = db.prepare(
        'SELECT id, name, type, size, created_at FROM artifacts WHERE run_id = ?'
      ).all(run_id as string);
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({ run_id, artifacts }, null, 2),
          mimeType: 'application/json',
        }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // RESOURCE: policy
  // -------------------------------------------------------------------------
  server.resource(
    'policy',
    'policy://current',
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: JSON.stringify({
          allowlistedCommands: config.allowlistedCommands,
          approvalTimeoutSeconds: config.approvalTimeoutSeconds,
          maxArtifactSizeBytes: config.maxArtifactSize,
          providers: config.providers,
        }, null, 2),
        mimeType: 'application/json',
      }],
    })
  );

  return server;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildCapabilityMatrix() {
  const matrix: Record<string, object> = {};

  if (config.providers.claude) {
    matrix.claude = {
      provider: 'claude',
      supportsInteractiveInput: true,
      supportsResume: true,
      supportsCheckpoint: true,
      supportsApprovalGating: true,
      supportsToolUseEvents: true,
      supportsStreaming: true,
      supportsModelSelection: true,
      nativeMcp: false,
      version: '1.0.0',
    };
  }
  if (config.providers.codex) {
    matrix.codex = {
      provider: 'codex',
      supportsInteractiveInput: false,
      supportsResume: true,
      supportsCheckpoint: false,
      supportsApprovalGating: false,
      supportsToolUseEvents: false,
      supportsStreaming: true,
      supportsModelSelection: false,
      nativeMcp: false,
      version: '1.0.0',
    };
  }
  if (config.providers.gemini) {
    matrix.gemini = {
      provider: 'gemini',
      supportsInteractiveInput: true,
      supportsResume: false,
      supportsCheckpoint: false,
      supportsApprovalGating: false,
      supportsToolUseEvents: false,
      supportsStreaming: true,
      supportsModelSelection: true,
      nativeMcp: false,
      version: '1.0.0',
    };
  }
  if (config.providers.opencode) {
    matrix.opencode = {
      provider: 'opencode',
      supportsInteractiveInput: true,
      supportsResume: false,
      supportsCheckpoint: false,
      supportsApprovalGating: false,
      supportsToolUseEvents: false,
      supportsStreaming: true,
      supportsModelSelection: true,
      nativeMcp: true,
      version: '1.0.0',
    };
  }
  if (config.providers.zenflow) {
    matrix.zenflow = {
      provider: 'zenflow',
      supportsInteractiveInput: true,
      supportsResume: true,
      supportsCheckpoint: true,
      supportsApprovalGating: true,
      supportsToolUseEvents: true,
      supportsStreaming: true,
      supportsModelSelection: true,
      nativeMcp: false,
      version: '1.0.0',
    };
  }
  if (config.providers.rev) {
    matrix.rev = {
      provider: 'rev',
      supportsInteractiveInput: true,
      supportsResume: false,
      supportsCheckpoint: false,
      supportsApprovalGating: false,
      supportsToolUseEvents: false,
      supportsStreaming: true,
      supportsModelSelection: true,
      nativeMcp: false,
      version: '1.0.0',
    };
  }

  return matrix;
}
