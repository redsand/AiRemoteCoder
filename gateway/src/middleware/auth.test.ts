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
const mockPreparedStmts = {
  getUserBySession: vi.fn(),
  getUserByWrapperId: vi.fn(),
  getUserByCfId: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getNonce: vi.fn(),
  createNonce: vi.fn(),
  deleteNonce: vi.fn()
};

vi.mock('../db.js', () => ({
  db: {
    prepare: vi.fn(() => mockPreparedStmts)
  }
}));

// Import after mocks
import * as authMiddleware from './auth.js';
import { config } from '../config.js';

describe('Authentication Middleware', () => {
  let mockRequest: Partial<FastifyRequest>;
  let mockReply: Partial<FastifyReply>;

  beforeEach(() => {
    mockRequest = {
      headers: {},
      cookies: {},
      body: {},
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      }
    } as Partial<FastifyRequest>;

    mockReply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      code: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis()
    } as Partial<FastifyReply>;

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Wrapper Authentication', () => {
    it('should authenticate valid wrapper token', async () => {
      const wrapperId = 'wrapper-123';
      const timestamp = Date.now();
      const signature = crypto
        .createHmac('sha256', config.hmacSecret)
        .update(`${wrapperId}:${timestamp}`)
        .digest('hex');

      mockRequest.headers = {
        'x-wrapper-id': wrapperId,
        'x-wrapper-signature': signature,
        'x-wrapper-timestamp': timestamp.toString()
      };

      mockPreparedStmts.getUserByWrapperId.mockResolvedValue({
        id: 'user-1',
        wrapper_id: wrapperId,
        email: 'wrapper@example.com'
      });

      const result = await authMiddleware.authenticateWrapper(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(true);
      expect(mockRequest.user).toBeDefined();
      expect(mockRequest.user.id).toBe('user-1');
    });

    it('should reject wrapper auth with missing headers', async () => {
      mockRequest.headers = {};

      const result = await authMiddleware.authenticateWrapper(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Missing wrapper authentication headers' })
      );
    });

    it('should reject wrapper auth with invalid signature', async () => {
      mockRequest.headers = {
        'x-wrapper-id': 'wrapper-123',
        'x-wrapper-signature': 'invalid-signature',
        'x-wrapper-timestamp': Date.now().toString()
      };

      const result = await authMiddleware.authenticateWrapper(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Invalid wrapper signature' })
      );
    });

    it('should reject wrapper auth with expired timestamp', async () => {
      const wrapperId = 'wrapper-123';
      const expiredTimestamp = Date.now() - (config.clockSkewSeconds + 100) * 1000;
      const signature = crypto
        .createHmac('sha256', config.hmacSecret)
        .update(`${wrapperId}:${expiredTimestamp}`)
        .digest('hex');

      mockRequest.headers = {
        'x-wrapper-id': wrapperId,
        'x-wrapper-signature': signature,
        'x-wrapper-timestamp': expiredTimestamp.toString()
      };

      const result = await authMiddleware.authenticateWrapper(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Timestamp too old' })
      );
    });

    it('should reject wrapper auth when user not found', async () => {
      const wrapperId = 'wrapper-123';
      const timestamp = Date.now();
      const signature = crypto
        .createHmac('sha256', config.hmacSecret)
        .update(`${wrapperId}:${timestamp}`)
        .digest('hex');

      mockRequest.headers = {
        'x-wrapper-id': wrapperId,
        'x-wrapper-signature': signature,
        'x-wrapper-timestamp': timestamp.toString()
      };

      mockPreparedStmts.getUserByWrapperId.mockResolvedValue(undefined);

      const result = await authMiddleware.authenticateWrapper(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Wrapper user not found' })
      );
    });
  });

  describe('Session Authentication', () => {
    it('should authenticate valid session cookie', async () => {
      const sessionId = crypto.randomUUID();
      mockRequest.cookies = {
        session: sessionId
      };

      mockPreparedStmts.getUserBySession.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        session_id: sessionId
      });

      const result = await authMiddleware.authenticateSession(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(true);
      expect(mockRequest.user).toBeDefined();
      expect(mockRequest.user.id).toBe('user-1');
    });

    it('should reject session auth with missing cookie', async () => {
      mockRequest.cookies = {};

      const result = await authMiddleware.authenticateSession(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'No session cookie' })
      );
    });

    it('should reject session auth with invalid session', async () => {
      mockRequest.cookies = {
        session: 'invalid-session-id'
      };

      mockPreparedStmts.getUserBySession.mockResolvedValue(undefined);

      const result = await authMiddleware.authenticateSession(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Invalid session' })
      );
    });

    it('should reject session auth with expired session', async () => {
      const sessionId = crypto.randomUUID();
      mockRequest.cookies = {
        session: sessionId
      };

      mockPreparedStmts.getUserBySession.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        session_id: sessionId,
        expires_at: new Date(Date.now() - 3600000) // Expired 1 hour ago
      });

      const result = await authMiddleware.authenticateSession(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Session expired' })
      );
    });

    it('should handle database errors gracefully', async () => {
      mockRequest.cookies = {
        session: crypto.randomUUID()
      };

      mockPreparedStmts.getUserBySession.mockRejectedValue(new Error('Database error'));

      const result = await authMiddleware.authenticateSession(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(500);
    });
  });

  describe('Cloudflare Access Authentication', () => {
    it('should authenticate valid Cloudflare Access JWT', async () => {
      const cfId = 'cf-user-123';
      const jwtPayload = {
        aud: config.cfAccessAudience,
        email: 'cf@example.com',
        sub: cfId,
        exp: Math.floor(Date.now() / 1000) + 3600
      };

      mockRequest.headers = {
        'cf-access-jwt-assertion': btoa(JSON.stringify(jwtPayload))
      };

      mockPreparedStmts.getUserByCfId.mockResolvedValue({
        id: 'user-1',
        cf_id: cfId,
        email: 'cf@example.com'
      });

      const result = await authMiddleware.authenticateCloudflare(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(true);
      expect(mockRequest.user).toBeDefined();
      expect(mockRequest.user.id).toBe('user-1');
    });

    it('should reject Cloudflare auth with missing JWT', async () => {
      mockRequest.headers = {};

      const result = await authMiddleware.authenticateCloudflare(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Missing Cloudflare Access JWT' })
      );
    });

    it('should reject Cloudflare auth with invalid JWT format', async () => {
      mockRequest.headers = {
        'cf-access-jwt-assertion': 'invalid-jwt'
      };

      const result = await authMiddleware.authenticateCloudflare(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Invalid JWT format' })
      );
    });

    it('should reject Cloudflare auth with wrong audience', async () => {
      const jwtPayload = {
        aud: 'https://wrong-audience.com',
        email: 'cf@example.com',
        sub: 'cf-user-123',
        exp: Math.floor(Date.now() / 1000) + 3600
      };

      mockRequest.headers = {
        'cf-access-jwt-assertion': btoa(JSON.stringify(jwtPayload))
      };

      const result = await authMiddleware.authenticateCloudflare(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Invalid JWT audience' })
      );
    });

    it('should reject Cloudflare auth with expired JWT', async () => {
      const jwtPayload = {
        aud: config.cfAccessAudience,
        email: 'cf@example.com',
        sub: 'cf-user-123',
        exp: Math.floor(Date.now() / 1000) - 3600
      };

      mockRequest.headers = {
        'cf-access-jwt-assertion': btoa(JSON.stringify(jwtPayload))
      };

      const result = await authMiddleware.authenticateCloudflare(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'JWT expired' })
      );
    });

    it('should create new user on first Cloudflare login', async () => {
      const cfId = 'cf-new-user';
      const jwtPayload = {
        aud: config.cfAccessAudience,
        email: 'newuser@example.com',
        sub: cfId,
        exp: Math.floor(Date.now() / 1000) + 3600
      };

      mockRequest.headers = {
        'cf-access-jwt-assertion': btoa(JSON.stringify(jwtPayload))
      };

      mockPreparedStmts.getUserByCfId.mockResolvedValue(undefined);
      mockPreparedStmts.createSession.mockResolvedValue({ session_id: 'new-session' });

      const result = await authMiddleware.authenticateCloudflare(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(true);
      expect(mockPreparedStmts.createSession).toHaveBeenCalled();
    });
  });

  describe('Signature Verification', () => {
    it('should verify valid HMAC signature', async () => {
      const payload = JSON.stringify({ action: 'test', data: 'sample' });
      const signature = crypto
        .createHmac('sha256', config.hmacSecret)
        .update(payload)
        .digest('hex');

      mockRequest.headers = {
        'x-signature': signature
      };
      mockRequest.body = JSON.parse(payload);

      const result = await authMiddleware.verifySignature(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(true);
    });

    it('should reject invalid signature', async () => {
      const payload = JSON.stringify({ action: 'test', data: 'sample' });
      const invalidSignature = 'invalid-signature-here';

      mockRequest.headers = {
        'x-signature': invalidSignature
      };
      mockRequest.body = JSON.parse(payload);

      const result = await authMiddleware.verifySignature(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Invalid signature' })
      );
    });

    it('should reject missing signature', async () => {
      mockRequest.headers = {};
      mockRequest.body = { action: 'test' };

      const result = await authMiddleware.verifySignature(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Missing signature' })
      );
    });

    it('should handle signature with different hash algorithms', async () => {
      const payload = 'test-payload';
      
      // Test SHA256
      const sha256Sig = crypto
        .createHmac('sha256', config.hmacSecret)
        .update(payload)
        .digest('hex');

      mockRequest.headers = {
        'x-signature': sha256Sig,
        'x-signature-algo': 'sha256'
      };
      mockRequest.body = payload;

      let result = await authMiddleware.verifySignature(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );
      expect(result).toBe(true);

      // Test SHA512
      const sha512Sig = crypto
        .createHmac('sha512', config.hmacSecret)
        .update(payload)
        .digest('hex');

      mockRequest.headers = {
        'x-signature': sha512Sig,
        'x-signature-algo': 'sha512'
      };

      result = await authMiddleware.verifySignature(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );
      expect(result).toBe(true);
    });

    it('should verify signature with timestamp and nonce', async () => {
      const nonce = crypto.randomUUID();
      const timestamp = Date.now();
      const payload = JSON.stringify({ action: 'test' });
      const dataToSign = `${nonce}:${timestamp}:${payload}`;
      const signature = crypto
        .createHmac('sha256', config.hmacSecret)
        .update(dataToSign)
        .digest('hex');

      mockRequest.headers = {
        'x-signature': signature,
        'x-nonce': nonce,
        'x-timestamp': timestamp.toString()
      };
      mockRequest.body = JSON.parse(payload);

      mockPreparedStmts.getNonce.mockResolvedValue(undefined);
      mockPreparedStmts.createNonce.mockResolvedValue(undefined);

      const result = await authMiddleware.verifySignature(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(true);
      expect(mockPreparedStmts.createNonce).toHaveBeenCalled();
    });

    it('should reject replayed nonce', async () => {
      const nonce = crypto.randomUUID();
      const timestamp = Date.now();
      const payload = JSON.stringify({ action: 'test' });
      const dataToSign = `${nonce}:${timestamp}:${payload}`;
      const signature = crypto
        .createHmac('sha256', config.hmacSecret)
        .update(dataToSign)
        .digest('hex');

      mockRequest.headers = {
        'x-signature': signature,
        'x-nonce': nonce,
        'x-timestamp': timestamp.toString()
      };
      mockRequest.body = JSON.parse(payload);

      mockPreparedStmts.getNonce.mockResolvedValue({ nonce, created_at: new Date() });

      const result = await authMiddleware.verifySignature(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Nonce already used' })
      );
    });

    it('should reject expired timestamp in signature', async () => {
      const nonce = crypto.randomUUID();
      const expiredTimestamp = Date.now() - (config.clockSkewSeconds + 100) * 1000;
      const payload = JSON.stringify({ action: 'test' });
      const dataToSign = `${nonce}:${expiredTimestamp}:${payload}`;
      const signature = crypto
        .createHmac('sha256', config.hmacSecret)
        .update(dataToSign)
        .digest('hex');

      mockRequest.headers = {
        'x-signature': signature,
        'x-nonce': nonce,
        'x-timestamp': expiredTimestamp.toString()
      };
      mockRequest.body = JSON.parse(payload);

      mockPreparedStmts.getNonce.mockResolvedValue(undefined);

      const result = await authMiddleware.verifySignature(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Timestamp expired' })
      );
    });

    it('should clean up expired nonces', async () => {
      const nonce = crypto.randomUUID();
      const timestamp = Date.now();
      const payload = JSON.stringify({ action: 'test' });
      const dataToSign = `${nonce}:${timestamp}:${payload}`;
      const signature = crypto
        .createHmac('sha256', config.hmacSecret)
        .update(dataToSign)
        .digest('hex');

      mockRequest.headers = {
        'x-signature': signature,
        'x-nonce': nonce,
        'x-timestamp': timestamp.toString()
      };
      mockRequest.body = JSON.parse(payload);

      mockPreparedStmts.getNonce.mockResolvedValue(undefined);
      mockPreparedStmts.deleteNonce.mockResolvedValue(undefined);
      mockPreparedStmts.createNonce.mockResolvedValue(undefined);

      await authMiddleware.verifySignature(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      // Should attempt to clean up old nonces
      expect(mockPreparedStmts.deleteNonce).toHaveBeenCalled();
    });
  });

  describe('Multi-Method Authentication', () => {
    it('should try multiple auth methods in order', async () => {
      // Set up session auth
      const sessionId = crypto.randomUUID();
      mockRequest.cookies = { session: sessionId };
      mockPreparedStmts.getUserBySession.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com'
      });

      const result = await authMiddleware.authenticate(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(true);
      expect(mockRequest.user).toBeDefined();
    });

    it('should fall through to next auth method if first fails', async () => {
      // Session fails, wrapper succeeds
      mockRequest.cookies = { session: 'invalid' };
      mockPreparedStmts.getUserBySession.mockResolvedValue(undefined);

      const wrapperId = 'wrapper-123';
      const timestamp = Date.now();
      const signature = crypto
        .createHmac('sha256', config.hmacSecret)
        .update(`${wrapperId}:${timestamp}`)
        .digest('hex');

      mockRequest.headers = {
        'x-wrapper-id': wrapperId,
        'x-wrapper-signature': signature,
        'x-wrapper-timestamp': timestamp.toString()
      };

      mockPreparedStmts.getUserByWrapperId.mockResolvedValue({
        id: 'user-1',
        wrapper_id: wrapperId
      });

      const result = await authMiddleware.authenticate(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(true);
    });

    it('should fail when all auth methods fail', async () => {
      mockRequest.cookies = {};
      mockRequest.headers = {};
      mockPreparedStmts.getUserBySession.mockResolvedValue(undefined);
      mockPreparedStmts.getUserByWrapperId.mockResolvedValue(undefined);
      mockPreparedStmts.getUserByCfId.mockResolvedValue(undefined);

      const result = await authMiddleware.authenticate(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should skip signature verification for GET requests', async () => {
      mockRequest.method = 'GET';
      mockRequest.cookies = { session: 'valid-session' };
      mockPreparedStmts.getUserBySession.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com'
      });

      const result = await authMiddleware.authenticate(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(true);
    });

    it('should require signature for POST requests', async () => {
      mockRequest.method = 'POST';
      mockRequest.cookies = { session: 'valid-session' };
      mockRequest.headers = {};
      mockRequest.body = { action: 'test' };
      mockPreparedStmts.getUserBySession.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com'
      });

      const result = await authMiddleware.authenticate(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(401);
    });
  });

  describe('Rate Limiting Integration', () => {
    it('should track failed authentication attempts', async () => {
      mockRequest.cookies = { session: 'invalid' };
      mockRequest.ip = '192.168.1.1';
      mockPreparedStmts.getUserBySession.mockResolvedValue(undefined);

      for (let i = 0; i < 5; i++) {
        await authMiddleware.authenticateSession(
          mockRequest as FastifyRequest,
          mockReply as FastifyReply
        );
      }

      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should lock out after too many failed attempts', async () => {
      mockRequest.cookies = { session: 'invalid' };
      mockRequest.ip = '192.168.1.1';
      mockPreparedStmts.getUserBySession.mockResolvedValue(undefined);

      // Simulate rate limit exceeded
      const result = await authMiddleware.checkRateLimit(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(result).toBe(false);
      expect(mockReply.status).toHaveBeenCalledWith(429);
    });
  });

  describe('Security Headers', () => {
    it('should add security headers after successful auth', async () => {
      const sessionId = crypto.randomUUID();
      mockRequest.cookies = { session: sessionId };
      mockPreparedStmts.getUserBySession.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com'
      });

      await authMiddleware.authenticate(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.header).toHaveBeenCalledWith(
        'X-Content-Type-Options',
        'nosniff'
      );
    });

    it('should add CSRF token for state-changing requests', async () => {
      mockRequest.method = 'POST';
      mockRequest.cookies = { session: 'valid-session' };
      mockRequest.headers = {
        'x-signature': crypto
          .createHmac('sha256', config.hmacSecret)
          .update('{"action":"test"}')
          .digest('hex')
      };
      mockRequest.body = { action: 'test' };
      mockPreparedStmts.getUserBySession.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com'
      });

      await authMiddleware.authenticate(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.header).toHaveBeenCalledWith(
        'X-CSRF-Token',
        expect.any(String)
      );
    });
  });

  describe('Token Refresh', () => {
    it('should refresh expiring session', async () => {
      const sessionId = crypto.randomUUID();
      const expiringSession = {
        id: 'user-1',
        email: 'user@example.com',
        session_id: sessionId,
        expires_at: new Date(Date.now() + 300000) // Expires in 5 minutes
      };

      mockRequest.cookies = { session: sessionId };
      mockPreparedStmts.getUserBySession.mockResolvedValue(expiringSession);
      mockPreparedStmts.createSession.mockResolvedValue({
        session_id: 'new-session-id'
      });

      await authMiddleware.authenticateSession(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockPreparedStmts.createSession).toHaveBeenCalled();
      expect(mockReply.header).toHaveBeenCalledWith(
        'Set-Cookie',
        expect.stringContaining('new-session-id')
      );
    });

    it('should not refresh fresh session', async () => {
      const sessionId = crypto.randomUUID();
      const freshSession = {
        id: 'user-1',
        email: 'user@example.com',
        session_id: sessionId,
        expires_at: new Date(Date.now() + 86400000) // Expires in 24 hours
      };

      mockRequest.cookies = { session: sessionId };
      mockPreparedStmts.getUserBySession.mockResolvedValue(freshSession);

      await authMiddleware.authenticateSession(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockPreparedStmts.createSession).not.toHaveBeenCalled();
    });
  });
});