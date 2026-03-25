/**
 * Adapter contract compliance tests.
 *
 * Every ProviderAdapter implementation must pass these tests.
 * Add new adapters to the `adapters` array as they are implemented.
 *
 * Add adapters here as they become the production implementation.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ProviderAdapter } from './types.js';
import type { ProviderName } from '../domain/types.js';

vi.mock('../services/database.js', () => ({
  db: {
    prepare: (_sql: string) => ({
      get: (_arg: any) => ({ c: 1 }),
      run: vi.fn(),
      all: () => [],
    }),
  },
}));

// ---------------------------------------------------------------------------
// Import adapters under test
// ---------------------------------------------------------------------------

async function getAdapters(): Promise<Array<{ name: string; adapter: ProviderAdapter }>> {
  return [];
}

// ---------------------------------------------------------------------------
// Contract test suite applied to every adapter
// ---------------------------------------------------------------------------

describe('ProviderAdapter contract', async () => {
  const adapters = await getAdapters();

  it('has no legacy adapter implementations registered', () => {
    expect(adapters).toHaveLength(0);
  });

  for (const { name, adapter } of adapters) {
    describe(name, () => {
      it('has a non-empty provider name', () => {
        expect(typeof adapter.provider).toBe('string');
        expect(adapter.provider.length).toBeGreaterThan(0);
      });

      it('provider is a known ProviderName', () => {
        const known: ProviderName[] = ['claude', 'codex', 'gemini', 'opencode', 'zenflow', 'rev'];
        expect(known).toContain(adapter.provider);
      });

      it('startSession returns a non-empty string session ID', async () => {
        const sessionId = await adapter.startSession({ runId: 'r1', workingDir: '/tmp' });
        expect(typeof sessionId).toBe('string');
        expect(sessionId.length).toBeGreaterThan(0);
      });

      it('checkpoint returns null or a valid Checkpoint object', async () => {
        const sessionId = await adapter.startSession({ runId: 'r1', workingDir: '/tmp' });
        const ckpt = await adapter.checkpoint(sessionId);
        if (ckpt !== null) {
          expect(typeof ckpt.sessionId).toBe('string');
          expect(typeof ckpt.runId).toBe('string');
          expect(typeof ckpt.workingDir).toBe('string');
          expect(typeof ckpt.lastSequence).toBe('number');
          expect(typeof ckpt.createdAt).toBe('number');
        }
      });

      it('fetchArtifacts returns an array', async () => {
        const sessionId = await adapter.startSession({ runId: 'r1', workingDir: '/tmp' });
        const artifacts = await adapter.fetchArtifacts(sessionId);
        expect(Array.isArray(artifacts)).toBe(true);
      });

      it('getCapabilities returns an AgentCapability object', () => {
        const caps = adapter.getCapabilities();
        expect(caps.provider).toBe(adapter.provider);
        expect(typeof caps.supportsInteractiveInput).toBe('boolean');
        expect(typeof caps.supportsResume).toBe('boolean');
        expect(typeof caps.supportsCheckpoint).toBe('boolean');
        expect(typeof caps.supportsApprovalGating).toBe('boolean');
        expect(typeof caps.supportsToolUseEvents).toBe('boolean');
        expect(typeof caps.supportsStreaming).toBe('boolean');
        expect(typeof caps.supportsModelSelection).toBe('boolean');
        expect(typeof caps.nativeMcp).toBe('boolean');
        expect(typeof caps.version).toBe('string');
      });

      it('healthcheck returns a boolean', async () => {
        const result = await adapter.healthcheck();
        expect(typeof result).toBe('boolean');
      });

      it('terminate resolves without throwing for valid session', async () => {
        const sessionId = await adapter.startSession({ runId: 'r1', workingDir: '/tmp' });
        await expect(adapter.terminate(sessionId)).resolves.toBeUndefined();
      });

      it('attachToSession resolves without throwing', async () => {
        const sessionId = await adapter.startSession({ runId: 'r1', workingDir: '/tmp' });
        await expect(adapter.attachToSession(sessionId, () => {})).resolves.toBeUndefined();
      });
    });
  }
});
