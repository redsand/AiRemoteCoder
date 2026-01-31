import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { db } from '../services/database.js';
import { config } from '../config.js';
import { verifySignature, hashBody, isTimestampValid } from '../utils/crypto.js';

export interface AuthenticatedRequest extends FastifyRequest {
  user?: {
    id: string;
    username: string;
    role: 'admin' | 'operator' | 'viewer';
    source: 'cloudflare' | 'session' | 'wrapper';
  };
  runAuth?: {
    runId: string;
    capabilityToken: string;
  };
}

/**
 * Wrapper (agent) authentication middleware
 * Uses HMAC signature with replay protection
 */
export async function wrapperAuth(
  request: AuthenticatedRequest,
  reply: FastifyReply
): Promise<void> {
  const signature = request.headers['x-signature'] as string;
  const timestamp = parseInt(request.headers['x-timestamp'] as string, 10);
  const nonce = request.headers['x-nonce'] as string;
  const runId = request.headers['x-run-id'] as string;
  const capabilityToken = request.headers['x-capability-token'] as string;

  // Validate required headers
  if (!signature || !timestamp || !nonce) {
    reply.code(401).send({ error: 'Missing authentication headers' });
    return;
  }

  // Check timestamp validity (clock skew)
  if (!isTimestampValid(timestamp)) {
    reply.code(401).send({ error: 'Request timestamp out of allowed range' });
    return;
  }

  // Check nonce for replay protection
  const existingNonce = db.prepare('SELECT nonce FROM nonces WHERE nonce = ?').get(nonce);
  if (existingNonce) {
    reply.code(401).send({ error: 'Nonce already used (replay attack detected)' });
    return;
  }

  // Calculate body hash
  const rawBody = (request as any).rawBody || '';
  const contentType = request.headers['content-type'] as string | undefined;
  const isMultipart = contentType?.startsWith('multipart/form-data');
  const bodyHash = isMultipart ? hashBody('') : hashBody(rawBody);

  // Verify signature
  const isValid = verifySignature(signature, {
    method: request.method,
    path: request.url.split('?')[0],
    bodyHash,
    timestamp,
    nonce,
    runId,
    capabilityToken
  });

  if (!isValid) {
    reply.code(401).send({ error: 'Invalid signature' });
    return;
  }

  // Verify capability token if runId provided
  if (runId && capabilityToken) {
    const run = db.prepare('SELECT capability_token FROM runs WHERE id = ?').get(runId) as any;
    if (!run || run.capability_token !== capabilityToken) {
      reply.code(403).send({ error: 'Invalid capability token for run' });
      return;
    }
    request.runAuth = { runId, capabilityToken };
  }

  // Store nonce to prevent replay
  db.prepare('INSERT INTO nonces (nonce) VALUES (?)').run(nonce);

  request.user = {
    id: 'wrapper',
    username: 'wrapper',
    role: 'operator',
    source: 'wrapper'
  };
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

/**
 * Plugin to capture raw body for signature verification
 */
export function rawBodyPlugin(fastify: FastifyInstance) {
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as any).rawBody = body;
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );
}
