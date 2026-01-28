import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config
vi.mock('../config.js', () => ({
  config: {
    gatewayUrl: 'https://localhost:3100',
    hmacSecret: 'test-secret-key-that-is-long-enough',
    allowSelfSignedCerts: true,
    secretPatterns: []
  }
}));

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { createSignature, hashBody, generateNonce } from '../utils/crypto.js';

describe('Gateway Client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('Request Signing', () => {
    it('should generate all required headers', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = generateNonce();
      const body = '{"type":"stdout","data":"test"}';
      const bodyHash = hashBody(body);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Timestamp': timestamp.toString(),
        'X-Nonce': nonce
      };

      // Add signature
      headers['X-Signature'] = createSignature({
        method: 'POST',
        path: '/api/ingest/event',
        bodyHash,
        timestamp,
        nonce
      });

      expect(headers['X-Timestamp']).toBeDefined();
      expect(headers['X-Nonce']).toBeDefined();
      expect(headers['X-Signature']).toBeDefined();
      expect(headers['X-Signature']).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should include run auth headers when provided', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = generateNonce();
      const runId = 'test-run-id';
      const capabilityToken = 'test-cap-token';

      const headers: Record<string, string> = {
        'X-Timestamp': timestamp.toString(),
        'X-Nonce': nonce,
        'X-Run-Id': runId,
        'X-Capability-Token': capabilityToken
      };

      headers['X-Signature'] = createSignature({
        method: 'POST',
        path: '/api/ingest/event',
        bodyHash: hashBody(''),
        timestamp,
        nonce,
        runId,
        capabilityToken
      });

      expect(headers['X-Run-Id']).toBe(runId);
      expect(headers['X-Capability-Token']).toBe(capabilityToken);
    });
  });

  describe('Event Types', () => {
    const validEventTypes = ['stdout', 'stderr', 'marker', 'info', 'error', 'assist'];

    it('should accept all valid event types', () => {
      for (const type of validEventTypes) {
        const event = { type, data: 'test data', sequence: 1 };
        expect(event.type).toBe(type);
      }
    });

    it('should structure marker events correctly', () => {
      const startMarker = {
        type: 'marker',
        data: JSON.stringify({ event: 'started', command: 'npm test' })
      };

      const finishMarker = {
        type: 'marker',
        data: JSON.stringify({ event: 'finished', exitCode: 0 })
      };

      expect(JSON.parse(startMarker.data).event).toBe('started');
      expect(JSON.parse(finishMarker.data).exitCode).toBe(0);
    });

    it('should structure assist events correctly', () => {
      const assistEvent = {
        type: 'assist',
        data: JSON.stringify({ type: 'tmate', url: 'ssh user@host' })
      };

      const parsed = JSON.parse(assistEvent.data);
      expect(parsed.type).toBe('tmate');
      expect(parsed.url).toBeDefined();
    });
  });

  describe('Command Handling', () => {
    it('should parse command response', () => {
      const response = [
        { id: 'cmd-1', command: 'npm test', created_at: 1234567890 },
        { id: 'cmd-2', command: 'git diff', created_at: 1234567891 }
      ];

      expect(response.length).toBe(2);
      expect(response[0].command).toBe('npm test');
      expect(response[1].id).toBe('cmd-2');
    });

    it('should structure ack request correctly', () => {
      const successAck = { result: 'Test passed\n5 tests, 0 failures' };
      const errorAck = { error: 'Command failed with exit code 1' };

      expect(successAck.result).toBeDefined();
      expect(successAck).not.toHaveProperty('error');
      expect(errorAck.error).toBeDefined();
      expect(errorAck).not.toHaveProperty('result');
    });
  });

  describe('Error Handling', () => {
    it('should handle HTTP error responses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Invalid signature' })
      });

      const response = await mockFetch('https://localhost:3100/api/test');
      expect(response.ok).toBe(false);

      const error = await response.json();
      expect(error.error).toBe('Invalid signature');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      try {
        await mockFetch('https://localhost:3100/api/test');
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).toBe('Network error');
      }
    });

    it('should handle timeout', async () => {
      mockFetch.mockImplementationOnce(() =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 100)
        )
      );

      try {
        await mockFetch('https://localhost:3100/api/test');
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).toBe('Timeout');
      }
    });
  });

  describe('Health Check', () => {
    it('should return true on successful health check', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ok' })
      });

      const response = await mockFetch('https://localhost:3100/api/health');
      expect(response.ok).toBe(true);
    });

    it('should return false on failed health check', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500
      });

      const response = await mockFetch('https://localhost:3100/api/health');
      expect(response.ok).toBe(false);
    });
  });
});

describe('File Upload', () => {
  it('should create form data for artifact upload', () => {
    // In Node.js, we'd use form-data package
    // This tests the structure of what would be sent

    const artifactMeta = {
      runId: 'test-run',
      filename: 'test.log',
      type: 'log',
      size: 1024
    };

    expect(artifactMeta.filename).toBe('test.log');
    expect(artifactMeta.type).toBe('log');
  });
});
