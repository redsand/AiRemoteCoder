/**
 * MCP provider setup endpoint.
 *
 * POST /api/mcp/setup/:provider
 *   - Creates an MCP token scoped for the provider (if none exists with that label)
 *   - Returns the exact config snippet the user should paste / the auto-installer writes
 *
 * POST /api/mcp/setup/:provider/install
 *   - Writes the config snippet to the expected file path for that provider
 *   - Only works when the gateway has filesystem access to the target project directory
 *   - The project directory is the gateway's working directory (GATEWAY_PROJECT_ROOT or cwd)
 *
 * Supported providers: claude, codex, gemini, opencode, rev, zenflow
 */

import type { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname, relative, isAbsolute } from 'path';
import { db } from '../services/database.js';
import { uiAuth } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { config } from '../config.js';
import type { McpScope } from '../domain/types.js';

// All scopes a coding agent reasonably needs — conservative but functional
const AGENT_DEFAULT_SCOPES: McpScope[] = [
  'runs:read', 'runs:write', 'runs:cancel',
  'vnc:read', 'vnc:control',
  'sessions:read', 'sessions:write',
  'events:read',
  'artifacts:read', 'artifacts:write',
  'approvals:read', 'approvals:write',
];

const SUPPORTED_PROVIDERS = ['claude', 'codex', 'gemini', 'opencode', 'rev', 'zenflow'] as const;
type SupportedProvider = typeof SUPPORTED_PROVIDERS[number];

interface ProjectTargetRecord {
  id: string;
  user_id: string;
  label: string;
  path: string;
  machine_id: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

interface SetupBody {
  projectTargetId?: string;
  projectPath?: string;
}

function normalizeProjectPath(inputPath: string): string {
  const absolute = isAbsolute(inputPath)
    ? inputPath
    : resolve(config.projectRoot, inputPath);
  return absolute.replace(/\\/g, '/');
}

function isPathWithinRoot(projectPath: string, rootPath: string): boolean {
  const normalizedProject = normalizeProjectPath(projectPath);
  const normalizedRoot = normalizeProjectPath(rootPath);
  const rel = relative(normalizedRoot, normalizedProject);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isProjectPathAllowed(projectPath: string): boolean {
  return config.projectRoots.some((rootPath) => isPathWithinRoot(projectPath, rootPath));
}

function resolveProjectDirForRequest(
  request: AuthenticatedRequest,
  body: SetupBody | undefined
): { projectDir: string; projectTargetId: string | null } | { error: string; statusCode: number } {
  const user = request.user;
  const requestedTargetId = body?.projectTargetId?.trim();
  const requestedPath = body?.projectPath?.trim();

  if (requestedTargetId) {
    const target = db.prepare(`
      SELECT id, user_id, label, path, machine_id, metadata, created_at, updated_at
      FROM project_targets WHERE id = ?
    `).get(requestedTargetId) as ProjectTargetRecord | undefined;

    if (!target) {
      return { error: `Project target not found: ${requestedTargetId}`, statusCode: 404 };
    }

    if (target.user_id !== user!.id && user!.role !== 'admin') {
      return { error: 'Project target does not belong to the authenticated user', statusCode: 403 };
    }
    if (target.machine_id) {
      if (!request.deviceId) {
        return { error: 'Target requires device identity header (x-airc-device-id)', statusCode: 403 };
      }
      if (target.machine_id !== request.deviceId) {
        return { error: 'Project target is bound to a different device', statusCode: 403 };
      }
    }

    return { projectDir: target.path, projectTargetId: target.id };
  }

  if (requestedPath) {
    const normalized = normalizeProjectPath(requestedPath);
    if (!isProjectPathAllowed(normalized)) {
      return {
        error: `Requested projectPath is outside allowed roots (${config.projectRoots.join(', ')})`,
        statusCode: 403,
      };
    }
    return { projectDir: normalized, projectTargetId: null };
  }

  return { projectDir: config.projectRoot, projectTargetId: null };
}

// ---------------------------------------------------------------------------
// Config snippet builders per provider
// ---------------------------------------------------------------------------

function buildSnippet(provider: SupportedProvider, mcpUrl: string, token: string): {
  snippet: object | string;
  filePath: string | null;
  fileFormat: 'json' | 'env' | 'text';
  instructions: string;
} {
  switch (provider) {
    case 'claude':
    case 'zenflow':
      return {
        snippet: {
          mcpServers: {
            airemotecoder: {
              type: 'http',
              url: mcpUrl,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        filePath: provider === 'zenflow' ? '.zenflow/mcp.json' : '.claude/mcp.json',
        fileFormat: 'json',
        instructions: provider === 'zenflow'
          ? 'Add to .zenflow/mcp.json in your project root. Zenflow will pick it up automatically.'
          : 'Add to .claude/mcp.json in your project root. Claude Code will pick it up automatically.',
      };

    case 'codex':
      return {
        snippet: `# Preferred (Codex MCP registry command)\ncodex mcp add airemotecoder --url ${mcpUrl}\n\n# Optional example: GitHub MCP server\ncodex mcp add github --url https://api.githubcopilot.com/mcp/\n\n# Fallback (env-based remote MCP)\nMCP_SERVER_URL=${mcpUrl}\nMCP_SERVER_TOKEN=${token}`,
        filePath: null, // env var — no standard file
        fileFormat: 'env',
        instructions: 'Use codex mcp add if available in your Codex build. Otherwise export MCP_SERVER_URL and MCP_SERVER_TOKEN before running codex.',
      };

    case 'gemini':
      return {
        snippet: {
          mcpServers: {
            airemotecoder: {
              httpUrl: mcpUrl,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        filePath: '.gemini/settings.json',
        fileFormat: 'json',
        instructions: 'Add to .gemini/settings.json in your project root.',
      };

    case 'opencode':
      return {
        snippet: {
          $schema: 'https://opencode.ai/config.schema.json',
          mcp: {
            airemotecoder: {
              type: 'remote',
              url: mcpUrl,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        filePath: 'opencode.json',
        fileFormat: 'json',
        instructions: 'Add the mcp.airemotecoder key to your opencode.json config.',
      };

    case 'rev':
      return {
        snippet: `AIRC_MCP_URL=${mcpUrl}\nAIRC_MCP_TOKEN=${token}`,
        filePath: null,
        fileFormat: 'env',
        instructions: 'Export these environment variables before running rev.',
      };
  }
}

// ---------------------------------------------------------------------------
// Token creation helper
// ---------------------------------------------------------------------------

function getOrCreateAgentToken(
  userId: string,
  provider: SupportedProvider
): { tokenId: string; rawToken: string; isNew: boolean } {
  const label = `auto:${provider}`;

  const rawToken = nanoid(48);
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const tokenId = nanoid();

  // Revoke previous auto-token for this provider to avoid accumulation
  db.prepare(`
    UPDATE mcp_tokens SET revoked_at = unixepoch()
    WHERE user_id = ? AND label = ? AND revoked_at IS NULL
  `).run(userId, label);

  db.prepare(`
    INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes)
    VALUES (?, ?, ?, ?, ?)
  `).run(tokenId, tokenHash, label, userId, JSON.stringify(AGENT_DEFAULT_SCOPES));

  return { tokenId, rawToken, isNew: true };
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function mcpSetupRoutes(fastify: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /api/mcp/setup/:provider — generate token + snippet
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/mcp/setup/:provider',
    { preHandler: [uiAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const { provider } = req.params as { provider: string };

      if (!SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) {
        return reply.code(400).send({
          error: `Unsupported provider: ${provider}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
        });
      }

      const resolved = resolveProjectDirForRequest(req, (req.body ?? {}) as SetupBody);
      if ('error' in resolved) {
        return reply.code(resolved.statusCode).send({ error: resolved.error });
      }

      const proto = config.tlsEnabled ? 'https' : 'http';
      const host = req.headers.host || `localhost:${config.port}`;
      const mcpUrl = `${proto}://${host}${config.mcpPath}`;

      const { rawToken } = getOrCreateAgentToken(req.user!.id, provider as SupportedProvider);
      const { snippet, filePath, fileFormat, instructions } = buildSnippet(
        provider as SupportedProvider,
        mcpUrl,
        rawToken
      );

      return reply.code(200).send({
        provider,
        token: rawToken,
        projectDir: resolved.projectDir,
        projectTargetId: resolved.projectTargetId,
        mcpUrl,
        snippet,
        filePath,
        fileFormat,
        instructions,
        canAutoInstall: filePath !== null,
        warning: 'Token shown once — it will be regenerated on next call to this endpoint.',
      });
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/mcp/setup/:provider/install — write config file to project
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/mcp/setup/:provider/install',
    { preHandler: [uiAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const { provider } = req.params as { provider: string };
      const { token, projectTargetId, projectPath } = req.body as { token?: string; projectTargetId?: string; projectPath?: string };

      if (!SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) {
        return reply.code(400).send({ error: `Unsupported provider: ${provider}` });
      }

      if (!token || typeof token !== 'string') {
        return reply.code(400).send({ error: 'token is required and must match the setup response token' });
      }

      const resolved = resolveProjectDirForRequest(req, { projectTargetId, projectPath });
      if ('error' in resolved) {
        return reply.code(resolved.statusCode).send({ error: resolved.error });
      }

      const proto = config.tlsEnabled ? 'https' : 'http';
      const host = req.headers.host || `localhost:${config.port}`;
      const mcpUrl = `${proto}://${host}${config.mcpPath}`;
      const { snippet, filePath, fileFormat, instructions } = buildSnippet(
        provider as SupportedProvider,
        mcpUrl,
        token
      );

      if (!filePath) {
        // Env-var providers — return the snippet for manual application
        return reply.code(200).send({
          provider,
          installed: false,
          reason: 'This provider uses environment variables, not a config file.',
          snippet,
          instructions,
          token,
        });
      }

      // Resolve target file path
      const targetPath = resolve(resolved.projectDir, filePath);
      const targetDir = dirname(targetPath);

      try {
        mkdirSync(targetDir, { recursive: true });

        if (fileFormat === 'json') {
          // Merge with existing config if present, to avoid clobbering other settings
          let existing: Record<string, unknown> = {};
          if (existsSync(targetPath)) {
            try {
              existing = JSON.parse(readFileSync(targetPath, 'utf-8'));
            } catch {
              // Invalid JSON — overwrite
            }
          }

          const merged = deepMerge(existing, snippet as Record<string, unknown>);
          writeFileSync(targetPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
        } else {
          writeFileSync(targetPath, snippet as string, 'utf-8');
        }

        return reply.code(200).send({
          provider,
          installed: true,
          projectDir: resolved.projectDir,
          projectTargetId: resolved.projectTargetId,
          filePath: targetPath,
          instructions,
          token,
          message: `Config written to ${targetPath}`,
        });
      } catch (err: any) {
        return reply.code(500).send({
          error: `Failed to write config: ${err.message}`,
          filePath: targetPath,
        });
      }
    }
  );

  // -------------------------------------------------------------------------
  // GET /api/mcp/setup/status — detect which providers are already configured
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/mcp/setup/status',
    { preHandler: [uiAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const query = req.query as { projectTargetId?: string; projectPath?: string };
      const resolveInput: SetupBody = {
        projectTargetId: query.projectTargetId,
        projectPath: query.projectPath,
      };
      const resolved = resolveProjectDirForRequest(req, resolveInput);
      if ('error' in resolved) {
        return reply.code(resolved.statusCode).send({ error: resolved.error });
      }
      const projectDir = resolved.projectDir;

      const status: Record<string, {
        configured: boolean;
        filePath: string | null;
        exists: boolean;
        hasAiRemoteCoder: boolean;
      }> = {};

      for (const provider of SUPPORTED_PROVIDERS) {
        const { filePath } = buildSnippet(provider, '', '');
        if (!filePath) {
          status[provider] = { configured: false, filePath: null, exists: false, hasAiRemoteCoder: false };
          continue;
        }

        const fullPath = resolve(projectDir, filePath);
        const exists = existsSync(fullPath);
        let hasAiRemoteCoder = false;

        if (exists) {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            hasAiRemoteCoder = content.includes('airemotecoder');
          } catch {
            // ignore
          }
        }

        status[provider] = { configured: hasAiRemoteCoder, filePath: fullPath, exists, hasAiRemoteCoder };
      }

      return reply.send({ status, projectDir, projectTargetId: resolved.projectTargetId });
    }
  );

  fastify.get(
    '/api/mcp/project-targets',
    { preHandler: [uiAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const targets = req.user!.role === 'admin'
        ? db.prepare(`
            SELECT id, user_id, label, path, machine_id, metadata, created_at, updated_at
            FROM project_targets
            ORDER BY updated_at DESC
          `).all()
        : db.prepare(`
            SELECT id, user_id, label, path, machine_id, metadata, created_at, updated_at
            FROM project_targets
            WHERE user_id = ?
            ORDER BY updated_at DESC
          `).all(req.user!.id);

      return reply.send({ targets });
    }
  );

  fastify.post(
    '/api/mcp/project-targets',
    { preHandler: [uiAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const { label, path, machineId, metadata } = req.body as {
        label?: string;
        path?: string;
        machineId?: string | null;
        metadata?: Record<string, unknown> | null;
      };

      if (!label || typeof label !== 'string' || !label.trim()) {
        return reply.code(400).send({ error: 'label is required' });
      }
      if (!path || typeof path !== 'string' || !path.trim()) {
        return reply.code(400).send({ error: 'path is required' });
      }

      const normalizedPath = normalizeProjectPath(path);
      if (!isProjectPathAllowed(normalizedPath)) {
        return reply.code(403).send({
          error: `path is outside allowed roots (${config.projectRoots.join(', ')})`,
        });
      }

      const resolvedMachineId = machineId ?? req.deviceId ?? null;

      const existing = db.prepare(`
        SELECT id, user_id, label, path, machine_id, metadata, created_at, updated_at
        FROM project_targets WHERE user_id = ? AND path = ?
      `).get(req.user!.id, normalizedPath) as ProjectTargetRecord | undefined;

      if (existing) {
        db.prepare(`
          UPDATE project_targets
          SET label = ?, machine_id = ?, metadata = ?, updated_at = unixepoch()
          WHERE id = ?
        `).run(
          label.trim(),
          resolvedMachineId,
          metadata ? JSON.stringify(metadata) : null,
          existing.id
        );
        return reply.send({
          id: existing.id,
          user_id: req.user!.id,
          label: label.trim(),
          path: normalizedPath,
          machine_id: resolvedMachineId,
          metadata: metadata ?? null,
          updated: true,
        });
      }

      const id = nanoid();
      db.prepare(`
        INSERT INTO project_targets (id, user_id, label, path, machine_id, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(
        id,
        req.user!.id,
        label.trim(),
        normalizedPath,
        resolvedMachineId,
        metadata ? JSON.stringify(metadata) : null
      );

      return reply.code(201).send({
        id,
        user_id: req.user!.id,
        label: label.trim(),
        path: normalizedPath,
        machine_id: resolvedMachineId,
        metadata: metadata ?? null,
        updated: false,
      });
    }
  );

  fastify.delete(
    '/api/mcp/project-targets/:id',
    { preHandler: [uiAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const { id } = req.params as { id: string };
      const target = db.prepare(`
        SELECT id, user_id FROM project_targets WHERE id = ?
      `).get(id) as { id: string; user_id: string } | undefined;

      if (!target) {
        return reply.code(404).send({ error: 'Project target not found' });
      }
      if (target.user_id !== req.user!.id && req.user!.role !== 'admin') {
        return reply.code(403).send({ error: 'Cannot delete another user target' });
      }

      db.prepare('DELETE FROM project_targets WHERE id = ?').run(id);
      return reply.send({ ok: true, id });
    }
  );
}

// ---------------------------------------------------------------------------
// Deep merge helper (shallow enough for config objects)
// ---------------------------------------------------------------------------

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (val && typeof val === 'object' && !Array.isArray(val) &&
        result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}
