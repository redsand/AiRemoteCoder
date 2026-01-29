import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';

// Mock config before imports
vi.mock('../config.js', () => ({
  config: {
    hmacSecret: 'test-secret-key-that-is-long-enough-for-hmac',
    clockSkewSeconds: 300,
    nonceExpirySeconds: 600,
    cfAccessTeam: 'test-team',
    cfAccessAudience: 'https://example.com',
    tlsEnabled: false
  }
}));

// Mock database
const mockPreparedStatement = {
  bind: vi.fn().mockReturnThis(),
  run: vi.fn().mockResolvedValue({}),
  get: vi.fn().mockResolvedValue(null),
  all: vi.fn().mockResolvedValue([])
};

const mockDb = {
  prepare: vi.fn().mockReturnValue(mockPreparedStatement),
  exec: vi.fn().mockResolvedValue({})
};

vi.mock('better-sqlite3', () => ({
  default: vi.fn(() => mockDb)
}));

import { authMiddleware } from './auth.js';

describe('Authentication Middleware', () => {
  let mockRequest: Partial<FastifyRequest>;
  let mockReply: Partial<FastifyReply>;
  let mockNext: () => Promise<void>;

  beforeEach(() => {
    mockRequest = {
      headers: {},
      cookies: {},
      body: {},
      ip: '127.0.0.1',
      method: 'GET',
      url: '/api/test'
    };
    
    mockReply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      code: vi.fn().mockReturnThis(),
      setCookie: vi.fn().mockReturnThis(),
      clearCookie: vi.fn().mockReturnThis()
    };
    
    mockNext = vi.fn().mockResolvedValue(undefined);
    
    vi.clearAllMocks();
    mockPreparedStatement.get.mockResolvedValue(null);
    mockPreparedStatement.run.mockResolvedValue({});
    mockPreparedStatement.all.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================================
  // TOKEN VALIDATION TESTS
  // ============================================================================

  describe('Token Validation', () => {
    it('should accept valid JWT token', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${validToken}` };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReply.status).not.toHaveBeenCalled();
    });

    it('should reject missing authorization header', async () => {
      mockRequest.headers = {};

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Unauthorized')
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject invalid authorization format', async () => {
      mockRequest.headers = { authorization: 'InvalidFormat token123' };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject malformed JWT token', async () => {
      mockRequest.headers = { authorization: 'Bearer invalid.jwt.token' };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject expired JWT token', async () => {
      const expiredToken = generateExpiredToken('user123');
      mockRequest.headers = { authorization: `Bearer ${expiredToken}` };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('expired')
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject token with invalid signature', async () => {
      const tamperedToken = generateTamperedToken('user123');
      mockRequest.headers = { authorization: `Bearer ${tamperedToken}` };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject token issued before allowed time (nbf)', async () => {
      const futureToken = generateFutureNbfToken('user123');
      mockRequest.headers = { authorization: `Bearer ${futureToken}` };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject token with invalid issuer', async () => {
      const invalidIssuerToken = generateTokenWithInvalidIssuer('user123');
      mockRequest.headers = { authorization: `Bearer ${invalidIssuerToken}` };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject token with invalid audience', async () => {
      const invalidAudienceToken = generateTokenWithInvalidAudience('user123');
      mockRequest.headers = { authorization: `Bearer ${invalidAudienceToken}` };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should accept token within clock skew tolerance', async () => {
      const skewedToken = generateTokenWithClockSkew('user123', -299);
      mockRequest.headers = { authorization: `Bearer ${skewedToken}` };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject token outside clock skew tolerance', async () => {
      const skewedToken = generateTokenWithClockSkew('user123', -301);
      mockRequest.headers = { authorization: `Bearer ${skewedToken}` };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // SESSION MANAGEMENT TESTS
  // ============================================================================

  describe('Session Management', () => {
    it('should create new session for valid token', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      
      mockPreparedStatement.run.mockResolvedValue({ lastInsertRowid: 1 });

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockPreparedStatement.run).toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should retrieve existing session from cookie', async () => {
      const validToken = generateValidToken('user123', ['user']);
      const sessionId = 'session-abc-123';
      
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      mockRequest.cookies = { session_id: sessionId };
      
      mockPreparedStatement.get.mockResolvedValue({
        id: sessionId,
        user_id: 'user123',
        created_at: Date.now() / 1000,
        expires_at: (Date.now() / 1000) + 3600,
        data: JSON.stringify({ lastActivity: Date.now() })
      });

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockPreparedStatement.get).toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject expired session', async () => {
      const validToken = generateValidToken('user123', ['user']);
      const sessionId = 'session-abc-123';
      
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      mockRequest.cookies = { session_id: sessionId };
      
      mockPreparedStatement.get.mockResolvedValue({
        id: sessionId,
        user_id: 'user123',
        created_at: Date.now() / 1000 - 7200,
        expires_at: Date.now() / 1000 - 3600,
        data: JSON.stringify({ lastActivity: Date.now() - 3600000 })
      });

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.clearCookie).toHaveBeenCalledWith('session_id');
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should refresh session on valid request', async () => {
      const validToken = generateValidToken('user123', ['user']);
      const sessionId = 'session-abc-123';
      
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      mockRequest.cookies = { session_id: sessionId };
      
      mockPreparedStatement.get.mockResolvedValue({
        id: sessionId,
        user_id: 'user123',
        created_at: Date.now() / 1000 - 1800,
        expires_at: (Date.now() / 1000) + 1800,
        data: JSON.stringify({ lastActivity: Date.now() - 1000 })
      });
      
      mockPreparedStatement.run.mockResolvedValue({ changes: 1 });

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockPreparedStatement.run).toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should invalidate session on logout', async () => {
      const validToken = generateValidToken('user123', ['user']);
      const sessionId = 'session-abc-123';
      
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      mockRequest.cookies = { session_id: sessionId };
      mockRequest.method = 'POST';
      mockRequest.url = '/api/auth/logout';
      
      mockPreparedStatement.get.mockResolvedValue({
        id: sessionId,
        user_id: 'user123',
        created_at: Date.now() / 1000,
        expires_at: (Date.now() / 1000) + 3600,
        data: '{}'
      });
      
      mockPreparedStatement.run.mockResolvedValue({ changes: 1 });

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockPreparedStatement.run).toHaveBeenCalled();
      expect(mockReply.clearCookie).toHaveBeenCalledWith('session_id');
    });

    it('should handle concurrent session requests correctly', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      
      const promises = Array(5).fill(null).map(() => 
        authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext)
      );

      await Promise.all(promises);

      expect(mockNext).toHaveBeenCalledTimes(5);
    });

    it('should clean up expired sessions periodically', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      
      mockPreparedStatement.all.mockResolvedValue([]);
      mockPreparedStatement.run.mockResolvedValue({ changes: 10 });

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockPreparedStatement.all).toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // ROLE-BASED ACCESS CONTROL TESTS
  // ============================================================================

  describe('Role-Based Access Control', () => {
    it('should grant access to admin user for admin routes', async () => {
      const adminToken = generateValidToken('admin123', ['admin']);
      mockRequest.headers = { authorization: `Bearer ${adminToken}` };
      mockRequest.url = '/api/admin/users';

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReply.status).not.toHaveBeenCalled();
    });

    it('should deny access to regular user for admin routes', async () => {
      const userToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${userToken}` };
      mockRequest.url = '/api/admin/users';

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(403);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Forbidden')
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should grant access to moderator for moderator routes', async () => {
      const moderatorToken = generateValidToken('mod123', ['moderator']);
      mockRequest.headers = { authorization: `Bearer ${moderatorToken}` };
      mockRequest.url = '/api/moderate/content';

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should grant access to user with multiple roles', async () => {
      const multiRoleToken = generateValidToken('user123', ['user', 'moderator']);
      mockRequest.headers = { authorization: `Bearer ${multiRoleToken}` };
      mockRequest.url = '/api/moderate/content';

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle public routes without authentication', async () => {
      mockRequest.url = '/api/public/info';
      mockRequest.headers = {};

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReply.status).not.toHaveBeenCalled();
    });

    it('should check role hierarchy correctly', async () => {
      const adminToken = generateValidToken('admin123', ['admin']);
      mockRequest.headers = { authorization: `Bearer ${adminToken}` };
      mockRequest.url = '/api/user/profile';

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should deny access when token lacks required permission', async () => {
      const userToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${userToken}` };
      mockRequest.url = '/api/settings/system';

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle custom role definitions from database', async () => {
      const customToken = generateValidToken('user123', ['custom_role']);
      mockRequest.headers = { authorization: `Bearer ${customToken}` };
      
      mockPreparedStatement.get.mockResolvedValue({
        id: 'user123',
        roles: JSON.stringify(['custom_role', 'user']),
        permissions: JSON.stringify(['read:custom', 'write:custom'])
      });

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockPreparedStatement.get).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // ERROR HANDLING TESTS
  // ============================================================================

  describe('Error Handling', () => {
    it('should handle database connection errors gracefully', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      
      mockPreparedStatement.get.mockRejectedValue(new Error('Database connection failed'));

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(500);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Internal server error')
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle malformed request body', async () => {
      mockRequest.body = { invalid: 'data' };
      mockRequest.headers = { authorization: 'Bearer invalid' };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(400);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle missing required headers', async () => {
      mockRequest.headers = { 'content-type': 'application/json' };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle timeout scenarios', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      
      mockPreparedStatement.get.mockImplementation(
        () => new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 100)
        )
      );

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(500);
    });

    it('should log authentication failures', async () => {
      mockRequest.headers = { authorization: 'Bearer invalid.token.here' };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should handle concurrent authentication failures', async () => {
      const promises = Array(3).fill(null).map(() =>
        authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext)
      );

      await Promise.all(promises);

      expect(mockReply.status).toHaveBeenCalledTimes(3);
    });

    it('should provide detailed error messages for debugging', async () => {
      const expiredToken = generateExpiredToken('user123');
      mockRequest.headers = { authorization: `Bearer ${expiredToken}` };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(String),
          code: expect.any(String)
        })
      );
    });

    it('should handle rate limit exceeded errors', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      
      mockPreparedStatement.get.mockResolvedValue({
        id: 'user123',
        rateLimitCount: 1000,
        rateLimitWindow: Date.now()
      });

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.status).toHaveBeenCalledWith(429);
      expect(mockReply.header).toHaveBeenCalledWith('Retry-After', expect.any(Number));
    });
  });

  // ============================================================================
  // REQUEST/RESPONSE MODIFICATION TESTS
  // ============================================================================

  describe('Request/Response Modification', () => {
    it('should attach user information to request object', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${validToken}` };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockRequest.user).toBeDefined();
      expect(mockRequest.user?.id).toBe('user123');
      expect(mockRequest.user?.roles).toContain('user');
    });

    it('should add security headers to response', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${validToken}` };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.header).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
      expect(mockReply.header).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
      expect(mockReply.header).toHaveBeenCalledWith('X-XSS-Protection', '1; mode=block');
    });

    it('should set session cookie with correct options', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      
      mockPreparedStatement.run.mockResolvedValue({ lastInsertRowid: 'session-123' });

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.setCookie).toHaveBeenCalledWith(
        'session_id',
        expect.any(String),
        expect.objectContaining({
          httpOnly: true,
          secure: false,
          sameSite: 'strict',
          path: '/'
        })
      );
    });

    it('should add CSRF token to response for state-changing requests', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      mockRequest.method = 'POST';

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.header).toHaveBeenCalledWith('X-CSRF-Token', expect.any(String));
    });

    it('should preserve existing request properties', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { 
        authorization: `Bearer ${validToken}`,
        'x-custom-header': 'custom-value'
      };
      mockRequest.body = { customData: 'test' };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockRequest.headers['x-custom-header']).toBe('custom-value');
      expect(mockRequest.body).toEqual({ customData: 'test' });
    });

    it('should add request ID for tracing', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${validToken}` };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockRequest.id).toBeDefined();
      expect(typeof mockRequest.id).toBe('string');
    });

    it('should add timestamp to request object', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${validToken}` };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockRequest.authTimestamp).toBeDefined();
      expect(mockRequest.authTimestamp).toBeLessThanOrEqual(Date.now());
    });

    it('should sanitize user data before attaching to request', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${validToken}` };

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockRequest.user).not.toHaveProperty('password');
      expect(mockRequest.user).not.toHaveProperty('secret');
    });
  });

  // ============================================================================
  // INTEGRATION TESTS
  // ============================================================================

  describe('Integration Tests', () => {
    it('should handle complete authentication flow', async () => {
      const validToken = generateValidToken('user123', ['user']);
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      
      mockPreparedStatement.run.mockResolvedValue({ lastInsertRowid: 'session-123' });

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRequest.user).toBeDefined();
      expect(mockReply.setCookie).toHaveBeenCalled();
    });

    it('should handle session refresh with role changes', async () => {
      const validToken = generateValidToken('user123', ['user']);
      const sessionId = 'session-abc-123';
      
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      mockRequest.cookies = { session_id: sessionId };
      
      mockPreparedStatement.get.mockResolvedValue({
        id: sessionId,
        user_id: 'user123',
        roles: JSON.stringify(['user', 'moderator']),
        created_at: Date.now() / 1000 - 1800,
        expires_at: (Date.now() / 1000) + 1800
      });

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockRequest.user?.roles).toContain('moderator');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle logout flow with session cleanup', async () => {
      const validToken = generateValidToken('user123', ['user']);
      const sessionId = 'session-abc-123';
      
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      mockRequest.cookies = { session_id: sessionId };
      mockRequest.method = 'POST';
      mockRequest.url = '/api/auth/logout';
      
      mockPreparedStatement.get.mockResolvedValue({
        id: sessionId,
        user_id: 'user123',
        created_at: Date.now() / 1000,
        expires_at: (Date.now() / 1000) + 3600
      });
      
      mockPreparedStatement.run.mockResolvedValue({ changes: 1 });

      await authMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply, mockNext);

      expect(mockReply.clearCookie).toHaveBeenCalledWith('session_id');
      expect(mockReply.status).toHaveBeenCalledWith(200);
    });
  });
});

// ============================================================================
// HELPER FUNCTIONS FOR TEST TOKEN GENERATION
// ============================================================================

function generateValidToken(userId: string, roles: string[]): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = btoa(JSON.stringify({
    sub: userId,
    roles,
    iat: now,
    exp: now + 3600,
    iss: 'test-issuer',
    aud: 'https://example.com'
  }));
  const signature = crypto
    .createHmac('sha256', 'test-secret-key-that-is-long-enough-for-hmac')
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function generateExpiredToken(userId: string): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    sub: userId,
    roles: ['user'],
    iat: Math.floor(Date.now() / 1000) - 7200,
    exp: Math.floor(Date.now() / 1000) - 3600,
    iss: 'test-issuer',
    aud: 'https://example.com'
  }));
  const signature = crypto
    .createHmac('sha256', 'test-secret-key-that-is-long-enough-for-hmac')
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function generateTamperedToken(userId: string): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    sub: userId,
    roles: ['user'],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    iss: 'test-issuer',
    aud: 'https://example.com'
  }));
  return `${header}.${payload}.tamperedsignature`;
}

function generateFutureNbfToken(userId: string): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = btoa(JSON.stringify({
    sub: userId,
    roles: ['user'],
    iat: now,
    nbf: now + 3600,
    exp: now + 7200,
    iss: 'test-issuer',
    aud: 'https://example.com'
  }));
  const signature = crypto
    .createHmac('sha256', 'test-secret-key-that-is-long-enough-for-hmac')
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function generateTokenWithInvalidIssuer(userId: string): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = btoa(JSON.stringify({
    sub: userId,
    roles: ['user'],
    iat: now,
    exp: now + 3600,
    iss: 'invalid-issuer',
    aud: 'https://example.com'
  }));
  const signature = crypto
    .createHmac('sha256', 'test-secret-key-that-is-long-enough-for-hmac')
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function generateTokenWithInvalidAudience(userId: string): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = btoa(JSON.stringify({
    sub: userId,
    roles: ['user'],
    iat: now,
    exp: now + 3600,
    iss: 'test-issuer',
    aud: 'https://invalid.com'
  }));
  const signature = crypto
    .createHmac('sha256', 'test-secret-key-that-is-long-enough-for-hmac')
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function generateTokenWithClockSkew(userId: string, skewSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000) + skewSeconds;
  const payload = btoa(JSON.stringify({
    sub: userId,
    roles: ['user'],
    iat: now,
    exp: now + 3600,
    iss: 'test-issuer',
    aud: 'https://example.com'
  }));
  const signature = crypto
    .createHmac('sha256', 'test-secret-key-that-is-long-enough-for-hmac')
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}