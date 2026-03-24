import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { buildExecInvocation, handleWorkerCommand, PersistentCodexExecutor } from './mcp-worker-loop.js';

describe('mcp-worker-loop command handling', () => {
  it('maps __INPUT__ command to executor input and acks', async () => {
    const sendEvent = vi.fn().mockResolvedValue({ ok: true });
    const ackCommand = vi.fn().mockResolvedValue({ ok: true });
    const sendInput = vi.fn().mockResolvedValue(undefined);
    const interrupt = vi.fn().mockResolvedValue(undefined);

    const stop = await handleWorkerCommand(
      { id: 'cmd-1', command: '__INPUT__', arguments: 'hello' },
      'run-1',
      { sendEvent, ackCommand } as any,
      { sendInput, interrupt }
    );

    expect(stop).toBe(false);
    expect(sendInput).toHaveBeenCalledWith('hello', expect.any(Function));
    expect(ackCommand).toHaveBeenCalledWith('run-1', 'cmd-1', 'ok');
  });

  it('returns stop=true for __STOP__ and emits finished marker', async () => {
    const sendEvent = vi.fn().mockResolvedValue({ ok: true });
    const ackCommand = vi.fn().mockResolvedValue({ ok: true });
    const sendInput = vi.fn().mockResolvedValue(undefined);
    const interrupt = vi.fn().mockResolvedValue(undefined);

    const stop = await handleWorkerCommand(
      { id: 'cmd-stop', command: '__STOP__' },
      'run-stop',
      { sendEvent, ackCommand } as any,
      { sendInput, interrupt }
    );

    expect(stop).toBe(true);
    expect(sendEvent).toHaveBeenCalledWith(
      'run-stop',
      expect.objectContaining({ type: 'marker' })
    );
    expect(ackCommand).toHaveBeenCalledWith('run-stop', 'cmd-stop', 'stopped');
  });

  it('acks VNC start commands without executor input', async () => {
    const sendEvent = vi.fn().mockResolvedValue({ ok: true });
    const ackCommand = vi.fn().mockResolvedValue({ ok: true });
    const sendInput = vi.fn().mockResolvedValue(undefined);
    const interrupt = vi.fn().mockResolvedValue(undefined);

    const stop = await handleWorkerCommand(
      { id: 'cmd-vnc', command: '__START_VNC_STREAM__' },
      'run-vnc',
      { sendEvent, ackCommand } as any,
      { sendInput, interrupt }
    );

    expect(stop).toBe(false);
    expect(sendInput).not.toHaveBeenCalled();
    expect(ackCommand).toHaveBeenCalledWith('run-vnc', 'cmd-vnc', 'vnc-start-ack');
  });

  it('builds secure invocation from template with {input} placeholder', () => {
    const invocation = buildExecInvocation('mycli run {input}', 'hello world');
    expect(invocation.command).toBe('mycli');
    expect(invocation.args).toEqual(['run', 'hello world']);
  });

  it('requires template to include {input}', () => {
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

  it('sends ctrl+c on interrupt in interactive mode', async () => {
    const stdinWrite = vi.fn();
    const child = new EventEmitter() as any;
    child.stdin = { write: stdinWrite };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    const spawnFn = vi.fn(() => child);
    const executor = new PersistentCodexExecutor(spawnFn as any);
    await executor.sendInput('hello', async () => {});
    await executor.interrupt();

    expect(stdinWrite).toHaveBeenCalledWith('\u0003');
  });
});
