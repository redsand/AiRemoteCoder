import { describe, it, expect, beforeAll } from 'vitest';
import {
  createSignature,
  hashBody,
  generateNonce,
  redactSecrets
} from './crypto.js';
import { config } from '../config.js';

// Set a test secret
beforeAll(() => {
  config.hmacSecret = 'test-secret-key-that-is-long-enough-for-testing';
});

describe('Wrapper Crypto', () => {
  describe('Signature Creation', () => {
    it('should create valid HMAC signature', () => {
      const sig = createSignature({
        method: 'POST',
        path: '/api/ingest/event',
        bodyHash: hashBody('test'),
        timestamp: 1234567890,
        nonce: 'test-nonce'
      });

      expect(sig).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should include runId and capabilityToken in signature', () => {
      const sig1 = createSignature({
        method: 'POST',
        path: '/api/test',
        bodyHash: hashBody(''),
        timestamp: 1234567890,
        nonce: 'nonce',
        runId: 'run1',
        capabilityToken: 'token1'
      });

      const sig2 = createSignature({
        method: 'POST',
        path: '/api/test',
        bodyHash: hashBody(''),
        timestamp: 1234567890,
        nonce: 'nonce',
        runId: 'run2',
        capabilityToken: 'token1'
      });

      expect(sig1).not.toBe(sig2);
    });
  });

  describe('Nonce Generation', () => {
    it('should generate cryptographically random nonces', () => {
      const nonces = [];
      for (let i = 0; i < 100; i++) {
        nonces.push(generateNonce());
      }

      // All unique
      expect(new Set(nonces).size).toBe(100);

      // Proper format
      for (const nonce of nonces) {
        expect(nonce).toMatch(/^[a-f0-9]{32}$/);
      }
    });
  });

  describe('Body Hashing', () => {
    it('should produce SHA-256 hashes', () => {
      const hash = hashBody('test content');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should hash empty string', () => {
      const hash = hashBody('');
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
  });

  describe('Secret Redaction', () => {
    it('should redact common secret patterns', () => {
      const secrets = [
        'export API_KEY=mysecretkey123',
        'password: supersecret',
        'token="auth_token_here"',
        'sk-1234567890abcdefghij',
        'ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        'npm_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
      ];

      for (const secret of secrets) {
        expect(redactSecrets(secret)).toContain('[REDACTED]');
        expect(redactSecrets(secret)).not.toContain('secret');
        expect(redactSecrets(secret)).not.toContain('XXXX');
      }
    });

    it('should not redact normal log output', () => {
      const logs = [
        'Running tests...',
        'Test passed: 42/42',
        'Build completed successfully',
        'Error: file not found'
      ];

      for (const log of logs) {
        expect(redactSecrets(log)).toBe(log);
      }
    });

    it('should handle multiline content', () => {
      const content = `
Starting server...
Loaded config:
  port: 3000
  api_key=secret123
  debug: true
Server started.
`;

      const redacted = redactSecrets(content);
      expect(redacted).toContain('Starting server');
      expect(redacted).toContain('Server started');
      expect(redacted).toContain('[REDACTED]');
      expect(redacted).not.toContain('secret123');
    });
  });
});
