import { describe, expect, it } from 'vitest';
import { getMcpProvider, isProductionReadyRunnerProvider, supportsRunnerProvider } from './providers';

describe('MCP provider metadata', () => {
  it('marks codex as the only production-ready runner provider', () => {
    expect(isProductionReadyRunnerProvider('codex')).toBe(true);
    expect(isProductionReadyRunnerProvider('claude')).toBe(false);
    expect(isProductionReadyRunnerProvider('gemini')).toBe(false);
    expect(isProductionReadyRunnerProvider('opencode')).toBe(false);
    expect(isProductionReadyRunnerProvider('zenflow')).toBe(false);
    expect(isProductionReadyRunnerProvider('rev')).toBe(false);
  });

  it('annotates non-codex providers as preview/manual runner support', () => {
    expect(getMcpProvider('codex')?.runnerSupport).toBe('production');
    expect(getMcpProvider('gemini')?.runnerSupport).toBe('preview');
    expect(getMcpProvider('claude')?.runnerSupportNote).toContain('not production-ready');
  });

  it('allows known preview providers to be used for runner testing', () => {
    expect(supportsRunnerProvider('codex')).toBe(true);
    expect(supportsRunnerProvider('claude')).toBe(true);
    expect(supportsRunnerProvider('gemini')).toBe(true);
    expect(supportsRunnerProvider('unknown')).toBe(false);
  });
});
