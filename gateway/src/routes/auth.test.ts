import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { authRoutes } from './auth.js';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import { db } from '../services/database.js';

// Mock dependencies
vi.mock('argon2');
vi.mock('otplib');
vi.mock('../services/database.js');

describe('Auth Routes', () => {
  let fastify: any;

  const mockUser = {
    id: 'user-123',
    username: 'testuser',
    passwordHash: 'hashedpassword123',
    email: 'test@example.com',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    totpEnabled: true,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  const mockSession = {
    id: 'session-123',
    userId: 'user-123',
    token: 'valid-jwt-token',
    refreshToken: 'refresh-token-123',
    expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
    createdAt: new Date(),
    lastAccessedAt: new Date(),
  };

  beforeEach(async () => {
    fastify = Fastify();
    await fastify.register(require('@fastify/cookie'));
    await fastify.register(authRoutes);

    // Reset all mocks
    vi.clearAllMocks();

    // Setup default mock returns
    vi.mocked(argon2.verify).mockResolvedValue(true);
    vi.mocked(argon2.hash).mockResolvedValue('new-hashed-password');
    vi.mocked(authenticator.check).mockReturnValue(true);
    vi.mocked(authenticator.generateSecret).mockReturnValue('NEWSECRET123');
  });

  afterEach(async () => {
    await fastify.close();
  });

  describe('POST /auth/login', () => {
    it('should successfully login with valid credentials and TOTP', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(db.session.create).mockResolvedValue(mockSession);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'testuser',
          password: 'password123',
          totpCode: '123456',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('refreshToken');
      expect(body).toHaveProperty('user');
      expect(body.user.username).toBe('testuser');
      expect(db.session.create).toHaveBeenCalled();
    });

    it('should successfully login without TOTP when not enabled', async () => {
      const userWithoutTotp = { ...mockUser, totpEnabled: false };
      vi.mocked(db.user.findUnique).mockResolvedValue(userWithoutTotp);
      vi.mocked(db.session.create).mockResolvedValue(mockSession);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'testuser',
          password: 'password123',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('token');
      expect(db.session.create).toHaveBeenCalled();
    });

    it('should fail login with invalid username', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(null);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'nonexistent',
          password: 'password123',
          totpCode: '123456',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Invalid credentials');
      expect(db.session.create).not.toHaveBeenCalled();
    });

    it('should fail login with invalid password', async () => {
      vi.mocked(argon2.verify).mockResolvedValue(false);
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'testuser',
          password: 'wrongpassword',
          totpCode: '123456',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Invalid credentials');
      expect(db.session.create).not.toHaveBeenCalled();
    });

    it('should fail login with invalid TOTP code', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(authenticator.check).mockReturnValue(false);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'testuser',
          password: 'password123',
          totpCode: '000000',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Invalid TOTP code');
      expect(db.session.create).not.toHaveBeenCalled();
    });

    it('should fail login with missing required fields', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'testuser',
          // password missing
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error');
    });

    it('should handle database errors during login', async () => {
      vi.mocked(db.user.findUnique).mockRejectedValue(new Error('Database error'));

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'testuser',
          password: 'password123',
          totpCode: '123456',
        },
      });

      expect(response.statusCode).toBe(500);
    });

    it('should set session cookie on successful login', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(db.session.create).mockResolvedValue(mockSession);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'testuser',
          password: 'password123',
          totpCode: '123456',
        },
      });

      expect(response.statusCode).toBe(200);
      const cookies = response.cookies;
      expect(cookies).toBeDefined();
      expect(cookies.some((c: any) => c.name === 'sessionId')).toBe(true);
    });
  });

  describe('POST /auth/logout', () => {
    it('should successfully logout with valid session', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(mockSession);
      vi.mocked(db.session.delete).mockResolvedValue(mockSession);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies: {
          sessionId: 'session-123',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('message', 'Logged out successfully');
      expect(db.session.delete).toHaveBeenCalledWith({
        where: { id: 'session-123' },
      });
    });

    it('should fail logout with invalid session', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(null);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies: {
          sessionId: 'invalid-session',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Invalid session');
      expect(db.session.delete).not.toHaveBeenCalled();
    });

    it('should clear session cookie on logout', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(mockSession);
      vi.mocked(db.session.delete).mockResolvedValue(mockSession);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies: {
          sessionId: 'session-123',
        },
      });

      expect(response.statusCode).toBe(200);
      const cookies = response.cookies;
      expect(cookies).toBeDefined();
      const sessionCookie = cookies.find((c: any) => c.name === 'sessionId');
      expect(sessionCookie).toBeDefined();
      expect(new Date(sessionCookie.expires) < new Date()).toBe(true);
    });

    it('should handle database errors during logout', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(mockSession);
      vi.mocked(db.session.delete).mockRejectedValue(new Error('Database error'));

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies: {
          sessionId: 'session-123',
        },
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('GET /auth/validate', () => {
    it('should validate a valid token', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(mockSession);
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/validate',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('valid', true);
      expect(body).toHaveProperty('user');
      expect(body.user.username).toBe('testuser');
    });

    it('should reject an invalid token', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(null);

      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/validate',
        headers: {
          authorization: 'Bearer invalid-token',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('valid', false);
      expect(body).toHaveProperty('error');
    });

    it('should reject request without authorization header', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/validate',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('valid', false);
    });

    it('should reject expired token', async () => {
      const expiredSession = {
        ...mockSession,
        expiresAt: new Date(Date.now() - 3600000), // 1 hour ago
      };
      vi.mocked(db.session.findUnique).mockResolvedValue(expiredSession);

      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/validate',
        headers: {
          authorization: 'Bearer expired-token',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('valid', false);
      expect(body.error).toContain('expired');
    });

    it('should handle malformed authorization header', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/validate',
        headers: {
          authorization: 'InvalidFormat token',
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /auth/refresh', () => {
    it('should refresh token with valid refresh token', async () => {
      const newSession = {
        ...mockSession,
        token: 'new-jwt-token',
        refreshToken: 'new-refresh-token',
      };
      vi.mocked(db.session.findUnique).mockResolvedValue(mockSession);
      vi.mocked(db.session.update).mockResolvedValue(newSession);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: {
          refreshToken: 'refresh-token-123',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('token', 'new-jwt-token');
      expect(body).toHaveProperty('refreshToken', 'new-refresh-token');
    });

    it('should fail refresh with invalid refresh token', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(null);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: {
          refreshToken: 'invalid-refresh-token',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Invalid refresh token');
    });

    it('should fail refresh with expired refresh token', async () => {
      const expiredSession = {
        ...mockSession,
        expiresAt: new Date(Date.now() - 3600000),
      };
      vi.mocked(db.session.findUnique).mockResolvedValue(expiredSession);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: {
          refreshToken: 'expired-refresh-token',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toContain('expired');
    });

    it('should fail refresh without refresh token in payload', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /auth/session', () => {
    it('should retrieve current session information', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(mockSession);
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/session',
        cookies: {
          sessionId: 'session-123',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('session');
      expect(body).toHaveProperty('user');
      expect(body.user.username).toBe('testuser');
      expect(body.session.id).toBe('session-123');
    });

    it('should return null for non-existent session', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(null);

      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/session',
        cookies: {
          sessionId: 'non-existent',
        },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Session not found');
    });

    it('should update last accessed timestamp on session retrieval', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(mockSession);
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(db.session.update).mockResolvedValue({
        ...mockSession,
        lastAccessedAt: new Date(),
      });

      await fastify.inject({
        method: 'GET',
        url: '/auth/session',
        cookies: {
          sessionId: 'session-123',
        },
      });

      expect(db.session.update).toHaveBeenCalled();
      const updateCall = vi.mocked(db.session.update).mock.calls[0];
      expect(updateCall[0].data).toHaveProperty('lastAccessedAt');
    });
  });

  describe('DELETE /auth/session', () => {
    it('should delete current session', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(mockSession);
      vi.mocked(db.session.delete).mockResolvedValue(mockSession);

      const response = await fastify.inject({
        method: 'DELETE',
        url: '/auth/session',
        cookies: {
          sessionId: 'session-123',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('message', 'Session deleted');
      expect(db.session.delete).toHaveBeenCalledWith({
        where: { id: 'session-123' },
      });
    });

    it('should return 404 for non-existent session', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(null);

      const response = await fastify.inject({
        method: 'DELETE',
        url: '/auth/session',
        cookies: {
          sessionId: 'non-existent',
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /auth/sessions', () => {
    const mockSessions = [
      mockSession,
      {
        ...mockSession,
        id: 'session-456',
        token: 'another-token',
      },
    ];

    it('should retrieve all sessions for user', async () => {
      vi.mocked(db.session.findMany).mockResolvedValue(mockSessions);
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/sessions',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('sessions');
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(body.sessions.length).toBe(2);
    });

    it('should return empty array for user with no sessions', async () => {
      vi.mocked(db.session.findMany).mockResolvedValue([]);

      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/sessions',
        headers: {
          authorization: 'Bearer valid-token',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.sessions).toEqual([]);
    });

    it('should handle database errors when retrieving sessions', async () => {
      vi.mocked(db.session.findMany).mockRejectedValue(new Error('Database error'));

      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/sessions',
        headers: {
          authorization: 'Bearer valid-token',
        },
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('DELETE /auth/sessions/:id', () => {
    it('should delete specific session', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(mockSession);
      vi.mocked(db.session.delete).mockResolvedValue(mockSession);

      const response = await fastify.inject({
        method: 'DELETE',
        url: '/auth/sessions/session-456',
        headers: {
          authorization: 'Bearer valid-token',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(db.session.delete).toHaveBeenCalledWith({
        where: { id: 'session-456' },
      });
    });

    it('should return 404 for non-existent session', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(null);

      const response = await fastify.inject({
        method: 'DELETE',
        url: '/auth/sessions/non-existent',
        headers: {
          authorization: 'Bearer valid-token',
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should prevent deleting other users sessions', async () => {
      const otherUserSession = {
        ...mockSession,
        userId: 'other-user-456',
      };
      vi.mocked(db.session.findUnique).mockResolvedValue(otherUserSession);

      const response = await fastify.inject({
        method: 'DELETE',
        url: '/auth/sessions/session-456',
        headers: {
          authorization: 'Bearer user-123-token',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(db.session.delete).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/register', () => {
    it('should successfully register a new user', async () => {
      const newUser = {
        id: 'user-456',
        username: 'newuser',
        email: 'newuser@example.com',
        passwordHash: 'hashed-password',
        totpEnabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(db.user.findUnique).mockResolvedValue(null);
      vi.mocked(db.user.create).mockResolvedValue(newUser);
      vi.mocked(db.session.create).mockResolvedValue(mockSession);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          username: 'newuser',
          email: 'newuser@example.com',
          password: 'securepassword123',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('user');
      expect(body).toHaveProperty('token');
      expect(body.user.username).toBe('newuser');
      expect(argon2.hash).toHaveBeenCalledWith('securepassword123');
      expect(db.user.create).toHaveBeenCalled();
    });

    it('should fail registration with duplicate username', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          username: 'testuser',
          email: 'different@example.com',
          password: 'password123',
        },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error');
      expect(db.user.create).not.toHaveBeenCalled();
    });

    it('should fail registration with duplicate email', async () => {
      vi.mocked(db.user.findUnique)
        .mockResolvedValueOnce(null) // username check
        .mockResolvedValueOnce(mockUser); // email check

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          username: 'newuser',
          email: 'test@example.com',
          password: 'password123',
        },
      });

      expect(response.statusCode).toBe(409);
      expect(db.user.create).not.toHaveBeenCalled();
    });

    it('should validate password strength', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          username: 'newuser',
          email: 'newuser@example.com',
          password: 'weak', // Too short
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error');
    });

    it('should require all registration fields', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          username: 'newuser',
          // email missing
          password: 'password123',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /auth/totp/enable', () => {
    it('should generate TOTP secret for user', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(db.user.update).mockResolvedValue({
        ...mockUser,
        totpSecret: 'NEWSECRET123',
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/totp/enable',
        headers: {
          authorization: 'Bearer valid-token',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('secret');
      expect(body).toHaveProperty('qrCode');
      expect(authenticator.generateSecret).toHaveBeenCalled();
    });

    it('should fail if TOTP already enabled', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue({
        ...mockUser,
        totpEnabled: true,
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/totp/enable',
        headers: {
          authorization: 'Bearer valid-token',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toContain('already enabled');
    });
  });

  describe('POST /auth/totp/verify', () => {
    it('should verify and enable TOTP with valid code', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue({
        ...mockUser,
        totpEnabled: false,
        totpSecret: 'JBSWY3DPEHPK3PXP',
      });
      vi.mocked(authenticator.check).mockReturnValue(true);
      vi.mocked(db.user.update).mockResolvedValue({
        ...mockUser,
        totpEnabled: true,
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/totp/verify',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          code: '123456',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('message', 'TOTP enabled successfully');
      expect(authenticator.check).toHaveBeenCalledWith('123456', 'JBSWY3DPEHPK3PXP');
    });

    it('should fail verification with invalid code', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(authenticator.check).mockReturnValue(false);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/totp/verify',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          code: '000000',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Invalid TOTP code');
    });
  });

  describe('POST /auth/totp/disable', () => {
    it('should disable TOTP for user', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(db.user.update).mockResolvedValue({
        ...mockUser,
        totpEnabled: false,
        totpSecret: null,
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/totp/disable',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          password: 'password123',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('message', 'TOTP disabled successfully');
    });

    it('should require password to disable TOTP', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/totp/disable',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('should verify password before disabling TOTP', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(argon2.verify).mockResolvedValue(false);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/totp/disable',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          password: 'wrongpassword',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(db.user.update).not.toHaveBeenCalled();
    });
  });

  describe('Session Cleanup', () => {
    it('should clean up expired sessions', async () => {
      const expiredSession = {
        ...mockSession,
        id: 'expired-123',
        expiresAt: new Date(Date.now() - 3600000),
      };

      vi.mocked(db.session.deleteMany).mockResolvedValue({ count: 1 });

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/cleanup',
        headers: {
          authorization: 'Bearer admin-token',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('deletedCount');
    });
  });
});