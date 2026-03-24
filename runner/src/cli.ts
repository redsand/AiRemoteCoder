#!/usr/bin/env node
import { runLoop, type RunnerOptions } from './worker.js';

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

  const gatewayUrl = args.get('gateway-url') ?? env.AIREMOTECODER_GATEWAY_URL ?? 'http://localhost:3100';
  const token = args.get('token') ?? env.AIREMOTECODER_MCP_TOKEN ?? env.AIRC_MCP_TOKEN ?? '';
  const provider = (args.get('provider') ?? env.AIREMOTECODER_PROVIDER ?? 'codex').toLowerCase();
  const codexModeRaw = (args.get('codex-mode') ?? env.AIREMOTECODER_CODEX_MODE ?? 'interactive').toLowerCase();
  const codexMode = codexModeRaw === 'exec' ? 'exec' : 'interactive';
  const execTemplate = args.get('exec-template') ?? env.AIREMOTECODER_EXEC_TEMPLATE;
  if (!token) {
    throw new Error('Missing MCP token. Set AIREMOTECODER_MCP_TOKEN (or pass --token).');
  }

  return {
    gatewayUrl,
    token,
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
