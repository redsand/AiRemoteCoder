import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { authRoutes } from './auth.js';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import { db } from '../services/database.js';
import { generateTokens, verifyToken } from '../utils/jwt.js';

// Mock dependencies
vi.mock('argon2');
vi.mock('otplib');
vi.mock('../services/database.js');
vi.mock('../utils/jwt.js');

describe('Auth Routes', () => {
  let fastify: any;

  const mockUser = {
    id: '1',
    email: 'test@example.com',
    username: 'testuser',
    passwordHash: 'hashedpassword',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    isTotpEnabled: true,
    isActive: true,
    failedLoginAttempts: 0,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const mockSession = {
    id: 'session-1',
    userId: '1',
    token: 'refresh-token',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
    createdAt: new Date()
  };

  const mockPasswordReset = {
    id: 'reset-1',
    userId: '1',
    token: 'reset-token',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    used: false,
    createdAt: new Date()
  };

  beforeEach(async () => {
    fastify = Fastify();
    await fastify.register(authRoutes);

    // Setup default mocks
    vi.mocked(argon2.verify).mockResolvedValue(true);
    vi.mocked(argon2.hash).mockResolvedValue('new-hashed-password');
    vi.mocked(authenticator.check).mockReturnValue(true);
    vi.mocked(authenticator.generateSecret).mockReturnValue('JBSWY3DPEHPK3PXP');
    vi.mocked(authenticator.generate).mockReturnValue('123456');
    vi.mocked(generateTokens).mockReturnValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 900
    });
    vi.mocked(verifyToken).mockReturnValue({
      userId: '1',
      type: 'access'
    });
  });

  afterEach(async () => {
    await fastify.close();
    vi.clearAllMocks();
  });

  describe('POST /auth/register', () => {
    it('should register a new user successfully', async () => {
      const registerData = {
        email: 'newuser@example.com',
        username: 'newuser',
        password: 'Password123!'
      };

      vi.mocked(db.user.create).mockResolvedValue({
        ...mockUser,
        id: '2',
        email: registerData.email,
        username: registerData.username,
        isTotpEnabled: false
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload: registerData
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('user');
      expect(body.user.email).toBe(registerData.email);
      expect(db.user.create).toHaveBeenCalled();
    });

    it('should fail with duplicate email', async () => {
      const registerData = {
        email: 'test@example.com',
        username: 'newuser',
        password: 'Password123!'
      };

      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload: registerData
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Email already registered');
    });

    it('should fail with invalid email format', async () => {
      const registerData = {
        email: 'invalid-email',
        username: 'newuser',
        password: 'Password123!'
      };

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload: registerData
      });

      expect(response.statusCode).toBe(400);
    });

    it('should fail with weak password', async () => {
      const registerData = {
        email: 'newuser@example.com',
        username: 'newuser',
        password: 'weak'
      };

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload: registerData
      });

      expect(response.statusCode).toBe(400);
    });

    it('should fail with missing required fields', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'test@example.com'
        }
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /auth/login', () => {
    it('should login successfully with valid credentials', async () => {
      const loginData = {
        email: 'test@example.com',
        password: 'Password123!',
        totpCode: '123456'
      };

      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(db.session.create).mockResolvedValue(mockSession);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: loginData
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('accessToken');
      expect(body).toHaveProperty('refreshToken');
      expect(argon2.verify).toHaveBeenCalledWith(mockUser.passwordHash, loginData.password);
      expect(authenticator.check).toHaveBeenCalledWith(loginData.totpCode, mockUser.totpSecret);
    });

    it('should login without TOTP when not enabled', async () => {
      const loginData = {
        email: 'test@example.com',
        password: 'Password123!'
      };

      const userWithoutTotp = { ...mockUser, isTotpEnabled: false };
      vi.mocked(db.user.findUnique).mockResolvedValue(userWithoutTotp);
      vi.mocked(db.session.create).mockResolvedValue(mockSession);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: loginData
      });

      expect(response.statusCode).toBe(200);
    });

    it('should fail with invalid email', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(null);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'nonexistent@example.com',
          password: 'Password123!'
        }
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Invalid credentials');
    });

    it('should fail with invalid password', async () => {
      vi.mocked(argon2.verify).mockResolvedValue(false);
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'test@example.com',
          password: 'WrongPassword123!'
        }
      });

      expect(response.statusCode).toBe(401);
    });

    it('should fail with invalid TOTP code', async () => {
      vi.mocked(authenticator.check).mockReturnValue(false);
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'test@example.com',
          password: 'Password123!',
          totpCode: '000000'
        }
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Invalid TOTP code');
    });

    it('should lock account after too many failed attempts', async () => {
      const lockedUser = { ...mockUser, failedLoginAttempts: 5 };
      vi.mocked(db.user.findUnique).mockResolvedValue(lockedUser);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'test@example.com',
          password: 'Password123!'
        }
      });

      expect(response.statusCode).toBe(423);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Account locked');
    });

    it('should fail with inactive account', async () => {
      const inactiveUser = { ...mockUser, isActive: false };
      vi.mocked(db.user.findUnique).mockResolvedValue(inactiveUser);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'test@example.com',
          password: 'Password123!'
        }
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Account inactive');
    });

    it('should track failed login attempts', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(argon2.verify).mockResolvedValue(false);
      vi.mocked(db.user.update).mockResolvedValue(mockUser);

      await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'test@example.com',
          password: 'WrongPassword123!'
        }
      });

      expect(db.user.update).toHaveBeenCalled();
    });
  });

  describe('POST /auth/logout', () => {
    it('should logout successfully', async () => {
      vi.mocked(db.session.delete).mockResolvedValue(mockSession);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: {
          authorization: 'Bearer access-token',
          cookie: 'refreshToken=refresh-token'
        }
      });

      expect(response.statusCode).toBe(204);
      expect(db.session.delete).toHaveBeenCalled();
    });

    it('should fail without authentication', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/logout'
      });

      expect(response.statusCode).toBe(401);
    });

    it('should handle missing refresh token', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: {
          authorization: 'Bearer access-token'
        }
      });

      expect(response.statusCode).toBe(204);
    });
  });

  describe('POST /auth/refresh', () => {
    it('should refresh tokens successfully', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(mockSession);
      vi.mocked(db.session.update).mockResolvedValue({
        ...mockSession,
        token: 'new-refresh-token'
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: {
          cookie: 'refreshToken=refresh-token'
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('accessToken');
      expect(body).toHaveProperty('refreshToken');
    });

    it('should fail with invalid refresh token', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(null);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: {
          cookie: 'refreshToken=invalid-token'
        }
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Invalid refresh token');
    });

    it('should fail with expired session', async () => {
      const expiredSession = {
        ...mockSession,
        expiresAt: new Date(Date.now() - 1000)
      };
      vi.mocked(db.session.findUnique).mockResolvedValue(expiredSession);
      vi.mocked(db.session.delete).mockResolvedValue(expiredSession);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: {
          cookie: 'refreshToken=refresh-token'
        }
      });

      expect(response.statusCode).toBe(401);
      expect(db.session.delete).toHaveBeenCalled();
    });

    it('should fail without refresh token', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/refresh'
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /auth/forgot-password', () => {
    it('should send password reset email', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(db.passwordReset.create).mockResolvedValue(mockPasswordReset);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: {
          email: 'test@example.com'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(db.passwordReset.create).toHaveBeenCalled();
    });

    it('should not reveal if email exists', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(null);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: {
          email: 'nonexistent@example.com'
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('message');
    });

    it('should fail with missing email', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: {}
      });

      expect(response.statusCode).toBe(400);
    });

    it('should invalidate previous reset tokens', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(db.passwordReset.findMany).mockResolvedValue([mockPasswordReset]);
      vi.mocked(db.passwordReset.updateMany).mockResolvedValue({ count: 1 });
      vi.mocked(db.passwordReset.create).mockResolvedValue(mockPasswordReset);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: {
          email: 'test@example.com'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(db.passwordReset.updateMany).toHaveBeenCalled();
    });
  });

  describe('POST /auth/reset-password', () => {
    it('should reset password successfully', async () => {
      vi.mocked(db.passwordReset.findUnique).mockResolvedValue(mockPasswordReset);
      vi.mocked(db.user.update).mockResolvedValue(mockUser);
      vi.mocked(db.passwordReset.update).mockResolvedValue({
        ...mockPasswordReset,
        used: true
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: {
          token: 'reset-token',
          newPassword: 'NewPassword123!'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(argon2.hash).toHaveBeenCalledWith('NewPassword123!');
      expect(db.user.update).toHaveBeenCalled();
      expect(db.passwordReset.update).toHaveBeenCalled();
    });

    it('should fail with invalid token', async () => {
      vi.mocked(db.passwordReset.findUnique).mockResolvedValue(null);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: {
          token: 'invalid-token',
          newPassword: 'NewPassword123!'
        }
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Invalid or expired reset token');
    });

    it('should fail with expired token', async () => {
      const expiredReset = {
        ...mockPasswordReset,
        expiresAt: new Date(Date.now() - 1000)
      };
      vi.mocked(db.passwordReset.findUnique).mockResolvedValue(expiredReset);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: {
          token: 'reset-token',
          newPassword: 'NewPassword123!'
        }
      });

      expect(response.statusCode).toBe(400);
    });

    it('should fail with already used token', async () => {
      const usedReset = { ...mockPasswordReset, used: true };
      vi.mocked(db.passwordReset.findUnique).mockResolvedValue(usedReset);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: {
          token: 'reset-token',
          newPassword: 'NewPassword123!'
        }
      });

      expect(response.statusCode).toBe(400);
    });

    it('should fail with weak new password', async () => {
      vi.mocked(db.passwordReset.findUnique).mockResolvedValue(mockPasswordReset);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: {
          token: 'reset-token',
          newPassword: 'weak'
        }
      });

      expect(response.statusCode).toBe(400);
    });

    it('should fail with missing token', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: {
          newPassword: 'NewPassword123!'
        }
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /auth/change-password', () => {
    it('should change password successfully', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(db.user.update).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: 'Bearer access-token'
        },
        payload: {
          currentPassword: 'Password123!',
          newPassword: 'NewPassword123!'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(argon2.verify).toHaveBeenCalledWith(mockUser.passwordHash, 'Password123!');
      expect(argon2.hash).toHaveBeenCalledWith('NewPassword123!');
    });

    it('should fail with wrong current password', async () => {
      vi.mocked(argon2.verify).mockResolvedValue(false);
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: 'Bearer access-token'
        },
        payload: {
          currentPassword: 'WrongPassword123!',
          newPassword: 'NewPassword123!'
        }
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Current password is incorrect');
    });

    it('should fail without authentication', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/change-password',
        payload: {
          currentPassword: 'Password123!',
          newPassword: 'NewPassword123!'
        }
      });

      expect(response.statusCode).toBe(401);
    });

    it('should fail with weak new password', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: 'Bearer access-token'
        },
        payload: {
          currentPassword: 'Password123!',
          newPassword: 'weak'
        }
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /auth/totp/enable', () => {
    it('should enable TOTP successfully', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue({
        ...mockUser,
        isTotpEnabled: false
      });
      vi.mocked(db.user.update).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/totp/enable',
        headers: {
          authorization: 'Bearer access-token'
        },
        payload: {
          totpCode: '123456'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: { isTotpEnabled: true }
      });
    });

    it('should return TOTP secret for setup', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue({
        ...mockUser,
        isTotpEnabled: false,
        totpSecret: null
      });
      vi.mocked(db.user.update).mockResolvedValue({
        ...mockUser,
        isTotpEnabled: false,
        totpSecret: 'NEW-SECRET'
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/totp/setup',
        headers: {
          authorization: 'Bearer access-token'
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('secret');
      expect(body).toHaveProperty('qrCode');
    });

    it('should fail with invalid TOTP code', async () => {
      vi.mocked(authenticator.check).mockReturnValue(false);
      vi.mocked(db.user.findUnique).mockResolvedValue({
        ...mockUser,
        isTotpEnabled: false
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/totp/enable',
        headers: {
          authorization: 'Bearer access-token'
        },
        payload: {
          totpCode: '000000'
        }
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error', 'Invalid TOTP code');
    });

    it('should fail if TOTP already enabled', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/totp/enable',
        headers: {
          authorization: 'Bearer access-token'
        },
        payload: {
          totpCode: '123456'
        }
      });

      expect(response.statusCode).toBe(400);
    });

    it('should fail without authentication', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/totp/enable',
        payload: {
          totpCode: '123456'
        }
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /auth/totp/disable', () => {
    it('should disable TOTP successfully', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(db.user.update).mockResolvedValue({
        ...mockUser,
        isTotpEnabled: false,
        totpSecret: null
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/totp/disable',
        headers: {
          authorization: 'Bearer access-token'
        },
        payload: {
          password: 'Password123!'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: { isTotpEnabled: false, totpSecret: null }
      });
    });

    it('should fail with wrong password', async () => {
      vi.mocked(argon2.verify).mockResolvedValue(false);
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/totp/disable',
        headers: {
          authorization: 'Bearer access-token'
        },
        payload: {
          password: 'WrongPassword123!'
        }
      });

      expect(response.statusCode).toBe(401);
    });

    it('should fail without authentication', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/totp/disable',
        payload: {
          password: 'Password123!'
        }
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /auth/sessions', () => {
    it('should list all user sessions', async () => {
      const sessions = [mockSession, { ...mockSession, id: 'session-2' }];
      vi.mocked(db.session.findMany).mockResolvedValue(sessions);

      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/sessions',
        headers: {
          authorization: 'Bearer access-token'
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('sessions');
      expect(body.sessions).toHaveLength(2);
    });

    it('should fail without authentication', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/sessions'
      });

      expect(response.statusCode).toBe(401);
    });

    it('should handle empty sessions list', async () => {
      vi.mocked(db.session.findMany).mockResolvedValue([]);

      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/sessions',
        headers: {
          authorization: 'Bearer access-token'
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.sessions).toHaveLength(0);
    });
  });

  describe('DELETE /auth/sessions/:id', () => {
    it('should delete a specific session', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(mockSession);
      vi.mocked(db.session.delete).mockResolvedValue(mockSession);

      const response = await fastify.inject({
        method: 'DELETE',
        url: '/auth/sessions/session-1',
        headers: {
          authorization: 'Bearer access-token'
        }
      });

      expect(response.statusCode).toBe(204);
      expect(db.session.delete).toHaveBeenCalled();
    });

    it('should fail to delete session from another user', async () => {
      const otherUserSession = { ...mockSession, userId: '2' };
      vi.mocked(db.session.findUnique).mockResolvedValue(otherUserSession);

      const response = await fastify.inject({
        method: 'DELETE',
        url: '/auth/sessions/session-1',
        headers: {
          authorization: 'Bearer access-token'
        }
      });

      expect(response.statusCode).toBe(403);
    });

    it('should fail with non-existent session', async () => {
      vi.mocked(db.session.findUnique).mockResolvedValue(null);

      const response = await fastify.inject({
        method: 'DELETE',
        url: '/auth/sessions/nonexistent',
        headers: {
          authorization: 'Bearer access-token'
        }
      });

      expect(response.statusCode).toBe(404);
    });

    it('should fail without authentication', async () => {
      const response = await fastify.inject({
        method: 'DELETE',
        url: '/auth/sessions/session-1'
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('DELETE /auth/sessions', () => {
    it('should delete all sessions except current', async () => {
      const sessions = [mockSession, { ...mockSession, id: 'session-2' }];
      vi.mocked(db.session.findMany).mockResolvedValue(sessions);
      vi.mocked(db.session.deleteMany).mockResolvedValue({ count: 1 });

      const response = await fastify.inject({
        method: 'DELETE',
        url: '/auth/sessions',
        headers: {
          authorization: 'Bearer access-token',
          cookie: 'refreshToken=refresh-token'
        }
      });

      expect(response.statusCode).toBe(204);
      expect(db.session.deleteMany).toHaveBeenCalled();
    });

    it('should fail without authentication', async () => {
      const response = await fastify.inject({
        method: 'DELETE',
        url: '/auth/sessions'
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /auth/me', () => {
    it('should return current user info', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/me',
        headers: {
          authorization: 'Bearer access-token'
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('user');
      expect(body.user.id).toBe('1');
      expect(body.user.email).toBe('test@example.com');
    });

    it('should not return sensitive data', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);

      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/me',
        headers: {
          authorization: 'Bearer access-token'
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.user).not.toHaveProperty('passwordHash');
      expect(body.user).not.toHaveProperty('totpSecret');
    });

    it('should fail without authentication', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/me'
      });

      expect(response.statusCode).toBe(401);
    });

    it('should handle non-existent user', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(null);

      const response = await fastify.inject({
        method: 'GET',
        url: '/auth/me',
        headers: {
          authorization: 'Bearer access-token'
        }
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', async () => {
      vi.mocked(db.user.findUnique).mockRejectedValue(new Error('Database connection failed'));

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'test@example.com',
          password: 'Password123!'
        }
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('error');
    });

    it('should handle JWT generation errors', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(generateTokens).mockImplementation(() => {
        throw new Error('JWT generation failed');
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'test@example.com',
          password: 'Password123!'
        }
      });

      expect(response.statusCode).toBe(500);
    });

    it('should handle argon2 errors', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(argon2.verify).mockRejectedValue(new Error('Hashing error'));

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'test@example.com',
          password: 'Password123!'
        }
      });

      expect(response.statusCode).toBe(500);
    });

    it('should handle malformed JSON in request body', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        headers: {
          'content-type': 'application/json'
        },
        payload: '{ invalid json }'
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('Rate Limiting', () => {
    it('should enforce rate limits on login endpoint', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(argon2.verify).mockResolvedValue(false);

      const requests = Array(6).fill(null).map(() =>
        fastify.inject({
          method: 'POST',
          url: '/auth/login',
          payload: {
            email: 'test@example.com',
            password: 'WrongPassword123!'
          }
        })
      );

      const responses = await Promise.all(requests);
      const lastResponse = responses[responses.length - 1];

      // Should be rate limited after 5 attempts
      expect(lastResponse.statusCode).toBe(429);
    });

    it('should enforce rate limits on forgot password endpoint', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);

      const requests = Array(6).fill(null).map(() =>
        fastify.inject({
          method: 'POST',
          url: '/auth/forgot-password',
          payload: {
            email: 'test@example.com'
          }
        })
      );

      const responses = await Promise.all(requests);
      const lastResponse = responses[responses.length - 1];

      expect(lastResponse.statusCode).toBe(429);
    });
  });

  describe('Session Security', () => {
    it('should invalidate old session after password change', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(db.session.deleteMany).mockResolvedValue({ count: 5 });

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: 'Bearer access-token'
        },
        payload: {
          currentPassword: 'Password123!',
          newPassword: 'NewPassword123!'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(db.session.deleteMany).toHaveBeenCalled();
    });

    it('should track session IP address and user agent', async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(db.session.create).mockResolvedValue(mockSession);

      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'test@example.com',
          password: 'Password123!'
        },
        headers: {
          'user-agent': 'Test Agent/1.0',
          'x-forwarded-for': '192.168.1.1'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(db.session.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: expect.any(String),
          userAgent: expect.any(String)
        })
      );
    });
  });
});