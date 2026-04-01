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
  username: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
  totpCode: z.string().length(6).optional()
});

const HANDLE_USERNAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(254, 'Username must be at most 254 characters')
  .refine(
    (value) => HANDLE_USERNAME_REGEX.test(value) || z.string().email().safeParse(value).success,
    'Username must be a valid email or contain only letters, numbers, dot, underscore, or hyphen'
  );

const setupSchema = z.object({
  username: usernameSchema,
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

    const parsed = setupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid setup payload',
        details: parsed.error.issues,
      });
    }
    const body = parsed.data;

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
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid login payload',
        details: parsed.error.issues,
      });
    }
    const body = parsed.data;

    const user = db.prepare(`
      SELECT id, username, password_hash, totp_secret, role
      FROM users WHERE username = ?
    `).get(body.username) as any;

    if (!user) {
      // Prevent timing attacks by still doing hash comparison
      await argon2.hash('dummy');
      logAudit(undefined, 'login.failed', 'user', undefined, { username: body.username, reason: 'user_not_found' }, request.ip);
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
      user: request.user,
      deviceId: request.deviceId ?? null,
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

    const parsed = z.object({
      username: usernameSchema,
      password: z.string().min(12).max(200),
      role: z.enum(['admin', 'operator', 'viewer'])
    }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid user payload',
        details: parsed.error.issues,
      });
    }
    const body = parsed.data;

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

  // Get current user's API keys (masked)
  fastify.get('/api/auth/me/api-keys', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    const userId = request.user!.id;
    const row = db.prepare(`
      SELECT anthropic_api_key, zencoder_access_code, zencoder_secret_key
      FROM user_preferences WHERE user_id = ?
    `).get(userId) as { anthropic_api_key: string | null; zencoder_access_code: string | null; zencoder_secret_key: string | null } | undefined;

    function mask(v: string | null): string {
      if (!v) return '';
      if (v.length <= 8) return '••••••••';
      return v.slice(0, 4) + '••••' + v.slice(-4);
    }

    return {
      anthropicApiKey: mask(row?.anthropic_api_key ?? null),
      zencoderAccessCode: mask(row?.zencoder_access_code ?? null),
      zencoderSecretKey: mask(row?.zencoder_secret_key ?? null),
      hasAnthropicApiKey: !!(row?.anthropic_api_key),
      hasZencoderAccessCode: !!(row?.zencoder_access_code),
      hasZencoderSecretKey: !!(row?.zencoder_secret_key),
    };
  });

  // Save current user's API keys
  fastify.post('/api/auth/me/api-keys', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    const userId = request.user!.id;
    const body = request.body as Partial<{ anthropicApiKey: string; zencoderAccessCode: string; zencoderSecretKey: string }>;

    db.prepare(`
      INSERT INTO user_preferences (user_id, anthropic_api_key, zencoder_access_code, zencoder_secret_key, updated_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(user_id) DO UPDATE SET
        anthropic_api_key = COALESCE(excluded.anthropic_api_key, user_preferences.anthropic_api_key),
        zencoder_access_code = COALESCE(excluded.zencoder_access_code, user_preferences.zencoder_access_code),
        zencoder_secret_key = COALESCE(excluded.zencoder_secret_key, user_preferences.zencoder_secret_key),
        updated_at = unixepoch()
    `).run(
      userId,
      body.anthropicApiKey ?? null,
      body.zencoderAccessCode ?? null,
      body.zencoderSecretKey ?? null,
    );

    logAudit(userId, 'user.api_keys_updated', 'user', userId, {}, request.ip);
    return { ok: true };
  });

  // Get raw API keys for orchestrator use (server-side only — same user)
  fastify.get('/api/auth/me/api-keys/raw', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest) => {
    const userId = request.user!.id;
    const row = db.prepare(`
      SELECT anthropic_api_key, zencoder_access_code, zencoder_secret_key
      FROM user_preferences WHERE user_id = ?
    `).get(userId) as { anthropic_api_key: string | null; zencoder_access_code: string | null; zencoder_secret_key: string | null } | undefined;
    return {
      anthropicApiKey: row?.anthropic_api_key ?? null,
      zencoderAccessCode: row?.zencoder_access_code ?? null,
      zencoderSecretKey: row?.zencoder_secret_key ?? null,
    };
  });
}
