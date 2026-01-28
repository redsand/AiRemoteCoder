import { createHmac, createHash, randomBytes, timingSafeEqual } from 'crypto';
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
 * Create HMAC signature for wrapper authentication
 */
export function createSignature(components: SignatureComponents, secret: string = config.hmacSecret): string {
  const message = [
    components.method.toUpperCase(),
    components.path,
    components.bodyHash,
    components.timestamp.toString(),
    components.nonce,
    components.runId || '',
    components.capabilityToken || ''
  ].join('\n');

  return createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Verify HMAC signature
 */
export function verifySignature(
  signature: string,
  components: SignatureComponents,
  secret: string = config.hmacSecret
): boolean {
  const expected = createSignature(components, secret);

  // Use timing-safe comparison
  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
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
 * Generate capability token for a run
 */
export function generateCapabilityToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Generate session token
 */
export function generateSessionToken(): string {
  return randomBytes(48).toString('hex');
}

/**
 * Check if timestamp is within allowed clock skew
 */
export function isTimestampValid(timestamp: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.abs(now - timestamp);
  return diff <= config.clockSkewSeconds;
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
