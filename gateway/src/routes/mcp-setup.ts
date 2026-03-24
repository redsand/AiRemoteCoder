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
 * Supported providers: claude, codex, gemini, opencode, rev
 */

import type { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { db } from '../services/database.js';
import { uiAuth } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { config } from '../config.js';

// All scopes a coding agent reasonably needs — conservative but functional
const AGENT_DEFAULT_SCOPES = [
  'runs:read', 'runs:write', 'runs:cancel',
  'sessions:read', 'sessions:write',
  'events:read',
  'artifacts:read', 'artifacts:write',
  'approvals:read',
];

const SUPPORTED_PROVIDERS = ['claude', 'codex', 'gemini', 'opencode', 'rev'] as const;
type SupportedProvider = typeof SUPPORTED_PROVIDERS[number];

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
        filePath: '.claude/mcp.json',
        fileFormat: 'json',
        instructions: 'Add to .claude/mcp.json in your project root. Claude Code will pick it up automatically.',
      };

    case 'codex':
      return {
        snippet: `MCP_SERVER_URL=${mcpUrl}\nMCP_AUTH_TOKEN=${token}`,
        filePath: null, // env var — no standard file
        fileFormat: 'env',
        instructions: 'Export these environment variables before running codex, or add them to your .env file.',
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

  // Return existing non-revoked token for this provider if present
  const existing = db.prepare(`
    SELECT id FROM mcp_tokens
    WHERE user_id = ? AND label = ? AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > unixepoch())
    LIMIT 1
  `).get(userId, label) as { id: string } | undefined;

  if (existing) {
    // We can't return the raw token (hashed at rest) — create a fresh one
    // so the user always gets a usable value from this endpoint
  }

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
      const { projectRoot: clientProjectRoot } = req.body as { projectRoot?: string };

      if (!SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) {
        return reply.code(400).send({ error: `Unsupported provider: ${provider}` });
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

      if (!filePath) {
        // Env-var providers — return the snippet for manual application
        return reply.code(200).send({
          provider,
          installed: false,
          reason: 'This provider uses environment variables, not a config file.',
          snippet,
          instructions,
          token: rawToken,
        });
      }

      // Resolve target file path
      const projectDir = clientProjectRoot
        ? resolve(clientProjectRoot)
        : config.projectRoot;

      const targetPath = resolve(projectDir, filePath);
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
          filePath: targetPath,
          instructions,
          token: rawToken,
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
      const { projectRoot: clientProjectRoot } = req.query as { projectRoot?: string };
      const projectDir = clientProjectRoot
        ? resolve(clientProjectRoot)
        : config.projectRoot;

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

      return reply.send({ status, projectDir });
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
