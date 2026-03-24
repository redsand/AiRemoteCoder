import Fastify from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const { projectRoot } = vi.hoisted(() => ({
  projectRoot: `${process.cwd()}\\.test-data\\mcp-setup-${Math.random().toString(36).slice(2)}`,
}));

const tokens: Array<{
  id: string;
  token_hash: string;
  label: string;
  user_id: string;
  scopes: string;
  created_at?: number;
  last_used_at?: number | null;
  revoked_at?: number | null;
  expires_at?: number | null;
}> = [];
const projectTargets: Array<{
  id: string;
  user_id: string;
  label: string;
  path: string;
  machine_id: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}> = [];

vi.mock('../config.js', () => ({
  config: {
    projectRoot,
    projectRoots: [projectRoot.replace(/\\/g, '/')],
    tlsEnabled: false,
    port: 3100,
    mcpPath: '/mcp',
  },
}));

vi.mock('../middleware/auth.js', () => ({
  uiAuth: (req: any, _reply: any, done: () => void) => {
    const cookieHeader = String(req.headers?.cookie || '');
    if (cookieHeader.includes('session=session-user-2')) {
      req.user = { id: 'user-2', username: 'bob', role: 'admin' };
      req.deviceId = 'dev_device_two';
    } else {
      req.user = { id: 'user-1', username: 'alice', role: 'admin' };
      req.deviceId = 'dev_device_one';
    }
    done();
  },
}));

vi.mock('../services/database.js', () => ({
  db: {
    prepare: (sql: string) => ({
      get: (...args: any[]) => {
        if (sql.includes('FROM project_targets WHERE id = ?')) {
          return projectTargets.find((entry) => entry.id === args[0]);
        }
        if (sql.includes('FROM mcp_tokens WHERE id = ?')) {
          return tokens.find((entry) => entry.id === args[0]);
        }
        if (sql.includes('FROM project_targets WHERE user_id = ? AND path = ?')) {
          return projectTargets.find((entry) => entry.user_id === args[0] && entry.path === args[1]);
        }
        return undefined;
      },
      all: (...args: any[]) => {
        if (sql.includes('FROM project_targets') && sql.includes('WHERE user_id = ?')) {
          return projectTargets.filter((entry) => entry.user_id === args[0]);
        }
        if (sql.includes('FROM project_targets')) {
          return [...projectTargets];
        }
        return [];
      },
      run: (...args: any[]) => {
        if (sql.includes('INSERT INTO mcp_tokens')) {
          tokens.push({
            id: args[0],
            token_hash: args[1],
            label: args[2],
            user_id: args[3],
            scopes: args[4],
            created_at: Math.floor(Date.now() / 1000),
            last_used_at: null,
            revoked_at: null,
            expires_at: null,
          });
        }
        if (sql.includes('UPDATE mcp_tokens SET revoked_at')) {
          const token = tokens.find((entry) => entry.id === args[0]);
          if (token) {
            (token as any).revoked_at = Math.floor(Date.now() / 1000);
          }
        }
        if (sql.includes('INSERT INTO project_targets')) {
          projectTargets.push({
            id: args[0],
            user_id: args[1],
            label: args[2],
            path: args[3],
            machine_id: args[4],
            metadata: args[5],
            created_at: Math.floor(Date.now() / 1000),
            updated_at: Math.floor(Date.now() / 1000),
          });
        }
        if (sql.includes('UPDATE project_targets') && sql.includes('WHERE id = ?')) {
          const target = projectTargets.find((entry) => entry.id === args[3]);
          if (target) {
            target.label = args[0];
            target.machine_id = args[1];
            target.metadata = args[2];
            target.updated_at = Math.floor(Date.now() / 1000);
          }
        }
        if (sql.includes('DELETE FROM project_targets WHERE id = ?')) {
          const index = projectTargets.findIndex((entry) => entry.id === args[0]);
          if (index >= 0) projectTargets.splice(index, 1);
        }
      },
    }),
  },
}));

describe('mcpSetupRoutes', () => {
  beforeEach(() => {
    tokens.length = 0;
    projectTargets.length = 0;
    mkdirSync(projectRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function buildApp() {
    const app = Fastify({ logger: false });
    const { mcpSetupRoutes } = await import('./mcp-setup.js');
    await app.register(mcpSetupRoutes);
    await app.ready();
    return app;
  }

  it('uses the same token for setup and auto-install', async () => {
    const app = await buildApp();

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude',
    });

    expect(setupRes.statusCode).toBe(200);
    const setup = setupRes.json() as { token: string; snippet: any };
    expect(setup.snippet.mcpServers.airemotecoder.headers.Authorization).toBe(`Bearer ${setup.token}`);

    const installRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude/install',
      payload: { token: setup.token },
    });

    expect(installRes.statusCode).toBe(200);
    const install = installRes.json() as { token: string; filePath: string };
    expect(install.token).toBe(setup.token);

    const writtenPath = join(projectRoot, '.claude', 'mcp.json');
    expect(existsSync(writtenPath)).toBe(true);
    const written = JSON.parse(readFileSync(writtenPath, 'utf-8')) as any;
    expect(written.mcpServers.airemotecoder.headers.Authorization).toBe(`Bearer ${setup.token}`);
    expect(tokens).toHaveLength(1);
    const tokenScopes = JSON.parse(tokens[0].scopes) as string[];
    expect(tokenScopes).toContain('vnc:read');
    expect(tokenScopes).toContain('vnc:control');

    await app.close();
  });

  it('rejects install without a token', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude/install',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns an env snippet for codex install without writing a file', async () => {
    const app = await buildApp();

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/codex',
    });

    expect(setupRes.statusCode).toBe(200);
    const setup = setupRes.json() as { token: string };

    const installRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/codex/install',
      payload: { token: setup.token },
    });

    expect(installRes.statusCode).toBe(200);
    const install = installRes.json() as {
      installed: boolean;
      snippet: string;
      token: string;
      instructions: string;
      copyPaste?: { bash?: string[]; powershell?: string[] };
    };
    expect(install.installed).toBe(false);
    expect(install.snippet).toContain('[mcp_servers.airemotecoder]');
    expect(install.snippet).toContain('bearer_token_env_var = "AIREMOTECODER_MCP_TOKEN"');
    expect(install.snippet).not.toContain('python - <<');
    expect(install.copyPaste?.bash?.length ?? 0).toBeGreaterThan(0);
    expect(install.copyPaste?.powershell?.length ?? 0).toBeGreaterThan(0);
    expect(install.token).toBe(setup.token);
    expect(install.copyPaste?.bash?.[0] ?? '').not.toContain('codex mcp add');
    expect(install.copyPaste?.bash?.[0] ?? '').toContain('python - <<\'PY\'');
    expect(install.copyPaste?.bash?.[1] ?? '').toContain('AIREMOTECODER_CODEX_MODE="interactive"');
    expect(install.copyPaste?.bash?.[1] ?? '').toContain('npx -y @ai-remote-coder/mcp-runner@latest');
    expect(install.copyPaste?.powershell?.[0] ?? '').toContain('mcp_servers.airemotecoder');
    expect(install.copyPaste?.powershell?.[0] ?? '').toContain('Set-Content -Path $configPath -Value $out -Encoding utf8');
    expect(install.copyPaste?.powershell?.[1] ?? '').toContain('$env:AIREMOTECODER_CODEX_MODE="interactive"');
    expect(install.copyPaste?.powershell?.[1] ?? '').toContain('npx -y @ai-remote-coder/mcp-runner@latest');
    expect(install.instructions).toContain('AIREMOTECODER_CODEX_MODE=exec');

    await app.close();
  });

  it('reuses latest unused setup token unless rotate is requested', async () => {
    const app = await buildApp();

    const first = await app.inject({ method: 'POST', url: '/api/mcp/setup/codex' });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { token: string; tokenReused: boolean };
    expect(firstBody.tokenReused).toBe(false);

    const second = await app.inject({ method: 'POST', url: '/api/mcp/setup/codex' });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { token: string; tokenReused: boolean };
    expect(secondBody.token).toBe(firstBody.token);
    expect(secondBody.tokenReused).toBe(true);

    const rotated = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/codex',
      payload: { generateNewToken: true },
    });
    expect(rotated.statusCode).toBe(200);
    const rotatedBody = rotated.json() as { token: string; tokenReused: boolean };
    expect(rotatedBody.token).not.toBe(firstBody.token);
    expect(rotatedBody.tokenReused).toBe(false);

    await app.close();
  });

  it('rotates automatically when latest setup token has been used', async () => {
    const app = await buildApp();

    const first = await app.inject({ method: 'POST', url: '/api/mcp/setup/codex' });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { token: string };

    const latestToken = tokens[tokens.length - 1] as any;
    latestToken.last_used_at = Math.floor(Date.now() / 1000);

    const second = await app.inject({ method: 'POST', url: '/api/mcp/setup/codex' });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { token: string; tokenReused: boolean };
    expect(secondBody.token).not.toBe(firstBody.token);
    expect(secondBody.tokenReused).toBe(false);

    await app.close();
  });

  it('adds persistent env-var commands when persistEnv is enabled', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/codex',
      payload: { persistEnv: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      copyPaste?: { bash?: string[]; powershell?: string[] };
    };
    expect(body.copyPaste?.bash?.[0] ?? '').toContain('Path.home() / ".profile"');
    expect(body.copyPaste?.powershell?.[0] ?? '').toContain('[Environment]::SetEnvironmentVariable("AIREMOTECODER_MCP_TOKEN"');
    await app.close();
  });

  it('returns copy/paste commands for json-backed providers', async () => {
    const app = await buildApp();

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude',
    });

    expect(setupRes.statusCode).toBe(200);
    const setup = setupRes.json() as {
      copyPaste?: { bash?: string[]; powershell?: string[] };
    };
    expect(setup.copyPaste?.bash?.length ?? 0).toBeGreaterThan(0);
    expect(setup.copyPaste?.powershell?.length ?? 0).toBeGreaterThan(0);

    await app.close();
  });

  it('rejects unsupported providers', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/discord',
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('reports configured providers from the project root', async () => {
    const app = await buildApp();
    const configuredPath = join(projectRoot, '.claude', 'mcp.json');
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(configuredPath, JSON.stringify({
      mcpServers: {
        airemotecoder: {
          url: 'http://localhost:3100/mcp',
        },
      },
    }, null, 2), 'utf-8');

    const res = await app.inject({
      method: 'GET',
      url: '/api/mcp/setup/status',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: Record<string, { configured: boolean; exists: boolean }> };
    expect(body.status.claude.configured).toBe(true);
    expect(body.status.claude.exists).toBe(true);

    await app.close();
  });

  it('supports Zenflow auto-install with its own config path', async () => {
    const app = await buildApp();

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/zenflow',
    });

    expect(setupRes.statusCode).toBe(200);
    const setup = setupRes.json() as { token: string };

    const installRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/zenflow/install',
      payload: { token: setup.token },
    });

    expect(installRes.statusCode).toBe(200);
    const install = installRes.json() as { installed: boolean; filePath: string };
    expect(install.installed).toBe(true);
    expect(install.filePath).toContain('.zenflow');

    await app.close();
  });

  it('supports installing to a custom projectPath inside allowed roots', async () => {
    const app = await buildApp();
    const otherProject = join(projectRoot, 'workspace-two');

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude',
      payload: { projectPath: otherProject },
    });

    expect(setupRes.statusCode).toBe(200);
    const setup = setupRes.json() as { token: string };

    const installRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude/install',
      payload: { token: setup.token, projectPath: otherProject },
    });

    expect(installRes.statusCode).toBe(200);
    const writtenPath = join(otherProject, '.claude', 'mcp.json');
    expect(existsSync(writtenPath)).toBe(true);

    await app.close();
  });

  it('rejects custom projectPath outside allowed roots', async () => {
    const app = await buildApp();

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude',
      payload: { projectPath: '/outside/root/project' },
    });

    expect(setupRes.statusCode).toBe(403);
    await app.close();
  });

  it('creates, lists, and deletes project targets', async () => {
    const app = await buildApp();
    const path = join(projectRoot, 'workspace-three');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/project-targets',
      payload: { label: 'Workspace Three', path, machineId: 'laptop-a' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json() as { id: string; path: string };
    expect(created.path.replace(/\\/g, '/')).toContain('/workspace-three');

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/mcp/project-targets',
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json() as { targets: Array<{ id: string }> };
    expect(list.targets.some((entry) => entry.id === created.id)).toBe(true);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/mcp/project-targets/${created.id}`,
    });
    expect(deleteRes.statusCode).toBe(200);

    const listAfter = await app.inject({
      method: 'GET',
      url: '/api/mcp/project-targets',
    });
    expect(listAfter.statusCode).toBe(200);
    const listAfterBody = listAfter.json() as { targets: Array<{ id: string }> };
    expect(listAfterBody.targets.some((entry) => entry.id === created.id)).toBe(false);

    await app.close();
  });

  it('enforces machine-bound targets using trusted session device identity', async () => {
    const app = await buildApp();
    const path = join(projectRoot, 'machine-bound');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/project-targets',
      payload: { label: 'Machine Bound', path },
    });
    expect(createRes.statusCode).toBe(201);
    const target = createRes.json() as { id: string };

    const setupWrongDevice = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude',
      headers: { cookie: 'session=session-user-2' },
      payload: { projectTargetId: target.id },
    });
    expect(setupWrongDevice.statusCode).toBe(403);

    const setupCorrectDevice = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude',
      payload: { projectTargetId: target.id },
    });
    expect(setupCorrectDevice.statusCode).toBe(200);

    await app.close();
  });

  it('isolates concurrent setup/install flows across users and targets', async () => {
    const app = await buildApp();
    const userOnePath = join(projectRoot, 'user-one-project');
    const userTwoPath = join(projectRoot, 'user-two-project');

    const createOne = await app.inject({
      method: 'POST',
      url: '/api/mcp/project-targets',
      headers: { cookie: 'session=session-user-1', 'x-airc-device-id': 'device-one' },
      payload: { label: 'User One Target', path: userOnePath },
    });
    expect(createOne.statusCode).toBe(201);
    const targetOne = createOne.json() as { id: string };

    const createTwo = await app.inject({
      method: 'POST',
      url: '/api/mcp/project-targets',
      headers: { cookie: 'session=session-user-2', 'x-airc-device-id': 'device-two' },
      payload: { label: 'User Two Target', path: userTwoPath },
    });
    expect(createTwo.statusCode).toBe(201);
    const targetTwo = createTwo.json() as { id: string };

    const setupOne = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude',
      headers: { cookie: 'session=session-user-1', 'x-airc-device-id': 'device-one' },
      payload: { projectTargetId: targetOne.id },
    });
    expect(setupOne.statusCode).toBe(200);
    const tokenOne = (setupOne.json() as { token: string }).token;

    const setupTwo = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude',
      headers: { cookie: 'session=session-user-2', 'x-airc-device-id': 'device-two' },
      payload: { projectTargetId: targetTwo.id },
    });
    expect(setupTwo.statusCode).toBe(200);
    const tokenTwo = (setupTwo.json() as { token: string }).token;

    const crossUserDenied = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude',
      headers: { cookie: 'session=session-user-2', 'x-airc-device-id': 'device-two' },
      payload: { projectTargetId: targetOne.id },
    });
    expect(crossUserDenied.statusCode).toBe(403);

    const installOne = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude/install',
      headers: { cookie: 'session=session-user-1', 'x-airc-device-id': 'device-one' },
      payload: { token: tokenOne, projectTargetId: targetOne.id },
    });
    expect(installOne.statusCode).toBe(200);

    const installTwo = await app.inject({
      method: 'POST',
      url: '/api/mcp/setup/claude/install',
      headers: { cookie: 'session=session-user-2', 'x-airc-device-id': 'device-two' },
      payload: { token: tokenTwo, projectTargetId: targetTwo.id },
    });
    expect(installTwo.statusCode).toBe(200);

    expect(existsSync(join(userOnePath, '.claude', 'mcp.json'))).toBe(true);
    expect(existsSync(join(userTwoPath, '.claude', 'mcp.json'))).toBe(true);

    await app.close();
  });
});
