import { createHmac, createHash, randomBytes } from 'crypto';
import { config } from '../config.js';

export interface SignatureComponents {
  method: string;
  path: string;
  bodyHash: string;
  timestamp: number;
  nonce: string;
  runId?: string;
  capabilityToken?: string;
}

/**
 * Create HMAC signature for gateway authentication
 */
export function createSignature(components: SignatureComponents): string {
  const message = [
    components.method.toUpperCase(),
    components.path,
    components.bodyHash,
    components.timestamp.toString(),
    components.nonce,
    components.runId || '',
    components.capabilityToken || ''
  ].join('\n');

  return createHmac('sha256', config.hmacSecret).update(message).digest('hex');
}

/**
 * Hash body content
 */
export function hashBody(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Generate random nonce
 */
export function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Redact secrets from text
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of config.secretPatterns) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}
