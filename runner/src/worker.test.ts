import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildExecInvocation,
  handleWorkerCommand,
  PersistentCodexExecutor,
} from './worker.js';
import { parseRunnerOptions } from './cli.js';

describe('runner command handling', () => {
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
});

describe('runner cli parsing', () => {
  it('reads options from env by default', () => {
    const options = parseRunnerOptions([], {
      AIREMOTECODER_GATEWAY_URL: 'http://gw:3100',
      AIREMOTECODER_MCP_TOKEN: 'token-123',
      AIREMOTECODER_PROVIDER: 'codex',
      AIREMOTECODER_CODEX_MODE: 'exec',
    });
    expect(options.gatewayUrl).toBe('http://gw:3100');
    expect(options.token).toBe('token-123');
    expect(options.provider).toBe('codex');
    expect(options.codexMode).toBe('exec');
  });

  it('allows argv to override env', () => {
    const options = parseRunnerOptions(
      ['--gateway-url', 'http://other:3100', '--token', 't2', '--provider', 'gemini', '--exec-template', 'gemini run {input}'],
      {
        AIREMOTECODER_GATEWAY_URL: 'http://gw:3100',
        AIREMOTECODER_MCP_TOKEN: 'token-123',
      },
    );
    expect(options.gatewayUrl).toBe('http://other:3100');
    expect(options.token).toBe('t2');
    expect(options.provider).toBe('gemini');
    expect(options.execTemplate).toBe('gemini run {input}');
  });

  it('fails when token is missing', () => {
    expect(() => parseRunnerOptions([], {})).toThrow('Missing MCP token');
  });
});
