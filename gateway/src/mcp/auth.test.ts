import { createHash } from 'crypto';
import { describe, it, expect, vi } from 'vitest';
import { validateMcpToken, extractBearerToken, assertScopes, validateMcpSessionAccess } from './auth.js';
import type { McpAuthContext } from './auth.js';
import type { McpScope } from '../domain/types.js';

const validRawToken = 'valid-raw-token';
const validTokenHash = createHash('sha256').update(validRawToken).digest('hex');
const otherRawToken = 'other-raw-token';
const otherTokenHash = createHash('sha256').update(otherRawToken).digest('hex');

vi.mock('../services/database.js', () => ({
  db: {
    prepare: (sql: string) => ({
      get: (arg: string) => {
        // Simulate a valid token lookup
        if (sql.includes('FROM mcp_tokens') && arg === validTokenHash) {
          return { id: 'tok-1', label: 'test', user_id: 'user-1', scopes: '["runs:read","runs:write"]' };
        }
        if (sql.includes('FROM mcp_tokens') && arg === otherTokenHash) {
          return { id: 'tok-2', label: 'other', user_id: 'user-1', scopes: '["runs:read"]' };
        }
        // Simulate user lookup
        if (sql.includes('FROM users') && arg === 'user-1') {
          return { id: 'user-1', username: 'alice', role: 'operator' };
        }
        return undefined;
      },
      run: vi.fn(),
    }),
  },
  findMcpToken: (hash: string) => {
    if (hash === validTokenHash) {
      return { id: 'tok-1', label: 'test', userId: 'user-1', scopes: ['runs:read', 'runs:write'] };
    }
    if (hash === otherTokenHash) {
      return { id: 'tok-2', label: 'other', userId: 'user-1', scopes: ['runs:read'] };
    }
    return undefined;
  },
}));

describe('extractBearerToken', () => {
  it('extracts token from valid header', () => {
    expect(extractBearerToken('Bearer mytoken123')).toBe('mytoken123');
  });

  it('returns null for missing header', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('returns null for non-Bearer scheme', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
  });

  it('returns null for malformed header', () => {
    expect(extractBearerToken('Bearer')).toBeNull();
  });

  it('is case-insensitive on "Bearer"', () => {
    expect(extractBearerToken('bearer mytoken')).toBe('mytoken');
  });
});

describe('assertScopes', () => {
  const ctx: McpAuthContext = {
    tokenId: 'tok-1',
    user: { id: 'u1', username: 'alice', role: 'operator', source: 'mcp_token' },
    scopes: ['runs:read', 'runs:write', 'events:read'],
  };

  it('returns null when all required scopes are present', () => {
    expect(assertScopes(ctx, ['runs:read'])).toBeNull();
    expect(assertScopes(ctx, ['runs:read', 'runs:write'])).toBeNull();
  });

  it('returns error string when scope is missing', () => {
    const err = assertScopes(ctx, ['approvals:decide']);
    expect(err).not.toBeNull();
    expect(err).toMatch(/approvals:decide/);
    expect(err).toMatch(/Missing/);
  });

  it('grants everything to admin scope', () => {
    const adminCtx: McpAuthContext = { ...ctx, scopes: ['admin'] };
    const requiredAll: McpScope[] = ['runs:read', 'runs:write', 'approvals:decide', 'admin'];
    expect(assertScopes(adminCtx, requiredAll)).toBeNull();
  });

  it('returns null for empty required list', () => {
    expect(assertScopes(ctx, [])).toBeNull();
  });
});

describe('validateMcpSessionAccess', () => {
  const sessionAuth: McpAuthContext = {
    tokenId: 'tok-1',
    user: { id: 'u1', username: 'alice', role: 'operator', source: 'mcp_token' },
    scopes: ['runs:read', 'runs:write'],
  };

  it('rejects missing bearer token', () => {
    const result = validateMcpSessionAccess(sessionAuth, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(401);
    }
  });

  it('rejects a mismatched token', () => {
    const result = validateMcpSessionAccess(sessionAuth, `Bearer ${otherRawToken}`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(403);
    }
  });

  it('accepts the same token that opened the session', () => {
    const result = validateMcpSessionAccess(sessionAuth, `Bearer ${validRawToken}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.authContext.tokenId).toBe('tok-1');
    }
  });
});
