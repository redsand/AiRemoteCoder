import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { db } from '../services/database.js';
import { config } from '../config.js';
import { nanoid } from 'nanoid';

export interface AuthenticatedRequest extends FastifyRequest {
  user?: {
    id: string;
    username: string;
    role: 'admin' | 'operator' | 'viewer';
    source: 'cloudflare' | 'session';
  };
  deviceId?: string;
}

const DEVICE_COOKIE_NAME = 'airc_device_id';
const DEVICE_ID_REGEX = /^dev_[A-Za-z0-9_-]{16,64}$/;

function resolveTrustedDeviceId(
  request: AuthenticatedRequest,
  reply: FastifyReply
): string {
  const rawCookieValue = request.cookies?.[DEVICE_COOKIE_NAME];
  const unsignCookie = (request as any).unsignCookie as ((value: string) => { valid: boolean; value: string }) | undefined;

  if (rawCookieValue && typeof rawCookieValue === 'string' && unsignCookie) {
    const parsed = unsignCookie(rawCookieValue);
    if (parsed?.valid && DEVICE_ID_REGEX.test(parsed.value)) {
      return parsed.value;
    }
  }

  const generated = `dev_${nanoid(24)}`;
  reply.setCookie(DEVICE_COOKIE_NAME, generated, {
    signed: true,
    httpOnly: true,
    secure: config.tlsEnabled,
    sameSite: 'strict',
    maxAge: 365 * 24 * 60 * 60,
    path: '/',
  });
  return generated;
}

/**
 * UI authentication middleware
 * Supports Cloudflare Access and local session auth
 */
export async function uiAuth(
  request: AuthenticatedRequest,
  reply: FastifyReply
): Promise<void> {
  // Check Cloudflare Access headers first
  const cfEmail = request.headers['cf-access-authenticated-user-email'] as string;
  const cfJwt = request.headers['cf-access-jwt-assertion'] as string;

  if (config.cfAccessTeam && cfEmail && cfJwt) {
    // In production, verify the JWT against Cloudflare's keys
    // For now, trust the headers if CF team is configured
    request.user = {
      id: `cf:${cfEmail}`,
      username: cfEmail,
      role: 'operator', // Could be configured per-user
      source: 'cloudflare'
    };
    request.deviceId = resolveTrustedDeviceId(request, reply);
    return;
  }

  // Fall back to session auth
  const sessionToken = request.cookies?.session ||
    (request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : null);

  if (!sessionToken) {
    reply.code(401).send({ error: 'Authentication required' });
    return;
  }

  const session = db.prepare(`
    SELECT s.*, u.username, u.role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > unixepoch()
  `).get(sessionToken) as any;

  if (!session) {
    reply.code(401).send({ error: 'Invalid or expired session' });
    return;
  }

  request.user = {
    id: session.user_id,
    username: session.username,
    role: session.role,
    source: 'session'
  };
  request.deviceId = resolveTrustedDeviceId(request, reply);
}

/**
 * Require specific role
 */
export function requireRole(...roles: string[]) {
  return async (request: AuthenticatedRequest, reply: FastifyReply) => {
    if (!request.user) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }

    if (!roles.includes(request.user.role)) {
      reply.code(403).send({ error: 'Insufficient permissions' });
      return;
    }
  };
}

/**
 * Audit log helper
 */
export function logAudit(
  userId: string | undefined,
  action: string,
  targetType?: string,
  targetId?: string,
  details?: object,
  ipAddress?: string
): void {
  db.prepare(`
    INSERT INTO audit_log (user_id, action, target_type, target_id, details, ip_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    userId || null,
    action,
    targetType || null,
    targetId || null,
    details ? JSON.stringify(details) : null,
    ipAddress || null
  );
}

