import { describe, expect, it } from 'vitest';
import { getMcpHostSubtitle, getMcpHostTitle } from './host-display';

describe('mcp host display helpers', () => {
  const session = {
    id: 'session-1',
    kind: 'runner' as const,
    provider: 'codex',
    runnerId: 'Ku60iL0vHJaFiGPVng7Wa:y0BjxjNruHjgE3PkzsM-C',
    projectName: 'VisualSynth',
    projectDir: 'C:\\Users\\TimShelton\\source\\repos\\VisualSynth',
    user: { id: 'u1', username: 'tim', role: 'admin' },
    tokenLabel: undefined,
    createdAt: 1,
    lastSeenAt: 2,
    scopes: [],
  };

  it('builds a descriptive host title', () => {
    expect(getMcpHostTitle(session)).toBe('VisualSynth • runner Ku60iL0vHJaFiGPVng7Wa:y0BjxjNruHjgE3PkzsM-C');
  });

  it('builds a descriptive host subtitle', () => {
    expect(getMcpHostSubtitle(session)).toContain('connected');
    expect(getMcpHostSubtitle(session)).toContain('Directory: C:\\Users\\TimShelton\\source\\repos\\VisualSynth');
    expect(getMcpHostSubtitle(session)).toContain('User: tim');
  });
});
