import { describe, expect, it } from 'vitest';
import { shouldBypassRateLimit } from './rate-limit.js';

describe('shouldBypassRateLimit', () => {
  it('bypasses MCP worker api routes', () => {
    expect(shouldBypassRateLimit('/api/mcp/runs/run-1/events', '/mcp')).toBe(true);
    expect(shouldBypassRateLimit('/api/mcp/runs/claim', '/mcp')).toBe(true);
  });

  it('does not bypass unrelated api routes', () => {
    expect(shouldBypassRateLimit('/api/runs/run-1', '/mcp')).toBe(false);
  });
});
