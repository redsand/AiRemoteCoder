import { describe, expect, it, vi } from 'vitest';
import { loadAllRunEvents } from './event-replay';

describe('loadAllRunEvents', () => {
  it('replays all event pages until exhausted', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 1, type: 'stdout', data: 'a', timestamp: 1 },
          { id: 2, type: 'stdout', data: 'b', timestamp: 1 },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 3, type: 'stdout', data: 'c', timestamp: 1 },
        ],
      });

    const events = await loadAllRunEvents('run-1', fetchImpl as any, 2);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/api/runs/run-1/events?after=0&limit=2');
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/api/runs/run-1/events?after=2&limit=2');
    expect(events.map((event) => event.id)).toEqual([1, 2, 3]);
  });
});
