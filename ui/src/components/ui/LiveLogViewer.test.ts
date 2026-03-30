import { describe, expect, it } from 'vitest';
import { condenseLogEvents, countErrorEvents, formatLogEventDisplay, shouldDisableAutoScroll, type LogEvent } from './LiveLogViewer';

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

  it('condenses codex reasoning summary delta JSON into a readable reasoning line', () => {
    const events: LogEvent[] = [
      {
        id: 9,
        type: 'info',
        timestamp: 1,
        data: JSON.stringify({
          method: 'item/reasoning/summaryPartAdded',
          params: { itemId: 'r1', summaryIndex: 0 },
        }),
      },
      {
        id: 10,
        type: 'info',
        timestamp: 1,
        data: JSON.stringify({
          method: 'item/reasoning/summaryTextDelta',
          params: { itemId: 'r1', summaryIndex: 0, delta: 'Inspecting' },
        }),
      },
      {
        id: 11,
        type: 'info',
        timestamp: 1,
        data: JSON.stringify({
          method: 'item/reasoning/summaryTextDelta',
          params: { itemId: 'r1', summaryIndex: 0, delta: ' shader settings' },
        }),
      },
      {
        id: 12,
        type: 'info',
        timestamp: 2,
        data: JSON.stringify({
          method: 'item/completed',
          params: { item: { type: 'reasoning', id: 'r1' } },
        }),
      },
    ];

    expect(condenseLogEvents(events)).toEqual([
      { id: 10, type: 'info', data: 'Codex reasoning: Inspecting shader settings', timestamp: 1 },
      { id: 12, type: 'info', data: events[3].data, timestamp: 2 },
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

    const planUpdated = formatLogEventDisplay({
      id: 6,
      type: 'info',
      timestamp: 1,
      data: JSON.stringify({
        method: 'turn/plan/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          explanation: null,
          plan: [
            { step: 'Inspect scene/output transition path and identify missing telemetry boundaries', status: 'completed' },
            { step: 'Implement transition trace and render snapshot instrumentation across main and output renderers', status: 'inProgress' },
            { step: 'Add regression harness and focused tests for intermittent black transitions', status: 'pending' },
          ],
        },
      }),
    });
    expect(planUpdated.content).toContain('Plan updated');
    expect(planUpdated.content).toContain('Active: Implement transition trace and render snapshot instrumentation across main and output renderers');
    expect(planUpdated.emphasis).toBe('info');

    const fileChangeStarted = formatLogEventDisplay({
      id: 7,
      type: 'info',
      timestamp: 1,
      data: JSON.stringify({
        method: 'item/started',
        params: {
          item: {
            type: 'fileChange',
            id: 'change-1',
            status: 'inProgress',
            changes: [
              {
                path: 'C:\\Users\\TimShelton\\source\\repos\\VisualSynth\\src\\renderer\\render\\outputPayload.ts',
                kind: { type: 'update', move_path: null },
              },
            ],
          },
        },
      }),
    });
    expect(fileChangeStarted.content).toBe('Editing 1 file: src\\renderer\\render\\outputPayload.ts');
    expect(fileChangeStarted.emphasis).toBe('tool');

    const fileChangeCompleted = formatLogEventDisplay({
      id: 8,
      type: 'info',
      timestamp: 1,
      data: JSON.stringify({
        method: 'item/completed',
        params: {
          item: {
            type: 'fileChange',
            id: 'change-1',
            status: 'completed',
            changes: [
              {
                path: 'C:\\Users\\TimShelton\\source\\repos\\VisualSynth\\src\\renderer\\render\\outputPayload.ts',
                kind: { type: 'update', move_path: null },
              },
            ],
          },
        },
      }),
    });
    expect(fileChangeCompleted.content).toBe('Updated 1 file: src\\renderer\\render\\outputPayload.ts');
    expect(fileChangeCompleted.emphasis).toBe('success');

    const diffUpdated = formatLogEventDisplay({
      id: 9,
      type: 'info',
      timestamp: 1,
      data: JSON.stringify({
        method: 'turn/diff/updated',
        params: {
          diff: 'diff --git a/src/renderer/render/outputPayload.ts b/src/renderer/render/outputPayload.ts\n@@ -1 +1 @@\n-a\n+b',
        },
      }),
    });
    expect(diffUpdated.content).toBe('Diff updated for 1 file');
    expect(diffUpdated.emphasis).toBe('tool');
  });

  it('formats Claude runner activity into the same readable timeline style', () => {
    const prompt = formatLogEventDisplay({
      id: 1,
      type: 'info',
      timestamp: 1,
      data: 'Executing Claude prompt (95 chars)',
    });
    expect(prompt.content).toBe('Prompt delivered to Claude');
    expect(prompt.emphasis).toBe('info');

    const reasoning = formatLogEventDisplay({
      id: 2,
      type: 'info',
      timestamp: 1,
      data: 'Claude reasoning: Considering next steps',
    });
    expect(reasoning.content).toBe('Claude is reasoning');
    expect(reasoning.emphasis).toBe('info');

    const toolStarted = formatLogEventDisplay({
      id: 3,
      type: 'tool_use',
      timestamp: 1,
      data: JSON.stringify({ phase: 'pre', tool: 'Bash npm test', provider: 'claude', toolId: 'tool-1' }),
    });
    expect(toolStarted.content).toBe('Tool call started: Bash npm test');
    expect(toolStarted.emphasis).toBe('tool');

    const toolFinished = formatLogEventDisplay({
      id: 4,
      type: 'tool_use',
      timestamp: 1,
      data: JSON.stringify({ phase: 'post', tool: 'Bash npm test', provider: 'claude', toolId: 'tool-1', summary: 'Tests passed' }),
    });
    expect(toolFinished.content).toBe('Tool call finished: Bash npm test');
    expect(toolFinished.emphasis).toBe('success');

    const toolFailed = formatLogEventDisplay({
      id: 4.5,
      type: 'tool_use',
      timestamp: 1,
      data: JSON.stringify({
        phase: 'post',
        tool: 'Edit server/routes.js',
        provider: 'claude',
        toolId: 'tool-2',
        summary: '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>',
      }),
    });
    expect(toolFailed.content).toBe('Tool call failed: Edit server/routes.js');
    expect(toolFailed.emphasis).toBe('error');

    const legacyToolResult = formatLogEventDisplay({
      id: 5,
      type: 'info',
      timestamp: 1,
      data: 'Claude tool result: Test Suites: 35 passed, 35 total\nTests: 551 passed, 551 total',
    });
    expect(legacyToolResult.content).toBe('Tool call finished');
    expect(legacyToolResult.emphasis).toBe('success');
  });

  it('formats condensed Codex reasoning lines as readable activity text', () => {
    const reasoning = formatLogEventDisplay({
      id: 1,
      type: 'info',
      timestamp: 1,
      data: 'Codex reasoning: Inspecting shader settings',
    });

    expect(reasoning.content).toBe('Codex reasoning: Inspecting shader settings');
    expect(reasoning.emphasis).toBe('info');
  });

  it('falls back to a generic MCP activity label instead of showing raw JSON', () => {
    const fallback = formatLogEventDisplay({
      id: 99,
      type: 'info',
      timestamp: 1,
      data: JSON.stringify({
        method: 'thread/customThing/updated',
        params: { foo: 'bar' },
      }),
    });

    expect(fallback.content).toBe('Agent activity: thread custom Thing updated');
    expect(fallback.emphasis).toBe('default');
  });

  it('formats Gemini runner activity into the same readable timeline style', () => {
    const prompt = formatLogEventDisplay({
      id: 1,
      type: 'info',
      timestamp: 1,
      data: 'Executing Gemini prompt (95 chars)',
    });
    expect(prompt.content).toBe('Prompt delivered to Gemini');
    expect(prompt.emphasis).toBe('info');

    const sessionStarted = formatLogEventDisplay({
      id: 2,
      type: 'info',
      timestamp: 1,
      data: 'Gemini session initialized',
    });
    expect(sessionStarted.content).toBe('Gemini session started');
    expect(sessionStarted.emphasis).toBe('info');

    const toolStarted = formatLogEventDisplay({
      id: 3,
      type: 'tool_use',
      timestamp: 1,
      data: JSON.stringify({ phase: 'pre', tool: 'bash npm test', provider: 'gemini', toolId: 'tool-1' }),
    });
    expect(toolStarted.content).toBe('Tool call started: bash npm test');
    expect(toolStarted.emphasis).toBe('tool');

    const toolFinished = formatLogEventDisplay({
      id: 4,
      type: 'tool_use',
      timestamp: 1,
      data: JSON.stringify({ phase: 'post', tool: 'bash npm test', provider: 'gemini', toolId: 'tool-1', summary: 'Tests passed' }),
    });
    expect(toolFinished.content).toBe('Tool call finished: bash npm test');
    expect(toolFinished.emphasis).toBe('success');

    const legacyToolResult = formatLogEventDisplay({
      id: 5,
      type: 'info',
      timestamp: 1,
      data: 'Gemini tool result: Tests passed',
    });
    expect(legacyToolResult.content).toBe('Tool call finished');
    expect(legacyToolResult.emphasis).toBe('success');
  });

  it('counts only real error events instead of matching generic diff text', () => {
    const events: LogEvent[] = [
      {
        id: 1,
        type: 'info',
        timestamp: 1,
        data: JSON.stringify({
          method: 'turn/diff/updated',
          params: {
            diff: 'diff --git a/file.ts b/file.ts\n+ failedTransition: true',
          },
        }),
      },
      {
        id: 2,
        type: 'info',
        timestamp: 2,
        data: JSON.stringify({
          method: 'item/completed',
          params: {
            item: {
              type: 'commandExecution',
              id: 'call-1',
              status: 'failed',
              command: 'npm test',
            },
          },
        }),
      },
      { id: 3, type: 'stderr', data: 'real stderr', timestamp: 3 },
    ];

    expect(countErrorEvents(condenseLogEvents(events))).toBe(2);
  });

  it('keeps auto-scroll enabled during programmatic scroll-to-bottom updates', () => {
    expect(shouldDisableAutoScroll(1000, 850, 100, true, true)).toBe(false);
    expect(shouldDisableAutoScroll(1000, 750, 100, true, false)).toBe(true);
    expect(shouldDisableAutoScroll(1000, 905, 100, true, false)).toBe(false);
  });
});
