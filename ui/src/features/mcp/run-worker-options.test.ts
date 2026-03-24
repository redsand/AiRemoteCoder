import { describe, expect, it } from 'vitest';
import { isMcpSessionFresh } from './run-worker-options';

describe('isMcpSessionFresh', () => {
  it('returns true for a recent session heartbeat', () => {
    const fresh = isMcpSessionFresh(
      {
        id: 's1',
        user: { id: 'u1', username: 'alice', role: 'admin' },
        provider: 'codex',
        tokenLabel: 'auto:codex',
        createdAt: 1,
        lastSeenAt: 1000,
        scopes: [],
      },
      1020,
      45
    );
    expect(fresh).toBe(true);
  });

  it('returns false when session heartbeat is stale', () => {
    const stale = isMcpSessionFresh(
      {
        id: 's1',
        user: { id: 'u1', username: 'alice', role: 'admin' },
        provider: 'codex',
        tokenLabel: 'auto:codex',
        createdAt: 1,
        lastSeenAt: 1000,
        scopes: [],
      },
      1100,
      45
    );
    expect(stale).toBe(false);
  });

  it('returns false for missing session', () => {
    expect(isMcpSessionFresh(undefined, 1100, 45)).toBe(false);
  });
});
