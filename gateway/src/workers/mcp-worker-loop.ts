import { spawn } from 'child_process';
import { EventEmitter } from 'events';

type EventType = 'stdout' | 'stderr' | 'marker' | 'info' | 'error';

interface WorkerCommand {
  id: string;
  command: string;
  arguments?: string | null;
}

interface ClaimedRun {
  id: string;
  command: string | null;
  workerType: string;
}

interface ClaimResponse {
  run: ClaimedRun | null;
}

interface WorkerExecutor {
  sendInput(input: string, emit: (type: EventType, data: string) => Promise<void>): Promise<void>;
  interrupt(): Promise<void>;
  shutdown?(): Promise<void>;
}

class CodexExecExecutor implements WorkerExecutor {
  async sendInput(input: string, emit: (type: EventType, data: string) => Promise<void>): Promise<void> {
    await emit('info', `Executing Codex prompt (${input.length} chars)`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('codex', ['exec', input], {
        shell: process.platform === 'win32',
        windowsHide: true,
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        void emit('stdout', chunk.toString());
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        void emit('stderr', chunk.toString());
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`codex exec exited with code ${code}`));
      });
    });
  }

  async interrupt(): Promise<void> {
    // codex exec is one-shot in this worker mode; no persistent process to signal.
    return;
  }
}

type SpawnFn = typeof spawn;

export class PersistentCodexExecutor implements WorkerExecutor {
  private process: (EventEmitter & {
    stdin?: { write: (chunk: string) => void };
    stdout?: EventEmitter;
    stderr?: EventEmitter;
    kill?: (signal?: NodeJS.Signals) => void;
  }) | null = null;
  private emitFn: ((type: EventType, data: string) => Promise<void>) | null = null;

  constructor(private readonly spawnFn: SpawnFn = spawn) {}

  private ensureProcess(emit: (type: EventType, data: string) => Promise<void>): void {
    this.emitFn = emit;
    if (this.process) return;
    const child = this.spawnFn('codex', [], {
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as any;
    this.process = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.emitFn) {
        void this.emitFn('stdout', chunk.toString());
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.emitFn) {
        void this.emitFn('stderr', chunk.toString());
      }
    });
    child.on?.('close', (code: number | null, signal: string | null) => {
      if (this.emitFn) {
        void this.emitFn('info', `codex interactive process exited (code=${code} signal=${signal})`);
      }
      this.process = null;
    });
    child.on?.('error', (err: Error) => {
      if (this.emitFn) {
        void this.emitFn('error', `codex interactive process error: ${err.message}`);
      }
      this.process = null;
    });
  }

  async sendInput(input: string, emit: (type: EventType, data: string) => Promise<void>): Promise<void> {
    this.ensureProcess(emit);
    if (!this.process?.stdin) {
      throw new Error('Codex interactive stdin is unavailable');
    }
    this.process.stdin.write(`${input}\n`);
  }

  async interrupt(): Promise<void> {
    if (!this.process?.stdin) return;
    this.process.stdin.write('\u0003');
  }

  async shutdown(): Promise<void> {
    if (!this.process) return;
    if (this.process.kill) {
      this.process.kill('SIGINT');
    }
    this.process = null;
  }
}

class TemplateExecExecutor implements WorkerExecutor {
  constructor(private readonly template: string) {}

  async sendInput(input: string, emit: (type: EventType, data: string) => Promise<void>): Promise<void> {
    const { command, args } = buildExecInvocation(this.template, input);
    await emit('info', `Executing template command: ${command}`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        shell: process.platform === 'win32',
        windowsHide: true,
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        void emit('stdout', chunk.toString());
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        void emit('stderr', chunk.toString());
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`template command exited with code ${code}`));
      });
    });
  }

  async interrupt(): Promise<void> {
    return;
  }
}

export function buildExecInvocation(template: string, input: string): { command: string; args: string[] } {
  const trimmed = template.trim();
  if (!trimmed) {
    throw new Error('AIREMOTECODER_EXEC_TEMPLATE is required for this provider');
  }
  if (!trimmed.includes('{input}')) {
    throw new Error('AIREMOTECODER_EXEC_TEMPLATE must include {input} placeholder');
  }
  // Basic shellword split for command + static args. Input is injected as a single arg.
  const parts = trimmed.split(/\s+/g).filter(Boolean);
  const command = parts[0];
  const staticArgs = parts.slice(1).map((part) => (part === '{input}' ? input : part));
  if (!parts.slice(1).includes('{input}')) {
    staticArgs.push(input);
  }
  return { command, args: staticArgs };
}

class McpWorkerApi {
  constructor(
    private readonly gatewayUrl: string,
    private readonly token: string,
    private readonly provider: string
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.gatewayUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
    }
    return response.json();
  }

  claimRun(): Promise<ClaimResponse> {
    return this.request('POST', '/api/mcp/runs/claim', { provider: this.provider });
  }

  pollCommands(runId: string): Promise<WorkerCommand[]> {
    return this.request('GET', `/api/mcp/runs/${runId}/commands`);
  }

  ackCommand(runId: string, commandId: string, result?: string, error?: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/api/mcp/runs/${runId}/commands/${commandId}/ack`, {
      result: result ?? null,
      error: error ?? null,
    });
  }

  sendEvent(runId: string, event: { type: EventType; data: string; sequence?: number }): Promise<{ ok: boolean }> {
    return this.request('POST', `/api/mcp/runs/${runId}/events`, event);
  }
}

export async function handleWorkerCommand(
  command: WorkerCommand,
  runId: string,
  api: Pick<McpWorkerApi, 'ackCommand' | 'sendEvent'>,
  executor: WorkerExecutor
): Promise<boolean> {
  if (command.command === '__STOP__') {
    await api.sendEvent(runId, { type: 'marker', data: JSON.stringify({ event: 'finished', exitCode: 0 }) });
    await api.ackCommand(runId, command.id, 'stopped');
    return true;
  }

  if (command.command === '__ESCAPE__') {
    await executor.interrupt();
    await api.ackCommand(runId, command.id, 'interrupted');
    return false;
  }

  if (command.command === '__START_VNC_STREAM__') {
    await api.sendEvent(runId, { type: 'info', data: 'VNC stream start command delivered to MCP worker' });
    await api.ackCommand(runId, command.id, 'vnc-start-ack');
    return false;
  }

  const input = command.command === '__INPUT__'
    ? (command.arguments ?? '')
    : command.command;

  await executor.sendInput(input, async (type, data) => {
    await api.sendEvent(runId, { type, data });
  });
  await api.ackCommand(runId, command.id, 'ok');
  return false;
}

async function runLoop(): Promise<void> {
  const gatewayUrl = process.env.AIREMOTECODER_GATEWAY_URL ?? 'http://localhost:3100';
  const token = process.env.AIREMOTECODER_MCP_TOKEN ?? process.env.AIRC_MCP_TOKEN;
  const provider = (process.env.AIREMOTECODER_PROVIDER ?? 'codex').toLowerCase();
  if (!token) {
    throw new Error('Missing AIREMOTECODER_MCP_TOKEN (or AIRC_MCP_TOKEN)');
  }

  const api = new McpWorkerApi(gatewayUrl, token, provider);
  const codexMode = (process.env.AIREMOTECODER_CODEX_MODE ?? 'interactive').toLowerCase();
  const executor: WorkerExecutor = provider === 'codex'
    ? (codexMode === 'exec' ? new CodexExecExecutor() : new PersistentCodexExecutor())
    : new TemplateExecExecutor(process.env.AIREMOTECODER_EXEC_TEMPLATE ?? '');

  let sequence = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const claimed = await api.claimRun();
      if (!claimed.run) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }

      const runId = claimed.run.id;
      sequence += 1;
      await api.sendEvent(runId, {
        type: 'marker',
        data: JSON.stringify({ event: 'started', provider }),
        sequence,
      });

      if (claimed.run.command && claimed.run.command.trim()) {
        const bootstrapCommand: WorkerCommand = {
          id: `bootstrap-${Date.now()}`,
          command: '__INPUT__',
          arguments: claimed.run.command,
        };
        await handleWorkerCommand(bootstrapCommand, runId, api, executor);
      }

      let stopRun = false;
      while (!stopRun) {
        const commands = await api.pollCommands(runId);
        if (commands.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          continue;
        }
        for (const command of commands) {
          try {
            stopRun = await handleWorkerCommand(command, runId, api, executor);
          } catch (err: any) {
            await api.sendEvent(runId, { type: 'error', data: String(err?.message ?? err) });
            await api.ackCommand(runId, command.id, undefined, String(err?.message ?? err));
          }
        }
      }
      if (executor.shutdown) {
        await executor.shutdown();
      }
    } catch (err: any) {
      // transient gateway / runtime errors: backoff and continue
      // eslint-disable-next-line no-console
      console.error('[mcp-worker-loop] error', err?.message ?? err);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('mcp-worker-loop.ts')) {
  void runLoop();
}
