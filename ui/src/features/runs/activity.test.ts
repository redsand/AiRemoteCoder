import { describe, expect, it } from 'vitest';
import { summarizeRunActivity } from './activity';

describe('summarizeRunActivity', () => {
  it('reports active tool execution for running codex turns', () => {
    const summary = summarizeRunActivity('running', [
      {
        id: 1,
        type: 'info',
        timestamp: 1,
        data: JSON.stringify({
          method: 'item/started',
          params: { item: { type: 'commandExecution' } },
        }),
      },
    ], 1);

    expect(summary.title).toBe('Codex is executing a tool');
    expect(summary.tone).toBe('info');
  });

  it('reports queued work for pending runs', () => {
    const summary = summarizeRunActivity('pending', [], 1);
    expect(summary.title).toBe('Waiting for runner claim');
    expect(summary.tone).toBe('warning');
  });
});
