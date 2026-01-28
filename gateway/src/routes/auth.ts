import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import { db } from '../services/database.js';
import { config } from '../config.js';
import { generateSessionToken } from '../utils/crypto.js';
import { uiAuth, logAudit, type AuthenticatedRequest } from '../middleware/auth.js';

// Validation schemas
const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
  totpCode: z.string().length(6).optional()
});

const setupSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(12).max(200),
  enableTotp: z.boolean().optional()
});

const SESSION_DURATION = 24 * 60 * 60; // 24 hours

export async function authRoutes(fastify: FastifyInstance) {
  // Check if initial setup is needed
  fastify.get('/api/auth/status', async () => {
    const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
    const cfEnabled = !!config.cfAccessTeam;

    return {
      setupRequired: userCount === 0 && !cfEnabled,
      cloudflareEnabled: cfEnabled,
      localAuthEnabled: userCount > 0
    };
  });

  // Initial setup - create first admin user
  fastify.post('/api/auth/setup', async (request, reply) => {
    const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
    if (userCount > 0) {
      return reply.code(400).send({ error: 'Setup already completed' });
    }

    const body = setupSchema.parse(request.body);

    // Hash password
    const passwordHash = await argon2.hash(body.password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4
    });

    // Generate TOTP secret if requested
    let totpSecret: string | null = null;
    let totpUri: string | null = null;

    if (body.enableTotp) {
      totpSecret = authenticator.generateSecret();
      totpUri = authenticator.keyuri(body.username, 'AiRemoteCoder', totpSecret);
    }

    const userId = nanoid(12);
    db.prepare(`
      INSERT INTO users (id, username, password_hash, totp_secret, role)
      VALUES (?, ?, ?, ?, 'admin')
    `).run(userId, body.username, passwordHash, totpSecret);

    logAudit(userId, 'user.setup', 'user', userId, { username: body.username }, request.ip);

    return {
      ok: true,
      userId,
      totpUri,
      message: totpSecret
        ? 'Admin user created. Scan the TOTP QR code to enable two-factor authentication.'
        : 'Admin user created.'
    };
  });

  // Login
  fastify.post('/api/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const user = db.prepare(`
      SELECT id, username, password_hash, totp_secret, role
      FROM users WHERE username = ?
    `).get(body.username) as any;

    if (!user) {
      // Prevent timing attacks by still doing hash comparison
      await argon2.hash('dummy');
      logAudit(null, 'login.failed', 'user', null, { username: body.username, reason: 'user_not_found' }, request.ip);
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // Verify password
    const validPassword = await argon2.verify(user.password_hash, body.password);
    if (!validPassword) {
      logAudit(user.id, 'login.failed', 'user', user.id, { reason: 'invalid_password' }, request.ip);
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // Verify TOTP if enabled
    if (user.totp_secret) {
      if (!body.totpCode) {
        return reply.code(401).send({ error: 'TOTP code required', totpRequired: true });
      }

      const validTotp = authenticator.verify({
        token: body.totpCode,
        secret: user.totp_secret
      });

      if (!validTotp) {
        logAudit(user.id, 'login.failed', 'user', user.id, { reason: 'invalid_totp' }, request.ip);
        return reply.code(401).send({ error: 'Invalid TOTP code' });
      }
    }

    // Create session
    const sessionId = generateSessionToken();
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DURATION;

    db.prepare(`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, ?)
    `).run(sessionId, user.id, expiresAt);

    logAudit(user.id, 'login.success', 'user', user.id, {}, request.ip);

    // Set session cookie
    reply.setCookie('session', sessionId, {
      httpOnly: true,
      secure: config.tlsEnabled,
      sameSite: 'strict',
      maxAge: SESSION_DURATION,
      path: '/'
    });

    return {
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      },
      expiresAt
    };
  });

  // Logout
  fastify.post('/api/auth/logout', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const sessionToken = request.cookies?.session;
    if (sessionToken) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionToken);
      logAudit(request.user?.id, 'logout', 'session', sessionToken, {}, request.ip);
    }

    reply.clearCookie('session');
    return { ok: true };
  });

  // Get current user
  fastify.get('/api/auth/me', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    return {
      user: request.user
    };
  });

  // Refresh session
  fastify.post('/api/auth/refresh', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const oldSessionToken = request.cookies?.session;
    if (!oldSessionToken) {
      return reply.code(401).send({ error: 'No session' });
    }

    // Create new session
    const sessionId = generateSessionToken();
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DURATION;

    db.prepare('DELETE FROM sessions WHERE id = ?').run(oldSessionToken);
    db.prepare(`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, ?)
    `).run(sessionId, request.user!.id, expiresAt);

    reply.setCookie('session', sessionId, {
      httpOnly: true,
      secure: config.tlsEnabled,
      sameSite: 'strict',
      maxAge: SESSION_DURATION,
      path: '/'
    });

    return { ok: true, expiresAt };
  });

  // Add additional user (admin only)
  fastify.post('/api/auth/users', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    if (request.user?.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin required' });
    }

    const body = z.object({
      username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_-]+$/),
      password: z.string().min(12).max(200),
      role: z.enum(['admin', 'operator', 'viewer'])
    }).parse(request.body);

    // Check if username exists
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(body.username);
    if (existing) {
      return reply.code(400).send({ error: 'Username already exists' });
    }

    const passwordHash = await argon2.hash(body.password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4
    });

    const userId = nanoid(12);
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES (?, ?, ?, ?)
    `).run(userId, body.username, passwordHash, body.role);

    logAudit(request.user.id, 'user.create', 'user', userId, { username: body.username, role: body.role }, request.ip);

    return { ok: true, userId };
  });
}
