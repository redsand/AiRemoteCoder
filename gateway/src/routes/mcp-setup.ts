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
  generateNewToken?: boolean;
  persistEnv?: boolean;
}

interface CopyPasteCommands {
  bash: string[];
  powershell: string[];
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
        return { error: 'Target requires trusted device identity from authenticated session', statusCode: 403 };
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

function buildSnippet(
  provider: SupportedProvider,
  mcpUrl: string,
  token: string,
  options: { persistEnv?: boolean } = {}
): {
  snippet: object | string;
  filePath: string | null;
  fileFormat: 'json' | 'env' | 'text';
  instructions: string;
  copyPaste: CopyPasteCommands;
} {
  const quotedUrl = mcpUrl.replace(/"/g, '\\"');
  const quotedToken = token.replace(/"/g, '\\"');
  const jsonCopyPaste = (
    filePath: string,
    snippetObject: Record<string, unknown>
  ): CopyPasteCommands => {
    const rendered = JSON.stringify(snippetObject, null, 2);
    const normalizedPath = filePath.replace(/\\/g, '/');
    const escapedPath = normalizedPath.replace(/'/g, "\\'");
    const escapedPatch = rendered.replace(/'''/g, "\\'\\'\\'");
    return {
      bash: [
        `mkdir -p "${dirname(normalizedPath)}"
python - <<'PY'
import json
from pathlib import Path

path = Path('${escapedPath}')
patch = json.loads('''${escapedPatch}''')

def merge(dst, src):
    for key, value in src.items():
        if isinstance(value, dict) and isinstance(dst.get(key), dict):
            merge(dst[key], value)
        else:
            dst[key] = value

current = {}
if path.exists():
    try:
        current = json.loads(path.read_text(encoding='utf-8') or '{}')
    except Exception:
        current = {}

merge(current, patch)
path.write_text(json.dumps(current, indent=2) + '\\n', encoding='utf-8')
PY`,
      ],
      powershell: [
        `$path = "${filePath.replace(/\//g, '\\\\')}"
$dir = Split-Path -Parent $path
if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$patchJson = @'
${rendered}
'@
$patch = $patchJson | ConvertFrom-Json -AsHashtable
$current = @{}
if (Test-Path $path) {
  $raw = Get-Content -Raw -Path $path
  if ($raw.Trim()) {
    try { $current = $raw | ConvertFrom-Json -AsHashtable } catch { $current = @{} }
  }
}
function Merge-Hashtable([hashtable]$dst, [hashtable]$src) {
  foreach ($key in $src.Keys) {
    $srcVal = $src[$key]
    if ($dst.ContainsKey($key) -and $dst[$key] -is [hashtable] -and $srcVal -is [hashtable]) {
      Merge-Hashtable -dst $dst[$key] -src $srcVal
    } else {
      $dst[$key] = $srcVal
    }
  }
}
Merge-Hashtable -dst $current -src $patch
$current | ConvertTo-Json -Depth 100 | Set-Content -Path $path -Encoding utf8`,
      ],
    };
  };

  const buildEnvPrefix = (envVar: string, envValue: string, persistEnv: boolean): { bash: string; powershell: string } => {
    if (!persistEnv) {
      return {
        bash: `export ${envVar}="${envValue}"`,
        powershell: `$env:${envVar}="${envValue}"`,
      };
    }
    return {
      bash: `export ${envVar}="${envValue}"
python - <<'PY'
from pathlib import Path
import re

path = Path.home() / ".profile"
line = 'export ${envVar}="${envValue}"'
text = path.read_text(encoding="utf-8") if path.exists() else ""
lines = [entry for entry in text.splitlines() if not re.match(r'^\\s*export\\s+${envVar}=.*$', entry)]
if lines and lines[-1] != "":
    lines.append("")
lines.append(line)
path.write_text("\\n".join(lines) + "\\n", encoding="utf-8")
PY`,
      powershell: `$env:${envVar}="${envValue}"
[Environment]::SetEnvironmentVariable("${envVar}", "${envValue}", "User")`,
    };
  };

  const buildCodexSnippet = (persistEnv: boolean) => {
    const envPrefix = buildEnvPrefix('AIREMOTECODER_MCP_TOKEN', token, persistEnv);
    const localGatewayPath = `${config.projectRoot.replace(/\\/g, '/')}/gateway`;
    const localGatewayPathWin = localGatewayPath.replace(/\//g, '\\\\');
    const manualToml = `[mcp_servers.airemotecoder]
url = "${mcpUrl}"
bearer_token_env_var = "AIREMOTECODER_MCP_TOKEN"`;
    const bashOneShot = `${envPrefix.bash}
mkdir -p ~/.codex
touch ~/.codex/config.toml
python - <<'PY'
from pathlib import Path
import re

path = Path.home() / ".codex" / "config.toml"
text = path.read_text(encoding="utf-8") if path.exists() else ""
prefix = "mcp_servers.airemotecoder"
out = []
skip = False

for line in text.splitlines():
    m = re.match(r"^\\s*\\[([^\\]]+)\\]\\s*(?:[#;].*)?$", line)
    if m:
        table = m.group(1).strip()
        if table == prefix or table.startswith(prefix + "."):
            skip = True
            continue
        skip = False
    if not skip:
        out.append(line)

if out and out[-1] != "":
    out.append("")
out.extend([
    "[mcp_servers.airemotecoder]",
    "url = \\"${mcpUrl}\\"",
    "bearer_token_env_var = \\"AIREMOTECODER_MCP_TOKEN\\"",
    "",
])
path.write_text("\\n".join(out), encoding="utf-8")
PY`;
    const workerBash = `export AIREMOTECODER_GATEWAY_URL="${mcpUrl}"
export AIREMOTECODER_MCP_TOKEN="${token}"
export AIREMOTECODER_PROVIDER="codex"
export AIREMOTECODER_CODEX_MODE="interactive"
npx -y @ai-remote-coder/mcp-runner@latest || npm --prefix "${localGatewayPath}" run worker:mcp`;

    const powershellOneShot = `${envPrefix.powershell}
$configDir = Join-Path $HOME ".codex"
$configPath = Join-Path $configDir "config.toml"
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
if (!(Test-Path $configPath)) { New-Item -ItemType File -Path $configPath | Out-Null }
$lines = Get-Content -Path $configPath
$prefix = "mcp_servers.airemotecoder"
$skip = $false
$out = New-Object System.Collections.Generic.List[string]
foreach ($line in $lines) {
  if ($line -match '^\\s*\\[([^\\]]+)\\]\\s*(?:[#;].*)?$') {
    $table = $matches[1].Trim()
    if ($table -eq $prefix -or $table.StartsWith("$prefix.")) { $skip = $true; continue }
    if ($skip) { $skip = $false }
  }
  if (-not $skip) { [void]$out.Add($line) }
}
Set-Content -Path $configPath -Value $out -Encoding utf8
@'

[mcp_servers.airemotecoder]
url = "${mcpUrl}"
bearer_token_env_var = "AIREMOTECODER_MCP_TOKEN"
'@ | Add-Content -Path $configPath -Encoding utf8`;
    const workerPowerShell = `$env:AIREMOTECODER_GATEWAY_URL="${mcpUrl}"
$env:AIREMOTECODER_MCP_TOKEN="${token}"
$env:AIREMOTECODER_PROVIDER="codex"
$env:AIREMOTECODER_CODEX_MODE="interactive"
npx -y @ai-remote-coder/mcp-runner@latest
if ($LASTEXITCODE -ne 0) { npm --prefix "${localGatewayPathWin}" run worker:mcp }`;

    return {
      snippet: manualToml,
      filePath: null as string | null,
      fileFormat: 'env' as const,
      instructions: persistEnv
        ? 'Run the first one-shot command to persist token + update ~/.codex/config.toml (airemotecoder block only). Run the second command to start MCP worker mode (interactive by default). Set AIREMOTECODER_CODEX_MODE=exec if you prefer one-shot codex exec.'
        : 'Run the first one-shot command to set token in this shell + update ~/.codex/config.toml (airemotecoder block only). Run the second command to start MCP worker mode (interactive by default). Set AIREMOTECODER_CODEX_MODE=exec if you prefer one-shot codex exec.',
      copyPaste: {
        bash: [bashOneShot, workerBash],
        powershell: [powershellOneShot, workerPowerShell],
      },
    };
  };

  switch (provider) {
    case 'claude':
    case 'zenflow': {
      const snippet = {
        mcpServers: {
          airemotecoder: {
            type: 'http',
            url: mcpUrl,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      };
      const filePath = provider === 'zenflow' ? '.zenflow/mcp.json' : '.claude/mcp.json';
      return {
        snippet,
        filePath,
        fileFormat: 'json',
        instructions: provider === 'zenflow'
          ? 'Add to .zenflow/mcp.json in your project root. Zenflow will pick it up automatically.'
          : 'Add to .claude/mcp.json in your project root. Claude Code will pick it up automatically.',
        copyPaste: jsonCopyPaste(filePath, snippet),
      };
    }

    case 'codex': {
      return buildCodexSnippet(Boolean(options.persistEnv));
    }

    case 'gemini': {
      const snippet = {
        mcpServers: {
          airemotecoder: {
            httpUrl: mcpUrl,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      };
      return {
        snippet,
        filePath: '.gemini/settings.json',
        fileFormat: 'json',
        instructions: 'Add to .gemini/settings.json in your project root.',
        copyPaste: jsonCopyPaste('.gemini/settings.json', snippet),
      };
    }

    case 'opencode': {
      const snippet = {
        $schema: 'https://opencode.ai/config.schema.json',
        mcp: {
          airemotecoder: {
            type: 'remote',
            url: mcpUrl,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      };
      return {
        snippet,
        filePath: 'opencode.json',
        fileFormat: 'json',
        instructions: 'Add the mcp.airemotecoder key to your opencode.json config.',
        copyPaste: jsonCopyPaste('opencode.json', snippet),
      };
    }

    case 'rev':
      const revUrlEnv = buildEnvPrefix('AIRC_MCP_URL', mcpUrl, Boolean(options.persistEnv));
      const revEnv = buildEnvPrefix('AIRC_MCP_TOKEN', token, Boolean(options.persistEnv));
      return {
        snippet: `AIRC_MCP_URL=${mcpUrl}\nAIRC_MCP_TOKEN=<YOUR_MCP_TOKEN>`,
        filePath: null,
        fileFormat: 'env',
        instructions: Boolean(options.persistEnv)
          ? 'Run one one-shot command below to persist AIRC_MCP_TOKEN for future shells before running rev.'
          : 'Run one one-shot command below before running rev.',
        copyPaste: {
          bash: [
            `${revUrlEnv.bash}
${revEnv.bash}`,
          ],
          powershell: [
            `${revUrlEnv.powershell}
${revEnv.powershell}`,
          ],
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Token creation helper
// ---------------------------------------------------------------------------

const setupTokenCache = new Map<string, { tokenId: string; rawToken: string }>();

function getOrCreateAgentToken(
  userId: string,
  provider: SupportedProvider,
  options: { generateNewToken?: boolean } = {}
): { tokenId: string; rawToken: string; isNew: boolean } {
  const label = `auto:${provider}`;
  const cacheKey = `${userId}:${provider}`;
  const cached = setupTokenCache.get(cacheKey);
  const forceNew = Boolean(options.generateNewToken);

  if (!forceNew && cached) {
    const tokenRow = db.prepare(`
      SELECT id, last_used_at, revoked_at, expires_at
      FROM mcp_tokens WHERE id = ?
    `).get(cached.tokenId) as { id: string; last_used_at: number | null; revoked_at: number | null; expires_at: number | null } | undefined;

    const now = Math.floor(Date.now() / 1000);
    const expired = Boolean(tokenRow?.expires_at && tokenRow.expires_at <= now);
    if (tokenRow && !tokenRow.revoked_at && !expired && !tokenRow.last_used_at) {
      return { tokenId: cached.tokenId, rawToken: cached.rawToken, isNew: false };
    }
  }

  const rawToken = nanoid(48);
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const tokenId = nanoid();
  db.prepare(`
    INSERT INTO mcp_tokens (id, token_hash, label, user_id, scopes)
    VALUES (?, ?, ?, ?, ?)
  `).run(tokenId, tokenHash, label, userId, JSON.stringify(AGENT_DEFAULT_SCOPES));

  setupTokenCache.set(cacheKey, { tokenId, rawToken });
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

      const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
      const proto = forwardedProto || (req.protocol ?? (config.tlsEnabled ? 'https' : 'http'));
      const host = req.headers.host || `localhost:${config.port}`;
      const mcpUrl = `${proto}://${host}${config.mcpPath}`;

      const body = (req.body ?? {}) as SetupBody;
      const persistEnv = Boolean(body.persistEnv);
      const { rawToken, isNew } = getOrCreateAgentToken(
        req.user!.id,
        provider as SupportedProvider,
        { generateNewToken: Boolean(body.generateNewToken) }
      );
      const { snippet, filePath, fileFormat, instructions, copyPaste } = buildSnippet(
        provider as SupportedProvider,
        mcpUrl,
        rawToken,
        { persistEnv }
      );

      return reply.code(200).send({
        provider,
        token: rawToken,
        projectDir: resolved.projectDir,
        projectTargetId: resolved.projectTargetId,
        mcpUrl,
        snippet,
        copyPaste,
        filePath,
        fileFormat,
        instructions,
        canAutoInstall: filePath !== null,
        tokenReused: !isNew,
        warning: isNew
          ? 'Token shown once — store it securely.'
          : 'Reusing your latest unused token for this provider. Click "Generate New Token" to rotate.',
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
      const { token, projectTargetId, projectPath, persistEnv } = req.body as {
        token?: string;
        projectTargetId?: string;
        projectPath?: string;
        persistEnv?: boolean;
      };

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

      const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
      const proto = forwardedProto || (req.protocol ?? (config.tlsEnabled ? 'https' : 'http'));
      const host = req.headers.host || `localhost:${config.port}`;
      const mcpUrl = `${proto}://${host}${config.mcpPath}`;
      const { snippet, filePath, fileFormat, instructions, copyPaste } = buildSnippet(
        provider as SupportedProvider,
        mcpUrl,
        token,
        { persistEnv: Boolean(persistEnv) }
      );

      if (!filePath) {
        // Env-var providers — return the snippet for manual application
        return reply.code(200).send({
          provider,
          installed: false,
          reason: 'This provider uses environment variables, not a config file.',
          snippet,
          copyPaste,
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
          copyPaste,
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
