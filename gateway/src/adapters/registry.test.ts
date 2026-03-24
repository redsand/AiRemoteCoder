import { describe, it, expect, beforeEach } from 'vitest';
import { AdapterRegistry } from './registry.js';
import type { ProviderAdapter } from './types.js';
import type { AgentCapability, ProviderName } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Minimal stub adapter for testing
// ---------------------------------------------------------------------------

function makeStub(provider: ProviderName): ProviderAdapter {
  return {
    provider,
    startSession: async () => 'session-1',
    attachToSession: async () => {},
    sendUserInput: async () => {},
    interrupt: async () => {},
    checkpoint: async () => null,
    resume: async () => 'session-2',
    applyApprovalDecision: async () => {},
    fetchArtifacts: async () => [],
    terminate: async () => {},
    getCapabilities: (): AgentCapability => ({
      provider,
      supportsInteractiveInput: true,
      supportsResume: false,
      supportsCheckpoint: false,
      supportsApprovalGating: false,
      supportsToolUseEvents: false,
      supportsStreaming: true,
      supportsModelSelection: true,
      nativeMcp: false,
      version: '1.0.0',
    }),
    healthcheck: async () => true,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterRegistry', () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it('starts empty', () => {
    expect(registry.list()).toEqual([]);
  });

  it('registers and retrieves an adapter', () => {
    const adapter = makeStub('claude');
    registry.register(adapter);
    expect(registry.get('claude')).toBe(adapter);
  });

  it('returns undefined for unregistered provider', () => {
    expect(registry.get('codex')).toBeUndefined();
  });

  it('throws for unregistered provider when using getOrThrow', () => {
    expect(() => registry.getOrThrow('gemini')).toThrow('No adapter registered for provider: gemini');
  });

  it('does not throw for registered provider via getOrThrow', () => {
    registry.register(makeStub('gemini'));
    expect(() => registry.getOrThrow('gemini')).not.toThrow();
  });

  it('lists all registered providers', () => {
    registry.register(makeStub('claude'));
    registry.register(makeStub('codex'));
    expect(registry.list()).toContain('claude');
    expect(registry.list()).toContain('codex');
    expect(registry.list()).toHaveLength(2);
  });

  it('reports has() correctly', () => {
    registry.register(makeStub('rev'));
    expect(registry.has('rev')).toBe(true);
    expect(registry.has('opencode')).toBe(false);
  });

  it('overwrites an existing adapter with the same provider name', () => {
    const a1 = makeStub('claude');
    const a2 = makeStub('claude');
    registry.register(a1);
    registry.register(a2);
    expect(registry.get('claude')).toBe(a2);
    expect(registry.list()).toHaveLength(1);
  });
});

