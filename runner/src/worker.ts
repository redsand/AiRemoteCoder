import { spawn } from 'child_process';
import { EventEmitter } from 'events';

export type EventType = 'stdout' | 'stderr' | 'marker' | 'info' | 'error';

export interface WorkerCommand {
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

export interface WorkerExecutor {
  sendInput(input: string, emit: (type: EventType, data: string) => Promise<void>): Promise<void>;
  interrupt(): Promise<void>;
  shutdown?(): Promise<void>;
}

type SpawnFn = typeof spawn;

function extractErrorMessage(errorPayload: unknown): string {
  if (!errorPayload || typeof errorPayload !== 'object') {
    return String(errorPayload ?? 'Unknown Codex app-server error');
  }

  const raw = (errorPayload as any).message;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof parsed.detail === 'string' && parsed.detail.trim().length > 0) {
        return parsed.detail;
      }
    } catch {
      return raw;
    }
    return raw;
  }

  const info = (errorPayload as any).codexErrorInfo;
  if (typeof info === 'string' && info.trim().length > 0) return info;
  return 'Unknown Codex app-server error';
}

export class CodexExecExecutor implements WorkerExecutor {
  constructor(private readonly spawnFn: SpawnFn = spawn) {}

  async sendInput(input: string, emit: (type: EventType, data: string) => Promise<void>): Promise<void> {
    await emit('info', `Executing Codex prompt (${input.length} chars)`);
    await new Promise<void>((resolve, reject) => {
      const child = this.spawnFn('codex', ['exec', input], {
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
    return;
  }
}

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
      if (this.emitFn) void this.emitFn('stdout', chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.emitFn) void this.emitFn('stderr', chunk.toString());
    });
    child.on?.('close', (code: number | null, signal: string | null) => {
      if (this.emitFn) void this.emitFn('info', `codex interactive process exited (code=${code} signal=${signal})`);
      this.process = null;
    });
    child.on?.('error', (err: Error) => {
      if (this.emitFn) void this.emitFn('error', `codex interactive process error: ${err.message}`);
      this.process = null;
    });
  }

  async sendInput(input: string, emit: (type: EventType, data: string) => Promise<void>): Promise<void> {
    this.ensureProcess(emit);
    if (!this.process?.stdin) throw new Error('Codex interactive stdin is unavailable');
    this.process.stdin.write(`${input}\n`);
  }

  async interrupt(): Promise<void> {
    if (!this.process?.stdin) return;
    this.process.stdin.write('\u0003');
  }

  async shutdown(): Promise<void> {
    if (!this.process) return;
    if (this.process.kill) this.process.kill('SIGINT');
    this.process = null;
  }
}

interface PendingResponse {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

interface PendingTurn {
  resolve: () => void;
  reject: (error: Error) => void;
}

type CompletedTurnState = { ok: true } | { ok: false; error: Error };

export class CodexAppServerExecutor implements WorkerExecutor {
  private process: (EventEmitter & {
    stdin?: { write: (chunk: string) => void };
    stdout?: EventEmitter;
    stderr?: EventEmitter;
    kill?: (signal?: NodeJS.Signals) => void;
  }) | null = null;
  private emitFn: ((type: EventType, data: string) => Promise<void>) | null = null;
  private stdoutBuffer = '';
  private nextRequestId = 1;
  private threadId: string | null = null;
  private readonly pendingResponses = new Map<number, PendingResponse>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly completedTurns = new Map<string, CompletedTurnState>();
  private startupPromise: Promise<void> | null = null;

  constructor(
    private readonly options: {
      spawnFn?: SpawnFn;
      cwd?: string;
      appServerCommand?: string[];
      model?: string;
      approvalPolicy?: string;
    } = {},
  ) {}

  private get spawnFn(): SpawnFn {
    return this.options.spawnFn ?? spawn;
  }

  private ensureProcess(emit: (type: EventType, data: string) => Promise<void>): void {
    this.emitFn = emit;
    if (this.process) return;

    const argv = this.options.appServerCommand ?? ['codex', 'app-server'];
    const command = argv[0];
    const args = argv.slice(1);
    const child = this.spawnFn(command, args, {
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as any;
    this.process = child;
    this.stdoutBuffer = '';

    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.handleStdoutChunk(chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (this.emitFn) void this.emitFn('stderr', chunk.toString());
    });
    child.on?.('close', (code: number | null, signal: string | null) => {
      const error = new Error(`codex app-server exited (code=${code} signal=${signal})`);
      this.failAllPending(error);
      if (this.emitFn) void this.emitFn('info', error.message);
      this.resetProcessState();
    });
    child.on?.('error', (err: Error) => {
      this.failAllPending(err);
      if (this.emitFn) void this.emitFn('error', `codex app-server error: ${err.message}`);
      this.resetProcessState();
    });
  }

  private resetProcessState(): void {
    this.process = null;
    this.threadId = null;
    this.startupPromise = null;
    this.stdoutBuffer = '';
  }

  private failAllPending(err: Error): void {
    for (const pending of this.pendingResponses.values()) pending.reject(err);
    for (const pending of this.pendingTurns.values()) pending.reject(err);
    this.pendingResponses.clear();
    this.pendingTurns.clear();
    this.completedTurns.clear();
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        if (this.emitFn) void this.emitFn('stderr', line);
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: any): void {
    if (typeof message?.id === 'number') {
      const pending = this.pendingResponses.get(message.id);
      if (!pending) return;
      this.pendingResponses.delete(message.id);
      if (message.error) pending.reject(new Error(extractErrorMessage(message.error)));
      else pending.resolve(message.result ?? {});
      return;
    }

    const method = message?.method;
    const params = message?.params;
    if (typeof method !== 'string' || !params || typeof params !== 'object') return;

    if (method === 'item/agentMessage/delta') {
      const delta = params.delta;
      if (typeof delta === 'string' && this.emitFn) void this.emitFn('stdout', delta);
      return;
    }

    if (method === 'turn/completed') {
      const turn = params.turn;
      const turnId = typeof turn?.id === 'string' ? turn.id : null;
      if (!turnId) return;
      const pending = this.pendingTurns.get(turnId);
      const result = turn?.status === 'failed'
        ? { ok: false as const, error: new Error(extractErrorMessage(turn.error)) }
        : { ok: true as const };
      if (!pending) {
        this.completedTurns.set(turnId, result);
        return;
      }
      this.pendingTurns.delete(turnId);
      if (result.ok) pending.resolve();
      else pending.reject(result.error);
      return;
    }

    if (method === 'error') {
      const turnId = typeof params.turnId === 'string' ? params.turnId : null;
      if (!turnId) return;
      const pending = this.pendingTurns.get(turnId);
      if (params.willRetry === false) {
        const errorState = { ok: false as const, error: new Error(extractErrorMessage(params.error)) };
        if (!pending) {
          this.completedTurns.set(turnId, errorState);
          return;
        }
        this.pendingTurns.delete(turnId);
        pending.reject(errorState.error);
      }
      return;
    }

    if (this.emitFn) void this.emitFn('info', JSON.stringify(message));
  }

  private send(message: Record<string, unknown>): void {
    if (!this.process?.stdin) throw new Error('Codex app-server stdin is unavailable');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const response = await new Promise<any>((resolve, reject) => {
      this.pendingResponses.set(id, { resolve, reject });
      try {
        this.send({ id, method, params });
      } catch (err) {
        this.pendingResponses.delete(id);
        reject(err);
      }
    });
    return response;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private async ensureSession(emit: (type: EventType, data: string) => Promise<void>): Promise<void> {
    this.ensureProcess(emit);
    if (this.threadId) return;
    if (!this.startupPromise) {
      this.startupPromise = (async () => {
        await this.request('initialize', {
          clientInfo: {
            name: 'airc-mcp-runner',
            version: '0.1.0',
          },
        });
        this.notify('initialized', {});
        const startResult = await this.request('thread/start', {
          cwd: this.options.cwd ?? process.cwd(),
          ...(this.options.model ? { model: this.options.model } : {}),
          approvalPolicy: this.options.approvalPolicy ?? 'never',
        });
        const threadId = startResult?.thread?.id;
        if (typeof threadId !== 'string' || threadId.trim().length === 0) {
          throw new Error(`thread/start did not return thread id: ${JSON.stringify(startResult)}`);
        }
        this.threadId = threadId;
      })();
    }
    await this.startupPromise;
  }

  async sendInput(input: string, emit: (type: EventType, data: string) => Promise<void>): Promise<void> {
    await this.ensureSession(emit);
    if (!this.threadId) throw new Error('Codex app-server thread is unavailable');

    const turnResult = await this.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: input }],
      ...(this.options.model ? { model: this.options.model } : {}),
    });

    const turnId = turnResult?.turn?.id;
    if (typeof turnId !== 'string' || turnId.trim().length === 0) {
      throw new Error(`turn/start did not return turn id: ${JSON.stringify(turnResult)}`);
    }

    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      if (completed.ok) return;
      throw completed.error;
    }

    await new Promise<void>((resolve, reject) => {
      this.pendingTurns.set(turnId, { resolve, reject });
    });
  }

  async interrupt(): Promise<void> {
    if (!this.process?.kill) return;
    this.process.kill('SIGINT');
  }

  async shutdown(): Promise<void> {
    if (!this.process?.kill) return;
    this.process.kill('SIGINT');
    this.resetProcessState();
  }
}

export class TemplateExecExecutor implements WorkerExecutor {
  constructor(private readonly template: string, private readonly spawnFn: SpawnFn = spawn) {}

  async sendInput(input: string, emit: (type: EventType, data: string) => Promise<void>): Promise<void> {
    const { command, args } = buildExecInvocation(this.template, input);
    await emit('info', `Executing template command: ${command}`);
    await new Promise<void>((resolve, reject) => {
      const child = this.spawnFn(command, args, {
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
  if (!trimmed) throw new Error('AIREMOTECODER_EXEC_TEMPLATE is required for this provider');
  if (!trimmed.includes('{input}')) throw new Error('AIREMOTECODER_EXEC_TEMPLATE must include {input} placeholder');
  const parts = trimmed.split(/\s+/g).filter(Boolean);
  const command = parts[0];
  const staticArgs = parts.slice(1).map((part) => (part === '{input}' ? input : part));
  if (!parts.slice(1).includes('{input}')) staticArgs.push(input);
  return { command, args: staticArgs };
}

export class McpWorkerApi {
  constructor(
    private readonly gatewayUrl: string,
    private readonly token: string,
    private readonly provider: string,
    private readonly runnerId: string,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.gatewayUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        'x-airc-runner-id': this.runnerId,
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
  executor: WorkerExecutor,
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

  const input = command.command === '__INPUT__' ? (command.arguments ?? '') : command.command;
  await executor.sendInput(input, async (type, data) => {
    await api.sendEvent(runId, { type, data });
  });
  await api.ackCommand(runId, command.id, 'ok');
  return false;
}

export interface RunnerOptions {
  gatewayUrl: string;
  token: string;
  runnerId: string;
  provider: string;
  codexMode: 'app-server' | 'interactive' | 'exec';
  codexApprovalPolicy: string;
  execTemplate?: string;
  pollIdleMs?: number;
  pollCommandsMs?: number;
  errorBackoffMs?: number;
}

export function isExpectedIdleClaimError(err: unknown): boolean {
  const message = String((err as any)?.message ?? err ?? '');
  return message.includes('POST /api/mcp/runs/claim failed (404):')
    && message.includes('No active MCP session found for this token');
}

function createExecutor(options: RunnerOptions): WorkerExecutor {
  if (options.provider === 'codex') {
    if (options.codexMode === 'exec') return new CodexExecExecutor();
    if (options.codexMode === 'interactive') return new PersistentCodexExecutor();
    return new CodexAppServerExecutor({ approvalPolicy: options.codexApprovalPolicy || 'never' });
  }
  return new TemplateExecExecutor(options.execTemplate ?? '');
}

export async function runLoop(options: RunnerOptions): Promise<void> {
  const api = new McpWorkerApi(options.gatewayUrl, options.token, options.provider, options.runnerId);
  const executor = createExecutor(options);
  const pollIdleMs = options.pollIdleMs ?? 1500;
  const pollCommandsMs = options.pollCommandsMs ?? 750;
  const errorBackoffMs = options.errorBackoffMs ?? 3000;
  let sequence = 0;
  let lastIdleClaimLogAt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const claimed = await api.claimRun();
      if (!claimed.run) {
        await new Promise((resolve) => setTimeout(resolve, pollIdleMs));
        continue;
      }

      const runId = claimed.run.id;
      sequence += 1;
      await api.sendEvent(runId, {
        type: 'marker',
        data: JSON.stringify({ event: 'started', provider: options.provider }),
        sequence,
      });

      if (claimed.run.command && claimed.run.command.trim()) {
        await handleWorkerCommand(
          { id: `bootstrap-${Date.now()}`, command: '__INPUT__', arguments: claimed.run.command },
          runId,
          api,
          executor,
        );
      }

      let stopRun = false;
      while (!stopRun) {
        const commands = await api.pollCommands(runId);
        if (commands.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, pollCommandsMs));
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
      if (executor.shutdown) await executor.shutdown();
    } catch (err: any) {
      if (isExpectedIdleClaimError(err)) {
        const now = Date.now();
        if (now - lastIdleClaimLogAt > 30000) {
          // eslint-disable-next-line no-console
          console.info('[airc-mcp-runner] waiting for MCP session registration');
          lastIdleClaimLogAt = now;
        }
      } else {
        // eslint-disable-next-line no-console
        console.error('[airc-mcp-runner] error', err?.message ?? err);
      }
      await new Promise((resolve) => setTimeout(resolve, errorBackoffMs));
    }
  }
}

export async function runLoopOnce(
  options: RunnerOptions,
  deps: {
    api?: Pick<McpWorkerApi, 'claimRun' | 'pollCommands' | 'ackCommand' | 'sendEvent'>;
    executor?: WorkerExecutor;
  } = {},
): Promise<{ claimedRunId: string | null; stopRun: boolean }> {
  const api = deps.api ?? new McpWorkerApi(options.gatewayUrl, options.token, options.provider, options.runnerId);
  const executor = deps.executor ?? createExecutor(options);

  const claimed = await api.claimRun();
  if (!claimed.run) {
    return { claimedRunId: null, stopRun: false };
  }

  const runId = claimed.run.id;
  await api.sendEvent(runId, {
    type: 'marker',
    data: JSON.stringify({ event: 'started', provider: options.provider }),
    sequence: 1,
  });

  if (claimed.run.command && claimed.run.command.trim()) {
    await handleWorkerCommand(
      { id: 'bootstrap-1', command: '__INPUT__', arguments: claimed.run.command },
      runId,
      api,
      executor,
    );
  }

  const commands = await api.pollCommands(runId);
  let stopRun = false;
  for (const command of commands) {
    try {
      stopRun = await handleWorkerCommand(command, runId, api, executor);
      if (stopRun) break;
    } catch (err: any) {
      await api.sendEvent(runId, { type: 'error', data: String(err?.message ?? err) });
      await api.ackCommand(runId, command.id, undefined, String(err?.message ?? err));
    }
  }

  if (stopRun && executor.shutdown) {
    await executor.shutdown();
  }

  return { claimedRunId: runId, stopRun };
}
