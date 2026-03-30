import { describe, expect, it } from 'vitest';
import { buildRunConnectivitySummary } from './connectivity';

describe('buildRunConnectivitySummary', () => {
  it('separates UI stream, runner host, and detected provider session for agent runs', () => {
    const now = Math.floor(Date.now() / 1000);
    const summary = buildRunConnectivitySummary(
      {
        worker_type: 'claude',
        metadata: { mcpRunnerId: 'tok-1:runner-a' },
      },
      [
        {
          id: 'tok-1:runner-a',
          kind: 'runner',
          provider: 'claude',
          user: { id: 'u1', username: 'tim', role: 'admin' },
          createdAt: now,
          lastSeenAt: now,
          scopes: [],
          projectDir: 'C:\\repo\\hawk',
          projectName: 'hawk',
          runnerId: 'runner-a',
        },
        {
          id: 'session-1',
          kind: 'session',
          provider: 'claude',
          user: { id: 'u1', username: 'tim', role: 'admin' },
          createdAt: now,
          lastSeenAt: now,
          scopes: [],
          projectDir: 'C:\\repo\\hawk',
          projectName: 'hawk',
          runnerId: null,
        },
      ],
      true,
      false
    );

    expect(summary).toEqual([
      expect.objectContaining({ label: 'UI Stream', status: 'connected' }),
      expect.objectContaining({ label: 'Runner Host', status: 'connected' }),
      expect.objectContaining({ label: 'MCP Session', status: 'connected' }),
    ]);
    expect(summary[1]?.detail).toContain('C:\\repo\\hawk');
    expect(summary[2]?.detail).toContain('not pinned');
  });

  it('marks helper-targeted runs disconnected when no runner heartbeat exists', () => {
    const summary = buildRunConnectivitySummary(
      {
        worker_type: 'gemini',
        metadata: { mcpRunnerId: 'tok-1:runner-missing' },
      },
      [],
      false,
      false
    );

    expect(summary).toEqual([
      expect.objectContaining({ label: 'UI Stream', status: 'disconnected' }),
      expect.objectContaining({ label: 'Runner Host', status: 'disconnected' }),
      expect.objectContaining({ label: 'MCP Session', status: 'unknown' }),
    ]);
  });

  it('prefers exact MCP session matching for pinned manual runs', () => {
    const now = Math.floor(Date.now() / 1000);
    const summary = buildRunConnectivitySummary(
      {
        worker_type: 'hands-on',
        metadata: { mcpSessionId: 'session-vnc-1' },
      },
      [
        {
          id: 'session-vnc-1',
          kind: 'session',
          provider: 'codex',
          user: { id: 'u1', username: 'tim', role: 'admin' },
          createdAt: now,
          lastSeenAt: now,
          scopes: [],
          projectDir: 'C:\\repo\\hawk',
          projectName: 'hawk',
          runnerId: null,
        },
      ],
      true,
      false
    );

    expect(summary).toEqual([
      expect.objectContaining({ label: 'UI Stream', status: 'connected' }),
      expect.objectContaining({ label: 'MCP Session', status: 'connected' }),
    ]);
    expect(summary[1]?.detail).toContain('Pinned CODEX session is active');
  });
});
