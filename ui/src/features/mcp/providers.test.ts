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

  it('annotates preview runner providers accurately', () => {
    expect(getMcpProvider('codex')?.runnerSupport).toBe('production');
    expect(getMcpProvider('gemini')?.runnerSupport).toBe('preview');
    expect(getMcpProvider('claude')?.configFile).toBe('.mcp.json');
    expect(getMcpProvider('claude')?.runnerSupportNote).toContain('preview testing');
    expect(getMcpProvider('gemini')?.runnerSupportNote).toContain('Native Gemini CLI execution is supported');
  });

  it('allows known preview providers to be used for runner testing', () => {
    expect(supportsRunnerProvider('codex')).toBe(true);
    expect(supportsRunnerProvider('claude')).toBe(true);
    expect(supportsRunnerProvider('gemini')).toBe(true);
    expect(supportsRunnerProvider('unknown')).toBe(false);
  });
});
