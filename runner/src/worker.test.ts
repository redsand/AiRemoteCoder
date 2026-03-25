import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildExecInvocation,
  ClaudeCliExecutor,
  collectGitChangeReport,
  createBufferedEventSink,
  CodexAppServerExecutor,
  handleWorkerCommand,
  isExpectedIdleClaimError,
  PersistentCodexExecutor,
  runLoopOnce,
} from './worker.js';
import { parseRunnerOptions } from './cli.js';

describe('runner command handling', () => {
  it('buffers adjacent stdout chunks before sending events', async () => {
    const sendEvent = vi.fn().mockResolvedValue({ ok: true });
    const sink = createBufferedEventSink('run-1', { sendEvent } as any);

    await sink.emit('stdout', 'Hel');
    await sink.emit('stdout', 'lo');
    await sink.emit('stdout', ' world');
    await sink.emit('info', 'done');
    await sink.flush();

    expect(sendEvent).toHaveBeenNthCalledWith(1, 'run-1', { type: 'stdout', data: 'Hello world' });
    expect(sendEvent).toHaveBeenNthCalledWith(2, 'run-1', { type: 'info', data: 'done' });
  });

  it('maps __INPUT__ command to executor input and acks', async () => {
    const sendEvent = vi.fn().mockResolvedValue({ ok: true });
    const ackCommand = vi.fn().mockResolvedValue({ ok: true });
    const sendInput = vi.fn().mockResolvedValue(undefined);
    const interrupt = vi.fn().mockResolvedValue(undefined);

    const stop = await handleWorkerCommand(
      { id: 'cmd-1', command: '__INPUT__', arguments: 'hello' },
      'run-1',
      { sendEvent, ackCommand } as any,
      { sendInput, interrupt },
    );

    expect(stop).toBe(false);
    expect(sendInput).toHaveBeenCalledWith('hello', expect.any(Function));
    expect(ackCommand).toHaveBeenCalledWith('run-1', 'cmd-1', 'ok');
  });

  it('returns stop=true for __STOP__', async () => {
    const sendEvent = vi.fn().mockResolvedValue({ ok: true });
    const ackCommand = vi.fn().mockResolvedValue({ ok: true });
    const sendInput = vi.fn().mockResolvedValue(undefined);
    const interrupt = vi.fn().mockResolvedValue(undefined);

    const stop = await handleWorkerCommand(
      { id: 'cmd-stop', command: '__STOP__' },
      'run-stop',
      { sendEvent, ackCommand } as any,
      { sendInput, interrupt },
    );

    expect(stop).toBe(true);
    expect(ackCommand).toHaveBeenCalledWith('run-stop', 'cmd-stop', 'stopped');
  });

  it('acks VNC start commands without executor input', async () => {
    const sendEvent = vi.fn().mockResolvedValue({ ok: true });
    const ackCommand = vi.fn().mockResolvedValue({ ok: true });
    const sendInput = vi.fn().mockResolvedValue(undefined);
    const interrupt = vi.fn().mockResolvedValue(undefined);

    await handleWorkerCommand(
      { id: 'cmd-vnc', command: '__START_VNC_STREAM__' },
      'run-vnc',
      { sendEvent, ackCommand } as any,
      { sendInput, interrupt },
    );

    expect(sendInput).not.toHaveBeenCalled();
    expect(ackCommand).toHaveBeenCalledWith('run-vnc', 'cmd-vnc', 'vnc-start-ack');
  });

  it('executes __EXEC__ commands locally instead of sending them to the provider executor', async () => {
    const sendEvent = vi.fn().mockResolvedValue({ ok: true });
    const ackCommand = vi.fn().mockResolvedValue({ ok: true });
    const sendInput = vi.fn().mockResolvedValue(undefined);
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('On branch main\n'));
        child.emit('close', 0);
      });
      return child;
    });

    const stop = await handleWorkerCommand(
      { id: 'cmd-exec', command: '__EXEC__', arguments: 'git status' },
      'run-exec',
      { sendEvent, ackCommand } as any,
      { sendInput, interrupt },
      spawnFn as any,
    );
    expect(stop).toBe(false);
    expect(sendInput).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledWith('git status', [], expect.objectContaining({
      shell: true,
      windowsHide: true,
    }));
    expect(sendEvent).toHaveBeenCalledWith('run-exec', { type: 'stdout', data: 'On branch main\n' });
    expect(ackCommand).toHaveBeenCalledWith('run-exec', 'cmd-exec', 'ok');
  });

});

describe('runner executor helpers', () => {
  it('builds invocation from template with {input}', () => {
    const invocation = buildExecInvocation('mycli run {input}', 'hello world');
    expect(invocation.command).toBe('mycli');
    expect(invocation.args).toEqual(['run', 'hello world']);
  });

  it('requires template placeholder', () => {
    expect(() => buildExecInvocation('mycli run', 'hello')).toThrow('{input}');
  });

  it('reuses one interactive codex process across multiple inputs', async () => {
    const stdinWrite = vi.fn();
    const child = new EventEmitter() as any;
    child.stdin = { write: stdinWrite };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    const spawnFn = vi.fn(() => child);
    const executor = new PersistentCodexExecutor(spawnFn as any);
    await executor.sendInput('first', async () => {});
    await executor.sendInput('second', async () => {});

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(stdinWrite).toHaveBeenCalledWith('first\n');
    expect(stdinWrite).toHaveBeenCalledWith('second\n');
  });

  it('uses codex app-server to maintain a conversational thread across inputs', async () => {
    const writes: string[] = [];
    const child = new EventEmitter() as any;
    child.stdin = {
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
        const messages = chunk
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        for (const message of messages) {
          if (message.method === 'initialize') {
            child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`));
          } else if (message.method === 'thread/start') {
            child.stdout.emit('data', Buffer.from(`${JSON.stringify({
              id: message.id,
              result: { thread: { id: 'thread-1' } },
            })}\n`));
          } else if (message.method === 'turn/start') {
            const turnId = `turn-${message.id}`;
            child.stdout.emit('data', Buffer.from(`${JSON.stringify({
              id: message.id,
              result: { turn: { id: turnId } },
            })}\n`));
            child.stdout.emit('data', Buffer.from(`${JSON.stringify({
              method: 'item/agentMessage/delta',
              params: { turnId, delta: `reply:${message.params.input[0].text}` },
            })}\n`));
            child.stdout.emit('data', Buffer.from(`${JSON.stringify({
              method: 'turn/completed',
              params: { turn: { id: turnId, status: 'completed', result: 'ok' } },
            })}\n`));
          }
        }
      }),
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    const spawnFn = vi.fn(() => child);
    const executor = new CodexAppServerExecutor({ spawnFn: spawnFn as any });
    const events: Array<{ type: string; data: string }> = [];

    await executor.sendInput('first prompt', async (type, data) => {
      events.push({ type, data });
    });
    await executor.sendInput('second prompt', async (type, data) => {
      events.push({ type, data });
    });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(writes.map((line) => JSON.parse(line.trim()).method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
      'turn/start',
    ]);
    const threadStart = JSON.parse(writes[2].trim());
    expect(threadStart.params.approvalPolicy).toBe('never');
    expect(events).toEqual([
      { type: 'stdout', data: 'reply:first prompt' },
      { type: 'stdout', data: 'reply:second prompt' },
    ]);
  });

  it('surfaces codex app-server turn failures', async () => {
    const child = new EventEmitter() as any;
    child.stdin = {
      write: vi.fn((chunk: string) => {
        const message = JSON.parse(chunk.trim());
        if (message.method === 'initialize') {
          child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`));
        } else if (message.method === 'thread/start') {
          child.stdout.emit('data', Buffer.from(`${JSON.stringify({
            id: message.id,
            result: { thread: { id: 'thread-1' } },
          })}\n`));
        } else if (message.method === 'turn/start') {
          const turnId = `turn-${message.id}`;
          child.stdout.emit('data', Buffer.from(`${JSON.stringify({
            id: message.id,
            result: { turn: { id: turnId } },
          })}\n`));
          child.stdout.emit('data', Buffer.from(`${JSON.stringify({
            method: 'turn/completed',
            params: { turn: { id: turnId, status: 'failed', error: { message: 'denied' } } },
          })}\n`));
        }
      }),
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    const executor = new CodexAppServerExecutor({ spawnFn: vi.fn(() => child) as any });

    await expect(executor.sendInput('explode', async () => {})).rejects.toThrow('denied');
  });

  it('uses claude CLI with persistent resume semantics across inputs', async () => {
    const spawns: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const stdoutChunks = [
      [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first reply' }] } }),
        JSON.stringify({ type: 'result', subtype: 'success', session_id: 'session-1' }),
      ],
      [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'second reply' }] } }),
        JSON.stringify({ type: 'result', subtype: 'success', session_id: 'session-1' }),
      ],
    ];
    const spawnFn = vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
      spawns.push({ command, args, options });
      const child = new EventEmitter() as any;
      child.stdin = {
        end: vi.fn(),
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        const chunkSet = stdoutChunks[spawns.length - 1] ?? [];
        for (const line of chunkSet) {
          child.stdout.emit('data', Buffer.from(`${line}\n`));
        }
        child.emit('close', 0);
      });
      return child;
    });

    const executor = new ClaudeCliExecutor({ spawnFn: spawnFn as any, cwd: 'C:/repo' });
    const events: Array<{ type: string; data: string }> = [];

    await executor.sendInput('first prompt', async (type, data) => {
      events.push({ type, data });
    });
    await executor.sendInput('second prompt', async (type, data) => {
      events.push({ type, data });
    });

    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(spawns[0]?.command).toBe('claude');
    expect(spawns[0]?.args).toEqual(expect.arrayContaining([
      '-p',
      '--print',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--session-id',
    ]));
    const sessionIdIndex = spawns[0]?.args.indexOf('--session-id') ?? -1;
    expect(sessionIdIndex).toBeGreaterThan(-1);
    expect(spawns[0]?.args[sessionIdIndex + 1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(spawns[1]?.args).toEqual(expect.arrayContaining([
      '-p',
      '--print',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--resume',
      'session-1',
    ]));
    expect(events.filter((event) => event.type === 'stdout')).toEqual([
      { type: 'stdout', data: 'first reply' },
      { type: 'stdout', data: 'second reply' },
    ]);
  });

  it('allows overriding Claude permission mode explicitly', async () => {
    let firstArgs: string[] = [];
    const spawnFn = vi.fn((command: string, args: string[]) => {
      void command;
      firstArgs = args;
      const child = new EventEmitter() as any;
      child.stdin = { end: vi.fn() };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'session-1' })}\n`));
        child.emit('close', 0);
      });
      return child;
    });

    const executor = new ClaudeCliExecutor({ spawnFn: spawnFn as any, permissionMode: 'acceptEdits' });
    await executor.sendInput('hello', async () => {});

    expect(firstArgs).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
  });

  it('passes Claude prompts as CLI args on Windows too', async () => {
    let firstArgs: string[] = [];
    const spawnFn = vi.fn((command: string, args: string[]) => {
      void command;
      firstArgs = args;
      const child = new EventEmitter() as any;
      child.stdin = { end: vi.fn() };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'session-1' })}\n`));
        child.emit('close', 0);
      });
      return child;
    });

    const executor = new ClaudeCliExecutor({ spawnFn: spawnFn as any, platform: 'win32' });
    await executor.sendInput('Get-ChildItem $env:TEMP', async () => {});

    expect(firstArgs).toEqual(expect.arrayContaining(['--', 'Get-ChildItem $env:TEMP']));
  });

  it('surfaces Claude CLI errors from stream-json results', async () => {
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter() as any;
      child.stdin = { end: vi.fn() };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          type: 'result',
          subtype: 'error',
          is_error: true,
          error: 'permission denied',
        })}\n`));
        child.emit('close', 1);
      });
      return child;
    });

    const executor = new ClaudeCliExecutor({ spawnFn: spawnFn as any });
    await expect(executor.sendInput('explode', async () => {})).rejects.toThrow('permission denied');
  });

  it('prefers Claude result text when stream-json reports an error without an error field', async () => {
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter() as any;
      child.stdin = { end: vi.fn() };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          type: 'result',
          subtype: 'error',
          is_error: true,
          result: 'File has not been read yet. Read it first before writing to it.',
        })}\n`));
        child.emit('close', 1);
      });
      return child;
    });

    const executor = new ClaudeCliExecutor({ spawnFn: spawnFn as any });
    await expect(executor.sendInput('explode', async () => {})).rejects.toThrow('File has not been read yet');
  });

  it('carries forward Claude tool_use_error text when the final result is generic', async () => {
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter() as any;
      child.stdin = { end: vi.fn() };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Edit', id: 'tool-1', input: { file_path: 'server/routes.js' } },
            ],
          },
        })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>' },
            ],
          },
        })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          type: 'result',
          subtype: 'error',
          is_error: true,
        })}\n`));
        child.emit('close', 1);
      });
      return child;
    });

    const executor = new ClaudeCliExecutor({ spawnFn: spawnFn as any });
    await expect(executor.sendInput('explode', async () => {})).rejects.toThrow('File has not been read yet');
  });

  it('restores Claude CLI session id for helper restart resume', async () => {
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter() as any;
      child.stdin = { end: vi.fn() };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          type: 'result',
          subtype: 'success',
          session_id: 'session-restored',
        })}\n`));
        child.emit('close', 0);
      });
      return child;
    });

    const executor = new ClaudeCliExecutor({ spawnFn: spawnFn as any });
    executor.restoreState?.({ cliSessionId: 'session-restored' });
    await executor.sendInput('resume me', async () => {});

    expect(spawnFn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--resume', 'session-restored']),
      expect.any(Object),
    );
    expect(executor.snapshotState?.()).toEqual({ cliSessionId: 'session-restored' });
  });

  it('logs Claude launch metadata and completion to the terminal', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter() as any;
      child.stdin = { end: vi.fn() };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          type: 'result',
          subtype: 'success',
          session_id: 'session-ok',
        })}\n`));
        child.emit('close', 0);
      });
      return child;
    });

    const executor = new ClaudeCliExecutor({ spawnFn: spawnFn as any });
    await executor.sendInput('hello', async () => {});

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('launching Claude'));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Claude turn completed successfully'));
    infoSpy.mockRestore();
  });

  it('surfaces Claude tool, thinking, and system status activity', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter() as any;
      child.stdin = { end: vi.fn() };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          type: 'system',
          subtype: 'status',
          status: 'waiting_for_permission',
          session_id: 'session-1',
        })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', text: 'Considering next steps' },
              { type: 'tool_use', name: 'Bash', id: 'tool-1', input: { command: 'npm test' } },
              { type: 'text', text: 'Working on it' },
            ],
          },
        })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'Tests passed' },
            ],
          },
        })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          type: 'result',
          subtype: 'success',
          session_id: 'session-1',
        })}\n`));
        child.emit('close', 0);
      });
      return child;
    });

    const executor = new ClaudeCliExecutor({ spawnFn: spawnFn as any });
    const events: Array<{ type: string; data: string }> = [];

    await executor.sendInput('status?', async (type, data) => {
      events.push({ type, data });
    });

    expect(events).toEqual(expect.arrayContaining([
      { type: 'info', data: 'Claude status: waiting_for_permission' },
      { type: 'info', data: 'Claude reasoning: Considering next steps' },
      { type: 'tool_use', data: JSON.stringify({ phase: 'pre', tool: 'Bash npm test', provider: 'claude', toolId: 'tool-1' }) },
      { type: 'stdout', data: 'Working on it' },
      { type: 'tool_use', data: JSON.stringify({ phase: 'post', tool: 'Bash npm test', provider: 'claude', toolId: 'tool-1', summary: 'Tests passed' }) },
    ]));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Claude status: waiting_for_permission'));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Tool call started: Bash npm test'));
    infoSpy.mockRestore();
  });

  it('collects git diff and changed files for synthesized change reporting', async () => {
    const spawnFn = vi.fn((command: string, args: string[]) => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        if (args.includes('--name-only')) {
          child.stdout.emit('data', Buffer.from('src/app.ts\nsrc/lib.ts\n'));
        } else {
          child.stdout.emit('data', Buffer.from(
            'diff --git a/src/app.ts b/src/app.ts\n' +
            '--- a/src/app.ts\n' +
            '+++ b/src/app.ts\n' +
            '@@ -1 +1 @@\n' +
            '-old\n' +
            '+new\n',
          ));
        }
        child.emit('close', 0);
      });
      return child;
    });

    const report = await collectGitChangeReport(spawnFn as any);
    expect(report).toEqual({
      files: ['src/app.ts', 'src/lib.ts'],
      diff: expect.stringContaining('diff --git a/src/app.ts b/src/app.ts'),
    });
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });
});

describe('runner cli parsing', () => {
  it('reads options from env by default', () => {
    const options = parseRunnerOptions([], {
      AIREMOTECODER_GATEWAY_URL: 'http://gw:3100',
      AIREMOTECODER_MCP_TOKEN: 'token-123',
      AIREMOTECODER_PROVIDER: 'codex',
    });
    expect(options.gatewayUrl).toBe('http://gw:3100');
    expect(options.token).toBe('token-123');
    expect(options.provider).toBe('codex');
    expect(options.codexMode).toBe('app-server');
    expect(options.codexApprovalPolicy).toBe('never');
    expect(options.runnerId).toMatch(/^[a-f0-9]{16}$/);
  });

  it('defaults Claude permission mode to bypassPermissions', () => {
    const options = parseRunnerOptions([], {
      AIREMOTECODER_GATEWAY_URL: 'http://gw:3100',
      AIREMOTECODER_MCP_TOKEN: 'token-123',
      AIREMOTECODER_PROVIDER: 'claude',
    });

    expect(options.provider).toBe('claude');
    expect(options.claudePermissionMode).toBe('bypassPermissions');
  });

  it('normalizes /mcp gateway url to base gateway url', () => {
    const options = parseRunnerOptions([], {
      AIREMOTECODER_GATEWAY_URL: 'http://localhost:3100/mcp',
      AIREMOTECODER_MCP_TOKEN: 'token-123',
      AIREMOTECODER_PROVIDER: 'codex',
    });
    expect(options.gatewayUrl).toBe('http://localhost:3100');
  });

  it('allows argv to override env', () => {
    const options = parseRunnerOptions(
      ['--gateway-url', 'http://other:3100', '--token', 't2', '--provider', 'gemini', '--exec-template', 'gemini run {input}', '--codex-approval-policy', 'on-request', '--claude-permission-mode', 'acceptEdits'],
      {
        AIREMOTECODER_GATEWAY_URL: 'http://gw:3100',
        AIREMOTECODER_MCP_TOKEN: 'token-123',
      },
    );
    expect(options.gatewayUrl).toBe('http://other:3100');
    expect(options.token).toBe('t2');
    expect(options.provider).toBe('gemini');
    expect(options.execTemplate).toBe('gemini run {input}');
    expect(options.codexApprovalPolicy).toBe('on-request');
    expect(options.claudePermissionMode).toBe('acceptEdits');
    expect(options.runnerId).toMatch(/^[a-f0-9]{16}$/);
  });

  it('accepts explicit runner id seed and hashes it deterministically', () => {
    const one = parseRunnerOptions(
      ['--token', 't2', '--runner-id', 'my-runner'],
      {},
    );
    const two = parseRunnerOptions(
      ['--token', 't2', '--runner-id', 'my-runner'],
      {},
    );
    expect(one.runnerId).toBe('my-runner');
    expect(two.runnerId).toBe('my-runner');
  });

  it('fails when token is missing', () => {
    expect(() => parseRunnerOptions([], {})).toThrow('Missing MCP token');
  });
});

describe('runner error classification', () => {
  it('suppresses expected no-session claim errors', () => {
    expect(isExpectedIdleClaimError(new Error('POST /api/mcp/runs/claim failed (404): {"error":"No active MCP session found for this token"}'))).toBe(true);
  });

  it('does not suppress unrelated errors', () => {
    expect(isExpectedIdleClaimError(new Error('POST /api/mcp/runs/claim failed (500): boom'))).toBe(false);
  });
});

describe('runner loop integration', () => {
  it('claims a run, emits started, processes commands, and stops cleanly', async () => {
    const api = {
      claimRun: vi.fn().mockResolvedValue({
        run: { id: 'run-1', command: 'bootstrap task', workerType: 'codex' },
      }),
      pollCommands: vi.fn().mockResolvedValue([
        { id: 'cmd-1', command: '__INPUT__', arguments: 'follow up' },
        { id: 'cmd-stop', command: '__STOP__' },
      ]),
      ackCommand: vi.fn().mockResolvedValue({ ok: true }),
      sendEvent: vi.fn().mockResolvedValue({ ok: true }),
    };
    const executor = {
      sendInput: vi.fn(async (input: string, emit: (type: string, data: string) => Promise<void>) => {
        await emit('stdout', `done:${input}`);
      }),
      interrupt: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runLoopOnce({
      gatewayUrl: 'http://localhost:3100',
      token: 'token-1',
      runnerId: 'runner-1',
      provider: 'codex',
      codexMode: 'app-server',
      codexApprovalPolicy: 'never',
    }, { api: api as any, executor: executor as any });

    expect(result).toEqual({ claimedRunId: 'run-1', stopRun: true });
    expect(executor.sendInput).toHaveBeenNthCalledWith(1, 'bootstrap task', expect.any(Function));
    expect(executor.sendInput).toHaveBeenNthCalledWith(2, 'follow up', expect.any(Function));
    expect(api.sendEvent).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ type: 'marker', data: expect.stringContaining('"started"') }),
    );
    expect(api.ackCommand).toHaveBeenCalledWith('run-1', 'cmd-1', 'ok');
    expect(api.ackCommand).toHaveBeenCalledWith('run-1', 'cmd-stop', 'stopped');
    expect(executor.shutdown).toHaveBeenCalledTimes(1);
  });

  it('synthesizes diff events and uploads a diff artifact for non-codex providers', async () => {
    const api = {
      claimRun: vi.fn().mockResolvedValue({
        run: { id: 'run-claude-1', command: 'bootstrap task', workerType: 'claude' },
      }),
      pollCommands: vi.fn().mockResolvedValue([]),
      ackCommand: vi.fn().mockResolvedValue({ ok: true }),
      sendEvent: vi.fn().mockResolvedValue({ ok: true }),
      saveResumeState: vi.fn().mockResolvedValue({ ok: true }),
      uploadArtifact: vi.fn().mockResolvedValue({ ok: true, artifactId: 'artifact-1' }),
    };
    const executor = {
      sendInput: vi.fn(async (_input: string, emit: (type: string, data: string) => Promise<void>) => {
        await emit('stdout', 'done');
      }),
      interrupt: vi.fn().mockResolvedValue(undefined),
    };
    const spawnFn = vi.fn((command: string, args: string[]) => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        if (args.includes('--name-only')) {
          child.stdout.emit('data', Buffer.from('src/app.ts\n'));
        } else {
          child.stdout.emit('data', Buffer.from(
            'diff --git a/src/app.ts b/src/app.ts\n' +
            '--- a/src/app.ts\n' +
            '+++ b/src/app.ts\n' +
            '@@ -1 +1 @@\n' +
            '-old\n' +
            '+new\n',
          ));
        }
        child.emit('close', 0);
      });
      return child;
    });

    await runLoopOnce({
      gatewayUrl: 'http://localhost:3100',
      token: 'token-1',
      runnerId: 'runner-1',
      provider: 'claude',
      codexMode: 'app-server',
      codexApprovalPolicy: 'never',
    }, { api: api as any, executor: executor as any, spawnFn: spawnFn as any });

    expect(spawnFn).toHaveBeenCalled();
    expect(api.sendEvent).toHaveBeenCalledWith('run-claude-1', expect.objectContaining({
      type: 'info',
      data: expect.stringContaining('"method":"item/completed"'),
    }));
    expect(api.sendEvent).toHaveBeenCalledWith('run-claude-1', expect.objectContaining({
      type: 'info',
      data: expect.stringContaining('"method":"turn/diff/updated"'),
    }));
    expect(api.uploadArtifact).toHaveBeenCalledWith('run-claude-1', expect.objectContaining({
      name: 'run-claude-1.diff',
      type: 'diff',
      content: expect.stringContaining('diff --git a/src/app.ts b/src/app.ts'),
    }));
  });

  it('hydrates executor resume state from claim response before polling commands', async () => {
    const api = {
      claimRun: vi.fn().mockResolvedValue({
        run: {
          id: 'run-claude-restart',
          command: null,
          workerType: 'claude',
          resumeState: { cliSessionId: 'session-from-gateway' },
        },
      }),
      pollCommands: vi.fn().mockResolvedValue([]),
      ackCommand: vi.fn().mockResolvedValue({ ok: true }),
      sendEvent: vi.fn().mockResolvedValue({ ok: true }),
      saveResumeState: vi.fn().mockResolvedValue({ ok: true }),
      uploadArtifact: vi.fn().mockResolvedValue({ ok: true, artifactId: 'artifact-1' }),
    };
    const executor = {
      sendInput: vi.fn(),
      interrupt: vi.fn().mockResolvedValue(undefined),
      restoreState: vi.fn(),
    };

    await runLoopOnce({
      gatewayUrl: 'http://localhost:3100',
      token: 'token-1',
      runnerId: 'runner-1',
      provider: 'claude',
      codexMode: 'app-server',
      codexApprovalPolicy: 'never',
    }, { api: api as any, executor: executor as any });

    expect(executor.restoreState).toHaveBeenCalledWith({ cliSessionId: 'session-from-gateway' });
  });
});
