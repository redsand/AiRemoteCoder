import { describe, expect, it } from 'vitest';
import { MCP_PROVIDERS } from './providers';

describe('MCP provider metadata', () => {
  it('includes every supported coding environment', () => {
    expect(MCP_PROVIDERS.map((provider) => provider.key)).toEqual([
      'claude',
      'codex',
      'gemini',
      'opencode',
      'zenflow',
      'rev',
    ]);
  });

  it('keeps zenflow in the auto-install matrix', () => {
    expect(MCP_PROVIDERS.some((provider) => provider.key === 'zenflow')).toBe(true);
  });
});
