/**
 * MCP-specific authentication.
 *
 * MCP clients authenticate with a Bearer token distinct from UI session tokens.
 * Tokens are created through the existing auth API and stored in mcp_tokens.
 * Each token carries a set of scopes that control which tools it may invoke.
 */

import { createHash } from 'crypto';
import { db, findMcpToken } from '../services/database.js';
import type { McpScope, UserIdentity } from '../domain/types.js';

export interface McpAuthContext {
  tokenId: string;
  user: UserIdentity;
  scopes: McpScope[];
}

/**
 * Validate a raw Bearer token from an Authorization header.
 * Returns an auth context if valid, null otherwise.
 */
export function validateMcpToken(rawToken: string): McpAuthContext | null {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const record = findMcpToken(tokenHash);
  if (!record) return null;

  // Resolve the owner user's current role
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?')
    .get(record.userId) as { id: string; username: string; role: string } | undefined;

  if (!user) return null;

  return {
    tokenId: record.id,
    user: {
      id: user.id,
      username: user.username,
      role: user.role as UserIdentity['role'],
      source: 'mcp_token',
    },
    scopes: record.scopes as McpScope[],
  };
}

/**
 * Extract Bearer token from an Authorization header value.
 * Returns the raw token string or null if the header is absent/malformed.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
  return match ? match[1] : null;
}

/**
 * Assert that an auth context has all of the required scopes.
 * Returns a descriptive error message if any scope is missing, or null if all present.
 */
export function assertScopes(
  ctx: McpAuthContext,
  required: McpScope[]
): string | null {
  // Admin scope grants everything
  if (ctx.scopes.includes('admin')) return null;

  const missing = required.filter((s) => !ctx.scopes.includes(s));
  if (missing.length === 0) return null;

  return `Insufficient scope. Required: ${required.join(', ')}. Missing: ${missing.join(', ')}.`;
}

/**
 * Re-validate a session-bound request against the bearer token on the request.
 * The session is only valid if the token is still active and matches the token
 * used to open the session.
 */
export function validateMcpSessionAccess(
  sessionAuth: McpAuthContext,
  authHeader: string | undefined
): { ok: true; authContext: McpAuthContext } | { ok: false; statusCode: number; message: string } {
  const rawToken = extractBearerToken(authHeader);
  if (!rawToken) {
    return {
      ok: false,
      statusCode: 401,
      message: 'Unauthorized: valid MCP Bearer token required',
    };
  }

  const authContext = validateMcpToken(rawToken);
  if (!authContext) {
    return {
      ok: false,
      statusCode: 401,
      message: 'Unauthorized: valid MCP Bearer token required',
    };
  }

  if (authContext.tokenId !== sessionAuth.tokenId) {
    return {
      ok: false,
      statusCode: 403,
      message: 'Forbidden: session token does not match the authenticated token',
    };
  }

  return { ok: true, authContext };
}
