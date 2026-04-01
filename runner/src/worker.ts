import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

export type EventType = 'stdout' | 'stderr' | 'marker' | 'info' | 'error' | 'tool_use';

export interface WorkerCommand {
  id: string;
  command: string;
  arguments?: string | null;
}

interface ClaimedRun {
  id: string;
  command: string | null;
  workerType: string;
  metadata?: Record<string, unknown> | null;
  resumeState?: Record<string, unknown> | null;
}

interface ClaimResponse {
  run: ClaimedRun | null;
}

interface WorkerArtifactUpload {
  name: string;
  type: 'log' | 'text' | 'json' | 'diff' | 'patch' | 'markdown' | 'file';
  content: string;
}

function summarizeCommand(command: WorkerCommand): string {
  if (command.command === '__INPUT__') {
    const text = (command.arguments ?? '').trim().replace(/\s+/g, ' ');
    return `prompt ${command.id}: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`;
  }
  if (command.command === '__EXEC__') {
    const text = (command.arguments ?? '').trim().replace(/\s+/g, ' ');
    return `command ${command.id}: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`;
  }
  return `${command.command} ${command.id}`;
}

// Module-level sink set while a run is active — forwards logs as gateway events
let _runnerLogSink: ((level: 'info' | 'error', msg: string) => void) | null = null;

function setRunnerLogSink(fn: ((level: 'info' | 'error', msg: string) => void) | null): void {
  _runnerLogSink = fn;
}

function logRunnerInfo(message: string): void {
  // eslint-disable-next-line no-console
  console.info(`[airc-mcp-runner] ${message}`);
  _runnerLogSink?.('info', message);
}

function logRunnerError(message: string): void {
  // eslint-disable-next-line no-console
  console.error(`[airc-mcp-runner] ${message}`);
  _runnerLogSink?.('error', message);
}

function logStreamEvent(type: EventType, data: string): void {
  const trimmed = data.trim();
  if (!trimmed) return;
  if (type === 'error') {
    logRunnerError(trimmed);
    return;
  }
  if (type === 'tool_use') {
    try {
      const payload = JSON.parse(trimmed);
      const action = payload?.phase === 'pre' ? 'Tool call started' : 'Tool call finished';
      const suffix = typeof payload?.tool === 'string' && payload.tool.trim().length > 0 ? `: ${payload.tool.trim()}` : '';
      logRunnerInfo(`${action}${suffix}`);
      return;
    } catch {
      logRunnerInfo(trimmed);
      return;
    }
  }
  if (type === 'info' || type === 'marker' || type === 'stderr') {
    logRunnerInfo(trimmed);
  }
}

function summarizeClaudeToolInput(input: unknown): string {
  if (typeof input === 'string') return input.trim();
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  const value = record.command ?? record.cmd ?? record.path ?? record.file_path ?? record.pattern ?? record.query;
  return typeof value === 'string' ? value.trim() : '';
}

function summarizeClaudeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const textParts = content
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (!item || typeof item !== 'object') return '';
        const record = item as Record<string, unknown>;
        const value = record.text ?? record.content ?? record.message ?? record.output;
        return typeof value === 'string' ? value.trim() : '';
      })
      .filter(Boolean);
    return textParts.join(' ').trim();
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    const value = record.text ?? record.content ?? record.message ?? record.output;
    return typeof value === 'string' ? value.trim() : '';
  }
  return '';
}

export interface WorkerExecutor {
  sendInput(input: string, emit: (type: EventType, data: string) => Promise<void>): Promise<void>;
  interrupt(): Promise<void>;
  restoreState?(state: Record<string, unknown> | null): void;
  snapshotState?(): Record<string, unknown> | null;
  shutdown?(): Promise<void>;
}

function summarizeGeminiToolInput(parameters: unknown): string {
  if (!parameters || typeof parameters !== 'object') return '';
  const record = parameters as Record<string, unknown>;
  const value = record.cmd ?? record.command ?? record.path ?? record.file_path ?? record.pattern ?? record.query;
  return typeof value === 'string' ? value.trim() : '';
}

function extractGeminiErrorMessage(event: any): string {
  const nested = event?.error;
  if (typeof nested?.message === 'string' && nested.message.trim().length > 0) {
    return nested.message.trim();
  }
  if (typeof event?.message === 'string' && event.message.trim().length > 0) {
    return event.message.trim();
  }
  if (typeof event?.result === 'string' && event.result.trim().length > 0) {
    return event.result.trim();
  }
  if (typeof event?.response === 'string' && event.response.trim().length > 0) {
    return event.response.trim();
  }
  return 'Gemini CLI reported an error';
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

interface ClaudeResultState {
  ok: boolean;
  error?: Error;
}

function stripClaudeToolUseErrorMarkup(text: string): string {
  return text.replace(/<\/?tool_use_error>/gi, '').trim();
}

function extractClaudeErrorMessage(event: any, lastToolError: string | null): string {
  const directError = typeof event?.error === 'string' ? event.error.trim() : '';
  if (directError) return directError;

  const resultText = typeof event?.result === 'string' ? stripClaudeToolUseErrorMarkup(event.result) : '';
  if (resultText) return resultText;

  if (lastToolError && lastToolError.trim().length > 0) return lastToolError.trim();

  const returnCode = event?.returncode;
  if (typeof returnCode === 'number') return `Claude CLI exited with code ${returnCode}`;
  return 'Claude CLI reported an error';
}

export class ClaudeCliExecutor implements WorkerExecutor {
  private cliSessionId: string | null = null;
  private readonly toolNames = new Map<string, string>();
  private lastToolError: string | null = null;

  constructor(
    private readonly options: {
      spawnFn?: SpawnFn;
      cwd?: string;
      command?: string;
      permissionMode?: string;
      model?: string;
      platform?: NodeJS.Platform;
    } = {},
  ) {}

  private get spawnFn(): SpawnFn {
    return this.options.spawnFn ?? spawn;
  }

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  private buildArgs(): string[] {
    const args = [
      '-p',
      '--print',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode',
      this.options.permissionMode ?? 'bypassPermissions',
    ];
    if (this.options.model) {
      args.push('--model', this.options.model);
    }
    if (this.cliSessionId) {
      args.push('--resume', this.cliSessionId);
    } else {
      args.push('--session-id', randomUUID());
    }
    return args;
  }

  private parseStreamJsonLine(
    line: string,
    emit: (type: EventType, data: string) => Promise<void>,
    result: ClaudeResultState,
  ): void {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      if (line.trim().length > 0) void emit('stderr', line);
      return;
    }

    if (typeof event?.session_id === 'string' && event.session_id.trim().length > 0) {
      this.cliSessionId = event.session_id;
    }

    if (event?.type === 'assistant') {
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
          void emit('stdout', part.text);
          continue;
        }
        if (part?.type === 'thinking' && typeof part.text === 'string' && part.text.trim().length > 0) {
          void emit('info', `Claude reasoning: ${part.text.trim()}`);
          continue;
        }
        if (part?.type === 'tool_use') {
          const toolName = typeof part.name === 'string' && part.name.trim().length > 0 ? part.name.trim() : 'tool';
          const details = summarizeClaudeToolInput(part.input);
          const toolLabel = `${toolName}${details ? ` ${details}` : ''}`.trim();
          if (typeof part.id === 'string' && part.id.trim().length > 0) {
            this.toolNames.set(part.id, toolLabel);
          }
          void emit('tool_use', JSON.stringify({
            phase: 'pre',
            tool: toolLabel,
            provider: 'claude',
            toolId: typeof part.id === 'string' ? part.id : null,
          }));
        }
      }
      return;
    }

    if (event?.type === 'user') {
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const part of content) {
        if (part?.type === 'tool_result') {
          const details = summarizeClaudeToolResultContent(part.content);
          const normalizedDetails = stripClaudeToolUseErrorMarkup(details);
          const toolId = typeof part.tool_use_id === 'string' ? part.tool_use_id : '';
          const toolLabel = (toolId && this.toolNames.get(toolId)) || 'Tool';
          const isToolError = /<tool_use_error>/i.test(String(part.content ?? '')) || /\btool_use_error\b/i.test(details);
          if (isToolError && normalizedDetails) {
            this.lastToolError = normalizedDetails;
          }
          void emit('tool_use', JSON.stringify({
            phase: 'post',
            tool: toolLabel,
            provider: 'claude',
            toolId: toolId || null,
            summary: normalizedDetails || 'completed',
          }));
        }
      }
      return;
    }

    if (event?.type === 'result') {
      if (event.is_error || event.subtype === 'error') {
        result.ok = false;
        result.error = new Error(extractClaudeErrorMessage(event, this.lastToolError));
        return;
      }
      if (typeof event.result === 'string' && event.result.trim().length > 0) {
        void emit('info', `Claude result: ${event.result.trim()}`);
      }
      return;
    }

    if (event?.type === 'system') {
      if (event.subtype === 'status' && typeof event.status === 'string' && event.status.trim().length > 0) {
        void emit('info', `Claude status: ${event.status.trim()}`);
      }
      return;
    }
  }

  restoreState(state: Record<string, unknown> | null): void {
    const sessionId = state?.cliSessionId;
    if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
      this.cliSessionId = sessionId.trim();
    }
  }

  snapshotState(): Record<string, unknown> | null {
    return this.cliSessionId ? { cliSessionId: this.cliSessionId } : null;
  }

  async sendInput(input: string, emit: (type: EventType, data: string) => Promise<void>): Promise<void> {
    this.lastToolError = null;
    const localEmit = async (type: EventType, data: string) => {
      logStreamEvent(type, data);
      await emit(type, data);
    };
    const args = this.buildArgs();
    const command = this.options.command ?? 'claude';
    const sessionFlag = this.cliSessionId ? `resume=${this.cliSessionId}` : 'session=new';

    await localEmit('info', `Executing Claude prompt (${input.length} chars)`);
    logRunnerInfo(`launching Claude (${sessionFlag}, permissionMode=${this.options.permissionMode ?? 'bypassPermissions'})`);

    await new Promise<void>((resolve, reject) => {
      const child = this.spawnFn(command, [...args, '--', input], {
        shell: false,
        windowsHide: true,
        cwd: this.options.cwd ?? process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const result: ClaudeResultState = { ok: true };
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let sawOutput = false;
      let lastActivityAt = Date.now();
      const inactivityTimer = setInterval(() => {
        const idleMs = Date.now() - lastActivityAt;
        if (idleMs >= 10000) {
          logRunnerInfo(`Claude turn still waiting after ${Math.floor(idleMs / 1000)}s with no output`);
          lastActivityAt = Date.now();
        }
      }, 5000);
      const clearWatchdog = () => clearInterval(inactivityTimer);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        sawOutput = true;
        lastActivityAt = Date.now();
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          this.parseStreamJsonLine(line, localEmit, result);
        }
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        sawOutput = true;
        lastActivityAt = Date.now();
        stderrBuffer += text;
        logRunnerInfo(`Claude stderr: ${text.trim()}`);
        void localEmit('stderr', text);
      });

      child.on('error', (err) => {
        clearWatchdog();
        reject(err);
      });
      child.on('close', (code) => {
        clearWatchdog();
        if (stdoutBuffer.trim().length > 0) {
          this.parseStreamJsonLine(stdoutBuffer.trim(), localEmit, result);
          stdoutBuffer = '';
        }
        if (!sawOutput) {
          logRunnerInfo('Claude exited without any stdout/stderr output');
        }
        if (result.ok && code === 0) {
          logRunnerInfo('Claude turn completed successfully');
          resolve();
          return;
        }
        if (result.error) {
          logRunnerError(`Claude turn failed: ${result.error.message}`);
          reject(result.error);
          return;
        }
        const stderrText = stderrBuffer.trim();
        logRunnerError(`Claude exited with code ${code}${stderrText ? `: ${stderrText}` : ''}`);
        reject(new Error(stderrText || `claude exited with code ${code}`));
      });

      child.stdin?.end();
    });
  }

  async interrupt(): Promise<void> {
    return;
  }
}

export class GeminiCliExecutor implements WorkerExecutor {
  private cliSessionId: string | null = null;
  private readonly toolNames = new Map<string, string>();

  constructor(
    private readonly options: {
      spawnFn?: SpawnFn;
      cwd?: string;
      command?: string;
      approvalMode?: string;
      model?: string;
    } = {},
  ) {}

  private get spawnFn(): SpawnFn {
    return this.options.spawnFn ?? spawn;
  }

  private buildArgs(): string[] {
    const args = [
      '--output-format',
      'stream-json',
      '--include-directories',
      '.',
      '--approval-mode',
      this.options.approvalMode ?? 'yolo',
    ];
    if (this.options.model) {
      args.push('--model', this.options.model);
    }
    if (this.cliSessionId) {
      args.push('--resume', this.cliSessionId);
    }
    return args;
  }

  private parseStreamJsonLine(
    line: string,
    emit: (type: EventType, data: string) => Promise<void>,
    result: { ok: boolean; error?: Error },
  ): void {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      if (line.trim().length > 0) void emit('stderr', line);
      return;
    }

    if (typeof event?.session_id === 'string' && event.session_id.trim().length > 0) {
      this.cliSessionId = event.session_id.trim();
    }

    if (event?.type === 'init') {
      void emit('info', 'Gemini session initialized');
      return;
    }

    if (event?.type === 'message') {
      const role = typeof event.role === 'string' ? event.role.toLowerCase() : '';
      if (role === 'assistant' || role === 'model') {
        if (typeof event.content === 'string' && event.content.trim().length > 0) {
          void emit('stdout', event.content);
          return;
        }
        if (Array.isArray(event.content)) {
          for (const part of event.content) {
            if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0) {
              void emit('stdout', part.text);
              continue;
            }
            if (part?.type === 'tool_use') {
              const toolName = typeof part.name === 'string' ? part.name.trim() : 'tool';
              const detail = summarizeGeminiToolInput(part.input);
              const toolLabel = `${toolName}${detail ? ` ${detail}` : ''}`.trim();
              if (typeof part.id === 'string' && part.id.trim().length > 0) {
                this.toolNames.set(part.id, toolLabel);
              }
              void emit('tool_use', JSON.stringify({
                phase: 'pre',
                tool: toolLabel,
                provider: 'gemini',
                toolId: typeof part.id === 'string' ? part.id : null,
              }));
            }
          }
        }
      }
      return;
    }

    if (event?.type === 'tool_use') {
      const toolName = typeof event.tool_name === 'string' ? event.tool_name.trim() : 'tool';
      const detail = summarizeGeminiToolInput(event.parameters);
      const toolLabel = `${toolName}${detail ? ` ${detail}` : ''}`.trim();
      if (typeof event.tool_id === 'string' && event.tool_id.trim().length > 0) {
        this.toolNames.set(event.tool_id, toolLabel);
      }
      void emit('tool_use', JSON.stringify({
        phase: 'pre',
        tool: toolLabel,
        provider: 'gemini',
        toolId: typeof event.tool_id === 'string' ? event.tool_id : null,
      }));
      return;
    }

    if (event?.type === 'tool_result') {
      const toolId = typeof event.tool_id === 'string' ? event.tool_id : '';
      const toolLabel = (toolId && this.toolNames.get(toolId)) || 'Tool';
      const summary = typeof event.output === 'string' && event.output.trim().length > 0
        ? event.output.trim()
        : typeof event.status === 'string' && event.status.trim().length > 0
          ? event.status.trim()
          : 'completed';
      void emit('tool_use', JSON.stringify({
        phase: 'post',
        tool: toolLabel,
        provider: 'gemini',
        toolId: toolId || null,
        summary,
      }));
      return;
    }

    if (event?.type === 'error') {
      result.ok = false;
      result.error = new Error(extractGeminiErrorMessage(event));
      return;
    }

    if (event?.type === 'result') {
      const status = typeof event.status === 'string' ? event.status.toLowerCase() : '';
      if (status === 'error' || event.is_error) {
        result.ok = false;
        result.error = new Error(extractGeminiErrorMessage(event));
        return;
      }
      const output = typeof event.result === 'string' ? event.result.trim()
        : typeof event.response === 'string' ? event.response.trim()
          : '';
      if (output) {
        void emit('info', `Gemini result: ${output}`);
      }
    }
  }

  restoreState(state: Record<string, unknown> | null): void {
    const sessionId = state?.cliSessionId;
    if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
      this.cliSessionId = sessionId.trim();
    }
  }

  snapshotState(): Record<string, unknown> | null {
    return this.cliSessionId ? { cliSessionId: this.cliSessionId } : null;
  }

  async sendInput(input: string, emit: (type: EventType, data: string) => Promise<void>): Promise<void> {
    const localEmit = async (type: EventType, data: string) => {
      logStreamEvent(type, data);
      await emit(type, data);
    };
    const args = this.buildArgs();
    const command = this.options.command ?? 'gemini';
    const sessionFlag = this.cliSessionId ? `resume=${this.cliSessionId}` : 'session=new';

    await localEmit('info', `Executing Gemini prompt (${input.length} chars)`);
    logRunnerInfo(`launching Gemini (${sessionFlag}, approvalMode=${this.options.approvalMode ?? 'yolo'})`);

    await new Promise<void>((resolve, reject) => {
      const child = this.spawnFn(command, args, {
        shell: false,
        windowsHide: true,
        cwd: this.options.cwd ?? process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const result: { ok: boolean; error?: Error } = { ok: true };
      let stdoutBuffer = '';
      let stderrBuffer = '';

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          this.parseStreamJsonLine(line, localEmit, result);
        }
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        stderrBuffer += text;
        void localEmit('stderr', text);
      });

      child.on('error', reject);
      child.on('close', (code) => {
        if (stdoutBuffer.trim().length > 0) {
          this.parseStreamJsonLine(stdoutBuffer.trim(), localEmit, result);
          stdoutBuffer = '';
        }
        if (result.ok && code === 0) {
          logRunnerInfo('Gemini turn completed successfully');
          resolve();
          return;
        }
        if (result.error) {
          logRunnerError(`Gemini turn failed: ${result.error.message}`);
          reject(result.error);
          return;
        }
        const stderrText = stderrBuffer.trim();
        logRunnerError(`Gemini exited with code ${code}${stderrText ? `: ${stderrText}` : ''}`);
        reject(new Error(stderrText || `gemini exited with code ${code}`));
      });

      child.stdin?.end(input);
    });
  }

  async interrupt(): Promise<void> {
    return;
  }
}

export async function executeShellCommand(
  command: string,
  emit: (type: EventType, data: string) => Promise<void>,
  spawnFn: SpawnFn = spawn,
): Promise<void> {
  await emit('info', `Executing local command: ${command}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawnFn(command, [], {
      shell: true,
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
      else reject(new Error(`local command exited with code ${code}`));
    });
  });
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
        'x-airc-project-dir': process.cwd(),
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

  uploadArtifact(runId: string, artifact: WorkerArtifactUpload): Promise<{ ok: boolean; artifactId: string }> {
    return this.request('POST', `/api/mcp/runs/${runId}/artifacts`, artifact);
  }

  saveResumeState(runId: string, resumeState: Record<string, unknown> | null): Promise<{ ok: boolean }> {
    return this.request('POST', `/api/mcp/runs/${runId}/state`, { resumeState });
  }
}

async function runCommandCapture(
  spawnFn: SpawnFn,
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function collectGitChangeReport(
  spawnFn: SpawnFn = spawn,
): Promise<{ files: string[]; diff: string } | null> {
  const diffResult = await runCommandCapture(
    spawnFn,
    'git',
    ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'],
  );
  if (diffResult.code !== 0) return null;
  const diff = diffResult.stdout.trim();
  if (!diff) return null;

  const namesResult = await runCommandCapture(
    spawnFn,
    'git',
    ['diff', '--name-only', 'HEAD', '--'],
  );
  const files = namesResult.code === 0
    ? namesResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];

  return { files, diff };
}

async function emitSynthesizedChangeReport(
  runId: string,
  provider: string,
  api: Pick<McpWorkerApi, 'sendEvent'> & Partial<Pick<McpWorkerApi, 'uploadArtifact'>>,
  spawnFn: SpawnFn = spawn,
): Promise<void> {
  if (provider === 'codex') return;
  const report = await collectGitChangeReport(spawnFn);
  if (!report || report.files.length === 0) return;

  await api.sendEvent(runId, {
    type: 'info',
    data: JSON.stringify({
      method: 'item/completed',
      params: {
        item: {
          type: 'fileChange',
          changes: report.files.map((path) => ({
            path,
            kind: { type: 'update', move_path: null },
          })),
          status: 'completed',
        },
      },
    }),
  });

  await api.sendEvent(runId, {
    type: 'info',
    data: JSON.stringify({
      method: 'turn/diff/updated',
      params: {
        diff: report.diff,
      },
    }),
  });

  if (api.uploadArtifact) {
    await api.uploadArtifact(runId, {
      name: `${runId}.diff`,
      type: 'diff',
      content: report.diff,
    });
  }
}

export function createBufferedEventSink(
  runId: string,
  api: Pick<McpWorkerApi, 'sendEvent'>,
  options: { logLocally?: boolean } = {},
) {
  let bufferedType: EventType | null = null;
  let bufferedData = '';
  const logLocally = options.logLocally ?? true;

  const flush = async () => {
    if (!bufferedType) return;
    await api.sendEvent(runId, { type: bufferedType, data: bufferedData });
    bufferedType = null;
    bufferedData = '';
  };

  const emit = async (type: EventType, data: string) => {
    const canBuffer = type === 'stdout' || type === 'stderr';
    if (canBuffer) {
      if (bufferedType === type) {
        bufferedData += data;
        return;
      }
      await flush();
      bufferedType = type;
      bufferedData = data;
      return;
    }

    await flush();
    if (logLocally) {
      logStreamEvent(type, data);
    }
    await api.sendEvent(runId, { type, data });
  };

  return { emit, flush };
}

export async function handleWorkerCommand(
  command: WorkerCommand,
  runId: string,
  api: Pick<McpWorkerApi, 'ackCommand' | 'sendEvent'> & Partial<Pick<McpWorkerApi, 'uploadArtifact' | 'saveResumeState'>>,
  executor: WorkerExecutor,
  providerOrSpawnFn: string | SpawnFn = 'codex',
  spawnFn: SpawnFn = spawn,
): Promise<boolean> {
  const provider = typeof providerOrSpawnFn === 'string' ? providerOrSpawnFn : 'codex';
  const effectiveSpawnFn = typeof providerOrSpawnFn === 'function' ? providerOrSpawnFn : spawnFn;
  logRunnerInfo(`processing ${summarizeCommand(command)} on run ${runId}`);

  if (command.command === '__STOP__') {
    await api.sendEvent(runId, { type: 'marker', data: JSON.stringify({ event: 'finished', exitCode: 0 }) });
    await api.ackCommand(runId, command.id, 'stopped');
    logRunnerInfo(`stopped run ${runId}`);
    return true;
  }

  if (command.command === '__ESCAPE__') {
    await executor.interrupt();
    await api.ackCommand(runId, command.id, 'interrupted');
    logRunnerInfo(`sent interrupt for run ${runId}`);
    return false;
  }

  if (command.command === '__START_VNC_STREAM__') {
    await api.sendEvent(runId, { type: 'info', data: 'VNC stream start command delivered to MCP worker' });
    await api.ackCommand(runId, command.id, 'vnc-start-ack');
    logRunnerInfo(`acknowledged VNC stream start for run ${runId}`);
    return false;
  }

  if (command.command === '__EXEC__') {
    const shellCommand = (command.arguments ?? '').trim();
    if (!shellCommand) {
      await api.ackCommand(runId, command.id, undefined, 'Missing shell command');
      return false;
    }
    const sink = createBufferedEventSink(runId, api, { logLocally: true });
    await executeShellCommand(shellCommand, sink.emit, effectiveSpawnFn);
    await sink.flush();
    await emitSynthesizedChangeReport(runId, provider, api, effectiveSpawnFn);
    await api.ackCommand(runId, command.id, 'ok');
    logRunnerInfo(`completed ${summarizeCommand(command)} on run ${runId}`);
    return false;
  }

  const input = command.command === '__INPUT__' ? (command.arguments ?? '') : command.command;
  const sink = createBufferedEventSink(runId, api, { logLocally: false });
  await executor.sendInput(input, sink.emit);
  await sink.flush();
  if (api.saveResumeState && executor.snapshotState) {
    await api.saveResumeState(runId, executor.snapshotState());
  }
  await emitSynthesizedChangeReport(runId, provider, api, effectiveSpawnFn);
  await api.ackCommand(runId, command.id, 'ok');
  logRunnerInfo(`completed ${summarizeCommand(command)} on run ${runId}`);
  return false;
}

export interface RunnerOptions {
  gatewayUrl: string;
  token: string;
  runnerId: string;
  provider: string;
  codexMode: 'app-server' | 'interactive' | 'exec';
  codexApprovalPolicy: string;
  claudePermissionMode?: string;
  geminiApprovalMode?: string;
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
  if (options.provider === 'claude') {
    return new ClaudeCliExecutor({
      permissionMode: options.claudePermissionMode,
    });
  }
  if (options.provider === 'gemini') {
    return new GeminiCliExecutor({
      approvalMode: options.geminiApprovalMode,
    });
  }
  return new TemplateExecExecutor(options.execTemplate ?? '');
}

function makeRunnerLogSink(
  runId: string,
  api: Pick<McpWorkerApi, 'sendEvent'>,
): (level: 'info' | 'error', msg: string) => void {
  return (level, msg) => {
    const data = JSON.stringify({
      method: 'runner/log',
      params: { level, message: msg },
    });
    api.sendEvent(runId, { type: 'info', data }).catch(() => {});
  };
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
      setRunnerLogSink(makeRunnerLogSink(runId, api));
      logRunnerInfo(`claimed run ${runId} for provider ${options.provider}`);
      if (executor.restoreState) {
        executor.restoreState(claimed.run.resumeState ?? null);
      }
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
          options.provider,
          spawn,
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
            stopRun = await handleWorkerCommand(command, runId, api, executor, options.provider);
          } catch (err: any) {
            await api.sendEvent(runId, { type: 'error', data: String(err?.message ?? err) });
            await api.ackCommand(runId, command.id, undefined, String(err?.message ?? err));
          }
        }
      }
      if (executor.shutdown) await executor.shutdown();
      setRunnerLogSink(null);
    } catch (err: any) {
      setRunnerLogSink(null);
      if (isExpectedIdleClaimError(err)) {
        const now = Date.now();
        if (now - lastIdleClaimLogAt > 30000) {
          // eslint-disable-next-line no-console
          console.info('[airc-mcp-runner] waiting for MCP session registration');
          lastIdleClaimLogAt = now;
        }
      } else {
        logRunnerError(`error ${err?.message ?? err}`);
      }
      await new Promise((resolve) => setTimeout(resolve, errorBackoffMs));
    }
  }
}

export async function runLoopOnce(
  options: RunnerOptions,
  deps: {
    api?: Pick<McpWorkerApi, 'claimRun' | 'pollCommands' | 'ackCommand' | 'sendEvent' | 'uploadArtifact' | 'saveResumeState'>;
    executor?: WorkerExecutor;
    spawnFn?: SpawnFn;
  } = {},
): Promise<{ claimedRunId: string | null; stopRun: boolean }> {
  const api = deps.api ?? new McpWorkerApi(options.gatewayUrl, options.token, options.provider, options.runnerId);
  const executor = deps.executor ?? createExecutor(options);

  const claimed = await api.claimRun();
  if (!claimed.run) {
    return { claimedRunId: null, stopRun: false };
  }

  const runId = claimed.run.id;
  setRunnerLogSink(makeRunnerLogSink(runId, api));
  logRunnerInfo(`claimed run ${runId} for provider ${options.provider}`);
  if (executor.restoreState) {
    executor.restoreState(claimed.run.resumeState ?? null);
  }
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
      options.provider,
      deps.spawnFn,
    );
  }

  const commands = await api.pollCommands(runId);
  let stopRun = false;
  for (const command of commands) {
    try {
      stopRun = await handleWorkerCommand(command, runId, api, executor, options.provider, deps.spawnFn);
      if (stopRun) break;
    } catch (err: any) {
      await api.sendEvent(runId, { type: 'error', data: String(err?.message ?? err) });
      await api.ackCommand(runId, command.id, undefined, String(err?.message ?? err));
      logRunnerError(`command ${command.id} failed on run ${runId}: ${String(err?.message ?? err)}`);
    }
  }

  if (stopRun && executor.shutdown) {
    await executor.shutdown();
  }

  setRunnerLogSink(null);
  return { claimedRunId: runId, stopRun };
}
