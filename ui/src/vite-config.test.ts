import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('vite config', () => {
  it('binds the dev server to 0.0.0.0', () => {
    expect(config.server?.host).toBe('0.0.0.0');
  });
});
