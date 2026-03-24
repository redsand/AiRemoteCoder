/**
 * @deprecated LegacyWrapperAdapter tests.
 * These tests verify the deprecated compatibility shim behaves correctly
 * until it is removed in the next major release.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LegacyWrapperAdapter } from './legacy-wrapper.js';

vi.mock('../services/database.js', () => ({
  db: {
    prepare: (_sql: string) => ({
      get: (_arg: any) => ({ c: 1 }),
      run: vi.fn(),
      all: (_arg: any) => [],
    }),
  },
}));

describe('LegacyWrapperAdapter (deprecated)', () => {
  let adapter: LegacyWrapperAdapter;

  beforeEach(() => {
    adapter = new LegacyWrapperAdapter();
  });

  it('reports provider name as legacy_wrapper', () => {
    expect(adapter.provider).toBe('legacy_wrapper');
  });

  it('returns a session ID on startSession', async () => {
    const sessionId = await adapter.startSession({
      runId: 'run-1',
      workingDir: '/tmp/workspace',
    });
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);
  });

  it('checkpoint returns null (unsupported)', async () => {
    const sessionId = await adapter.startSession({ runId: 'run-1', workingDir: '/tmp' });
    const ckpt = await adapter.checkpoint(sessionId);
    expect(ckpt).toBeNull();
  });

  it('fetchArtifacts returns empty array for unknown session', async () => {
    const artifacts = await adapter.fetchArtifacts('nonexistent-session');
    expect(artifacts).toEqual([]);
  });

  it('healthcheck returns true when clients are online', async () => {
    const healthy = await adapter.healthcheck();
    expect(healthy).toBe(true);
  });

  it('getCapabilities marks deprecated fields correctly', () => {
    const caps = adapter.getCapabilities();
    expect(caps.provider).toBe('legacy_wrapper');
    expect(caps.supportsApprovalGating).toBe(false);
    expect(caps.nativeMcp).toBe(false);
  });
});
