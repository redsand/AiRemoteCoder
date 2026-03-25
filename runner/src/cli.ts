#!/usr/bin/env node
import { createHash } from 'crypto';
import { hostname } from 'os';
import { runLoop, type RunnerOptions } from './worker.js';

function normalizeGatewayUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/mcp$/i, '');
}

export function parseRunnerOptions(argv: string[], env: NodeJS.ProcessEnv): RunnerOptions {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      args.set(key, 'true');
      continue;
    }
    args.set(key, value);
    i += 1;
  }

  const gatewayUrlRaw = args.get('gateway-url') ?? env.AIREMOTECODER_GATEWAY_URL ?? 'http://localhost:3100';
  const gatewayUrl = normalizeGatewayUrl(gatewayUrlRaw);
  const token = args.get('token') ?? env.AIREMOTECODER_MCP_TOKEN ?? env.AIRC_MCP_TOKEN ?? '';
  const provider = (args.get('provider') ?? env.AIREMOTECODER_PROVIDER ?? 'codex').toLowerCase();
  const explicitRunnerId = args.get('runner-id') ?? env.AIREMOTECODER_RUNNER_ID;
  const runnerSeed = explicitRunnerId?.trim() || `${hostname()}:${process.cwd()}`;
  const runnerId = createHash('sha256').update(runnerSeed).digest('hex').slice(0, 16);
  const codexModeRaw = (args.get('codex-mode') ?? env.AIREMOTECODER_CODEX_MODE ?? 'interactive').toLowerCase();
  const codexMode = codexModeRaw === 'exec' ? 'exec' : 'interactive';
  const execTemplate = args.get('exec-template') ?? env.AIREMOTECODER_EXEC_TEMPLATE;
  if (!token) {
    throw new Error('Missing MCP token. Set AIREMOTECODER_MCP_TOKEN (or pass --token).');
  }

  return {
    gatewayUrl,
    token,
    runnerId,
    provider,
    codexMode,
    execTemplate,
  };
}

async function main(): Promise<void> {
  const options = parseRunnerOptions(process.argv.slice(2), process.env);
  await runLoop(options);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  void main();
}
