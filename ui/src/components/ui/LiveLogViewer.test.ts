import { describe, expect, it } from 'vitest';
import { condenseLogEvents, formatLogEventDisplay, type LogEvent } from './LiveLogViewer';

describe('LiveLogViewer helpers', () => {
  it('condenses adjacent stdout token fragments into readable lines', () => {
    const events: LogEvent[] = [
      { id: 1, type: 'stdout', data: 'Hello', timestamp: 1 },
      { id: 2, type: 'stdout', data: ' world', timestamp: 1 },
      { id: 3, type: 'stdout', data: '!\nNext line', timestamp: 1 },
      { id: 4, type: 'stderr', data: 'warn', timestamp: 2 },
      { id: 5, type: 'stderr', data: ' ing', timestamp: 2 },
    ];

    expect(condenseLogEvents(events)).toEqual([
      { id: 1, type: 'stdout', data: 'Hello world!', timestamp: 1 },
      { id: 1.001, type: 'stdout', data: 'Next line', timestamp: 1 },
      { id: 4, type: 'stderr', data: 'warn ing', timestamp: 2 },
    ]);
  });

  it('formats codex app-server info notifications into readable activity text', () => {
    const started = formatLogEventDisplay({
      id: 1,
      type: 'info',
      timestamp: 1,
      data: JSON.stringify({
        method: 'turn/started',
        params: { turn: { id: 'turn-1', status: 'inProgress' } },
      }),
    });
    expect(started.content).toBe('Codex turn started');
    expect(started.emphasis).toBe('info');

    const commandStarted = formatLogEventDisplay({
      id: 2,
      type: 'info',
      timestamp: 1,
      data: JSON.stringify({
        method: 'item/started',
        params: { item: { type: 'commandExecution', id: 'call-1', command: 'npm test' } },
      }),
    });
    expect(commandStarted.content).toBe('Tool call started: npm test');
    expect(commandStarted.emphasis).toBe('tool');

    const commandDone = formatLogEventDisplay({
      id: 3,
      type: 'info',
      timestamp: 1,
      data: JSON.stringify({
        method: 'item/completed',
        params: { item: { type: 'commandExecution', id: 'call-1', status: 'completed', command: 'npm test' } },
      }),
    });
    expect(commandDone.content).toBe('Tool call finished: npm test');
    expect(commandDone.emphasis).toBe('success');

    const userStarted = formatLogEventDisplay({
      id: 3.5,
      type: 'info',
      timestamp: 1,
      data: JSON.stringify({
        method: 'item/started',
        params: {
          item: {
            type: 'userMessage',
            id: 'user-1',
            content: [{ type: 'text', text: 'Long prompt body here' }],
          },
        },
      }),
    });
    expect(userStarted.content).toBe('Prompt delivered to Codex');
    expect(userStarted.emphasis).toBe('info');

    const userCompleted = formatLogEventDisplay({
      id: 3.6,
      type: 'info',
      timestamp: 1,
      data: JSON.stringify({
        method: 'item/completed',
        params: {
          item: {
            type: 'userMessage',
            id: 'user-1',
            content: [{ type: 'text', text: 'Long prompt body here' }],
          },
        },
      }),
    });
    expect(userCompleted.content).toBe('Prompt accepted by Codex');
    expect(userCompleted.emphasis).toBe('success');

    const threadStatus = formatLogEventDisplay({
      id: 4,
      type: 'info',
      timestamp: 1,
      data: JSON.stringify({
        method: 'thread/status/changed',
        params: {
          threadId: 'thread-1',
          status: { type: 'active', activeFlags: [] },
        },
      }),
    });
    expect(threadStatus.content).toBe('Codex thread active');
    expect(threadStatus.emphasis).toBe('info');

    const rateLimits = formatLogEventDisplay({
      id: 5,
      type: 'info',
      timestamp: 1,
      data: JSON.stringify({
        method: 'account/rateLimits/updated',
        params: {},
      }),
    });
    expect(rateLimits.content).toBe('Codex rate limits updated');
    expect(rateLimits.emphasis).toBe('default');
  });
});
