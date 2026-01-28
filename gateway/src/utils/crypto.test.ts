import { describe, it, expect, beforeAll } from 'vitest';
import {
  createSignature,
  verifySignature,
  hashBody,
  generateNonce,
  generateCapabilityToken,
  isTimestampValid,
  redactSecrets
} from './crypto.js';
import { config } from '../config.js';

// Set a test secret
beforeAll(() => {
  config.hmacSecret = 'test-secret-key-that-is-long-enough-for-testing';
});

describe('HMAC Signature', () => {
  const baseComponents = {
    method: 'POST',
    path: '/api/ingest/event',
    bodyHash: hashBody('{"type":"stdout","data":"test"}'),
    timestamp: Math.floor(Date.now() / 1000),
    nonce: generateNonce(),
    runId: 'test-run-123',
    capabilityToken: 'test-capability-token'
  };

  it('should create consistent signatures', () => {
    const sig1 = createSignature(baseComponents);
    const sig2 = createSignature(baseComponents);
    expect(sig1).toBe(sig2);
  });

  it('should verify valid signatures', () => {
    const signature = createSignature(baseComponents);
    expect(verifySignature(signature, baseComponents)).toBe(true);
  });

  it('should reject invalid signatures', () => {
    expect(verifySignature('invalid-signature', baseComponents)).toBe(false);
  });

  it('should reject tampered method', () => {
    const signature = createSignature(baseComponents);
    const tampered = { ...baseComponents, method: 'GET' };
    expect(verifySignature(signature, tampered)).toBe(false);
  });

  it('should reject tampered path', () => {
    const signature = createSignature(baseComponents);
    const tampered = { ...baseComponents, path: '/api/other' };
    expect(verifySignature(signature, tampered)).toBe(false);
  });

  it('should reject tampered body', () => {
    const signature = createSignature(baseComponents);
    const tampered = { ...baseComponents, bodyHash: hashBody('different body') };
    expect(verifySignature(signature, tampered)).toBe(false);
  });

  it('should reject tampered timestamp', () => {
    const signature = createSignature(baseComponents);
    const tampered = { ...baseComponents, timestamp: baseComponents.timestamp + 1 };
    expect(verifySignature(signature, tampered)).toBe(false);
  });

  it('should reject tampered nonce', () => {
    const signature = createSignature(baseComponents);
    const tampered = { ...baseComponents, nonce: 'different-nonce' };
    expect(verifySignature(signature, tampered)).toBe(false);
  });

  it('should reject tampered runId', () => {
    const signature = createSignature(baseComponents);
    const tampered = { ...baseComponents, runId: 'different-run' };
    expect(verifySignature(signature, tampered)).toBe(false);
  });

  it('should reject tampered capability token', () => {
    const signature = createSignature(baseComponents);
    const tampered = { ...baseComponents, capabilityToken: 'different-token' };
    expect(verifySignature(signature, tampered)).toBe(false);
  });

  it('should reject signature with wrong secret', () => {
    const signature = createSignature(baseComponents);
    const originalSecret = config.hmacSecret;
    config.hmacSecret = 'different-secret-key-for-testing';
    expect(verifySignature(signature, baseComponents)).toBe(false);
    config.hmacSecret = originalSecret;
  });
});

describe('Timestamp Validation', () => {
  it('should accept current timestamp', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isTimestampValid(now)).toBe(true);
  });

  it('should accept timestamp within skew', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isTimestampValid(now + 60)).toBe(true); // 1 minute in future
    expect(isTimestampValid(now - 60)).toBe(true); // 1 minute in past
  });

  it('should reject timestamp outside skew', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isTimestampValid(now + 600)).toBe(false); // 10 minutes in future
    expect(isTimestampValid(now - 600)).toBe(false); // 10 minutes in past
  });
});

describe('Nonce Generation', () => {
  it('should generate unique nonces', () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      nonces.add(generateNonce());
    }
    expect(nonces.size).toBe(1000);
  });

  it('should generate hex strings', () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[a-f0-9]+$/);
    expect(nonce.length).toBe(32); // 16 bytes = 32 hex chars
  });
});

describe('Capability Token Generation', () => {
  it('should generate unique tokens', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateCapabilityToken());
    }
    expect(tokens.size).toBe(100);
  });

  it('should generate 64-char hex strings', () => {
    const token = generateCapabilityToken();
    expect(token).toMatch(/^[a-f0-9]+$/);
    expect(token.length).toBe(64); // 32 bytes = 64 hex chars
  });
});

describe('Body Hashing', () => {
  it('should hash strings consistently', () => {
    const hash1 = hashBody('test content');
    const hash2 = hashBody('test content');
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different content', () => {
    const hash1 = hashBody('content 1');
    const hash2 = hashBody('content 2');
    expect(hash1).not.toBe(hash2);
  });

  it('should hash buffers', () => {
    const hash = hashBody(Buffer.from('test'));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('Secret Redaction', () => {
  it('should redact API keys', () => {
    expect(redactSecrets('api_key=secret123')).toContain('[REDACTED]');
    expect(redactSecrets('apiKey: secret123')).toContain('[REDACTED]');
    expect(redactSecrets('API_KEY="mykey"')).toContain('[REDACTED]');
  });

  it('should redact passwords', () => {
    expect(redactSecrets('password=secret')).toContain('[REDACTED]');
    expect(redactSecrets('PASSWORD: hunter2')).toContain('[REDACTED]');
  });

  it('should redact tokens', () => {
    expect(redactSecrets('token=abc123')).toContain('[REDACTED]');
    expect(redactSecrets('Bearer eyJhbGc...')).toContain('[REDACTED]');
  });

  it('should redact OpenAI keys', () => {
    expect(redactSecrets('sk-abcdefghijklmnopqrstuvwxyz12345')).toContain('[REDACTED]');
  });

  it('should redact GitHub tokens', () => {
    expect(redactSecrets('ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toContain('[REDACTED]');
    expect(redactSecrets('ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toContain('[REDACTED]');
  });

  it('should redact NPM tokens', () => {
    expect(redactSecrets('npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toContain('[REDACTED]');
  });

  it('should not modify non-secret content', () => {
    const safe = 'This is normal output with no secrets';
    expect(redactSecrets(safe)).toBe(safe);
  });

  it('should preserve surrounding context', () => {
    const result = redactSecrets('Before api_key=secret123 After');
    expect(result).toContain('Before');
    expect(result).toContain('After');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('secret123');
  });
});
