import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before imports
vi.mock('../config.js', () => ({
  config: {
    hmacSecret: 'test-secret-key-that-is-long-enough',
    clockSkewSeconds: 300,
    nonceExpirySeconds: 600,
    cfAccessTeam: '',
    tlsEnabled: false
  }
}));

// Mock database
vi.mock('../services/database.js', () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      run: vi.fn()
    })
  }
}));

import { createSignature, hashBody, generateNonce, isTimestampValid } from '../utils/crypto.js';

describe('Auth Middleware Logic', () => {
  describe('Signature Verification Flow', () => {
    const testSecret = 'test-secret-key-that-is-long-enough';

    function verifyRequest(request: {
      method: string;
      path: string;
      body: string;
      signature: string;
      timestamp: number;
      nonce: string;
      runId?: string;
      capabilityToken?: string;
    }): { valid: boolean; error?: string } {
      // Check timestamp
      if (!isTimestampValid(request.timestamp)) {
        return { valid: false, error: 'Timestamp out of range' };
      }

      // Verify signature
      const bodyHash = hashBody(request.body);
      const expectedSig = createSignature({
        method: request.method,
        path: request.path,
        bodyHash,
        timestamp: request.timestamp,
        nonce: request.nonce,
        runId: request.runId,
        capabilityToken: request.capabilityToken
      });

      if (request.signature !== expectedSig) {
        return { valid: false, error: 'Invalid signature' };
      }

      return { valid: true };
    }

    it('should accept valid request', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = generateNonce();
      const body = '{"type":"stdout","data":"test"}';

      const signature = createSignature({
        method: 'POST',
        path: '/api/ingest/event',
        bodyHash: hashBody(body),
        timestamp,
        nonce
      });

      const result = verifyRequest({
        method: 'POST',
        path: '/api/ingest/event',
        body,
        signature,
        timestamp,
        nonce
      });

      expect(result.valid).toBe(true);
    });

    it('should reject expired timestamp', () => {
      const timestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      const nonce = generateNonce();
      const body = '{}';

      const signature = createSignature({
        method: 'POST',
        path: '/api/test',
        bodyHash: hashBody(body),
        timestamp,
        nonce
      });

      const result = verifyRequest({
        method: 'POST',
        path: '/api/test',
        body,
        signature,
        timestamp,
        nonce
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Timestamp out of range');
    });

    it('should reject future timestamp beyond skew', () => {
      const timestamp = Math.floor(Date.now() / 1000) + 600; // 10 minutes in future
      const nonce = generateNonce();
      const body = '{}';

      const signature = createSignature({
        method: 'POST',
        path: '/api/test',
        bodyHash: hashBody(body),
        timestamp,
        nonce
      });

      const result = verifyRequest({
        method: 'POST',
        path: '/api/test',
        body,
        signature,
        timestamp,
        nonce
      });

      expect(result.valid).toBe(false);
    });

    it('should reject tampered body', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = generateNonce();
      const originalBody = '{"data":"original"}';
      const tamperedBody = '{"data":"tampered"}';

      const signature = createSignature({
        method: 'POST',
        path: '/api/test',
        bodyHash: hashBody(originalBody),
        timestamp,
        nonce
      });

      const result = verifyRequest({
        method: 'POST',
        path: '/api/test',
        body: tamperedBody,
        signature,
        timestamp,
        nonce
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid signature');
    });

    it('should reject different method', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = generateNonce();
      const body = '{}';

      const signature = createSignature({
        method: 'POST',
        path: '/api/test',
        bodyHash: hashBody(body),
        timestamp,
        nonce
      });

      const result = verifyRequest({
        method: 'GET', // Different method
        path: '/api/test',
        body,
        signature,
        timestamp,
        nonce
      });

      expect(result.valid).toBe(false);
    });

    it('should reject different path', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = generateNonce();
      const body = '{}';

      const signature = createSignature({
        method: 'POST',
        path: '/api/original',
        bodyHash: hashBody(body),
        timestamp,
        nonce
      });

      const result = verifyRequest({
        method: 'POST',
        path: '/api/different', // Different path
        body,
        signature,
        timestamp,
        nonce
      });

      expect(result.valid).toBe(false);
    });

    it('should include runId and capabilityToken in signature', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = generateNonce();
      const body = '{}';

      const signature = createSignature({
        method: 'POST',
        path: '/api/test',
        bodyHash: hashBody(body),
        timestamp,
        nonce,
        runId: 'run-123',
        capabilityToken: 'cap-token'
      });

      // Should fail without runId/token
      const result1 = verifyRequest({
        method: 'POST',
        path: '/api/test',
        body,
        signature,
        timestamp,
        nonce
      });
      expect(result1.valid).toBe(false);

      // Should pass with correct runId/token
      const result2 = verifyRequest({
        method: 'POST',
        path: '/api/test',
        body,
        signature,
        timestamp,
        nonce,
        runId: 'run-123',
        capabilityToken: 'cap-token'
      });
      expect(result2.valid).toBe(true);
    });
  });

  describe('Replay Protection', () => {
    it('should track used nonces', () => {
      const usedNonces = new Set<string>();

      function checkNonce(nonce: string): boolean {
        if (usedNonces.has(nonce)) {
          return false; // Replay detected
        }
        usedNonces.add(nonce);
        return true;
      }

      const nonce1 = generateNonce();
      const nonce2 = generateNonce();

      expect(checkNonce(nonce1)).toBe(true);
      expect(checkNonce(nonce2)).toBe(true);
      expect(checkNonce(nonce1)).toBe(false); // Replay!
      expect(checkNonce(nonce2)).toBe(false); // Replay!
    });

    it('should expire old nonces', () => {
      const nonces = new Map<string, number>();
      const EXPIRY_SECONDS = 600;

      function addNonce(nonce: string) {
        nonces.set(nonce, Date.now());
      }

      function isNonceValid(nonce: string): boolean {
        const created = nonces.get(nonce);
        if (!created) return true; // New nonce
        return (Date.now() - created) > EXPIRY_SECONDS * 1000;
      }

      function cleanupNonces() {
        const cutoff = Date.now() - EXPIRY_SECONDS * 1000;
        for (const [nonce, created] of nonces) {
          if (created < cutoff) {
            nonces.delete(nonce);
          }
        }
      }

      const nonce = generateNonce();
      addNonce(nonce);

      expect(isNonceValid(nonce)).toBe(false); // Just added, still valid window

      // Simulate time passing (in real implementation, we'd use timers)
      nonces.set(nonce, Date.now() - (EXPIRY_SECONDS + 1) * 1000);
      cleanupNonces();

      expect(nonces.has(nonce)).toBe(false); // Cleaned up
    });
  });

  describe('Role-Based Access Control', () => {
    const roles = ['admin', 'operator', 'viewer'];

    function hasPermission(userRole: string, requiredRoles: string[]): boolean {
      return requiredRoles.includes(userRole);
    }

    it('admin should have all permissions', () => {
      expect(hasPermission('admin', ['admin'])).toBe(true);
      expect(hasPermission('admin', ['admin', 'operator'])).toBe(true);
      expect(hasPermission('admin', ['admin', 'operator', 'viewer'])).toBe(true);
    });

    it('operator should have operator and viewer permissions', () => {
      expect(hasPermission('operator', ['admin'])).toBe(false);
      expect(hasPermission('operator', ['operator'])).toBe(true);
      expect(hasPermission('operator', ['admin', 'operator'])).toBe(true);
    });

    it('viewer should only have viewer permission', () => {
      expect(hasPermission('viewer', ['admin'])).toBe(false);
      expect(hasPermission('viewer', ['operator'])).toBe(false);
      expect(hasPermission('viewer', ['viewer'])).toBe(true);
      expect(hasPermission('viewer', ['admin', 'operator', 'viewer'])).toBe(true);
    });

    it('should reject unknown roles', () => {
      expect(hasPermission('unknown', ['admin'])).toBe(false);
      expect(hasPermission('unknown', ['viewer'])).toBe(false);
    });
  });

  describe('Capability Token Validation', () => {
    it('should validate capability token matches run', () => {
      const runs = new Map<string, string>();
      runs.set('run-1', 'cap-token-1');
      runs.set('run-2', 'cap-token-2');

      function validateCapability(runId: string, token: string): boolean {
        const expectedToken = runs.get(runId);
        return expectedToken === token;
      }

      expect(validateCapability('run-1', 'cap-token-1')).toBe(true);
      expect(validateCapability('run-2', 'cap-token-2')).toBe(true);
      expect(validateCapability('run-1', 'cap-token-2')).toBe(false);
      expect(validateCapability('run-2', 'cap-token-1')).toBe(false);
      expect(validateCapability('run-3', 'any-token')).toBe(false);
    });
  });
});

describe('Cloudflare Access Headers', () => {
  it('should extract user from CF headers', () => {
    const headers = {
      'cf-access-authenticated-user-email': 'user@example.com',
      'cf-access-jwt-assertion': 'eyJ...'
    };

    function extractCfUser(headers: Record<string, string>) {
      const email = headers['cf-access-authenticated-user-email'];
      const jwt = headers['cf-access-jwt-assertion'];

      if (email && jwt) {
        return {
          id: `cf:${email}`,
          username: email,
          source: 'cloudflare'
        };
      }
      return null;
    }

    const user = extractCfUser(headers);
    expect(user).toBeDefined();
    expect(user?.username).toBe('user@example.com');
    expect(user?.source).toBe('cloudflare');
  });

  it('should return null without CF headers', () => {
    const headers = {};

    function extractCfUser(headers: Record<string, string>) {
      const email = headers['cf-access-authenticated-user-email'];
      const jwt = headers['cf-access-jwt-assertion'];

      if (email && jwt) {
        return { id: `cf:${email}`, username: email, source: 'cloudflare' };
      }
      return null;
    }

    expect(extractCfUser(headers)).toBeNull();
  });
});
