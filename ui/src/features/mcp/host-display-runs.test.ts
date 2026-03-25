import { describe, expect, it } from 'vitest';
import { getMcpHostSubtitle, getMcpHostTitle } from './host-display';

describe('run host labeling', () => {
  it('produces a recognizable run host label and subtitle', () => {
    const host = {
      id: 'session-1',
      kind: 'runner' as const,
      provider: 'codex',
      tokenLabel: 'auto:codex',
      runnerId: 'Ku60iL0vHJaFiGPVng7Wa:y0BjxjNruHjgE3PkzsM-C',
      projectName: 'VisualSynth',
      projectDir: 'C:\\Users\\TimShelton\\source\\repos\\VisualSynth',
      createdAt: 1,
      lastSeenAt: 2,
      scopes: [],
      user: { id: 'u1', username: 'tim', role: 'admin' },
    };

    expect(getMcpHostTitle(host)).toBe('VisualSynth • runner Ku60iL0vHJaFiGPVng7Wa:y0BjxjNruHjgE3PkzsM-C');
    expect(getMcpHostSubtitle(host)).toBe('connected • Directory: C:\\Users\\TimShelton\\source\\repos\\VisualSynth • User: tim');
  });
});
