import fetch from 'node-fetch';
import https from 'https';
import FormData from 'form-data';
import { createReadStream } from 'fs';
import { config } from '../config.js';
import { createSignature, hashBody, generateNonce } from '../utils/crypto.js';

// Allow self-signed certs in dev
const agent = config.allowSelfSignedCerts
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

export interface RunAuth {
  runId: string;
  capabilityToken: string;
}

export interface GatewayEvent {
  type: 'stdout' | 'stderr' | 'marker' | 'info' | 'error' | 'assist';
  data: string;
  sequence?: number;
}

export interface Command {
  id: string;
  command: string;
  created_at: number;
}

/**
 * Make authenticated request to gateway
 */
async function request(
  method: string,
  path: string,
  body?: object | FormData,
  auth?: RunAuth
): Promise<any> {
  const url = `${config.gatewayUrl}${path}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = generateNonce();

  let bodyStr = '';
  let headers: Record<string, string> = {
    'X-Timestamp': timestamp.toString(),
    'X-Nonce': nonce
  };

  if (auth) {
    headers['X-Run-Id'] = auth.runId;
    headers['X-Capability-Token'] = auth.capabilityToken;
  }

  let fetchBody: string | FormData | undefined;

  if (body instanceof FormData) {
    // For file uploads, hash the form boundary
    bodyStr = 'multipart';
    fetchBody = body;
    // FormData sets its own content-type with boundary
  } else if (body) {
    bodyStr = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
    fetchBody = bodyStr;
  }

  // Create signature
  const signature = createSignature({
    method,
    path,
    bodyHash: hashBody(bodyStr),
    timestamp,
    nonce,
    runId: auth?.runId,
    capabilityToken: auth?.capabilityToken
  });

  headers['X-Signature'] = signature;

  const response = await fetch(url, {
    method,
    headers,
    body: fetchBody,
    agent
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Gateway error: ${JSON.stringify(error)}`);
  }

  return response.json();
}

/**
 * Send event to gateway
 */
export async function sendEvent(auth: RunAuth, event: GatewayEvent): Promise<void> {
  await request('POST', '/api/ingest/event', event, auth);
}

/**
 * Upload artifact to gateway
 */
export async function uploadArtifact(
  auth: RunAuth,
  filePath: string,
  fileName: string
): Promise<{ artifactId: string }> {
  const form = new FormData();
  form.append('file', createReadStream(filePath), fileName);

  return request('POST', '/api/ingest/artifact', form, auth);
}

/**
 * Poll for pending commands
 */
export async function pollCommands(auth: RunAuth): Promise<Command[]> {
  return request('GET', `/api/runs/${auth.runId}/commands`, undefined, auth);
}

/**
 * Acknowledge command completion
 */
export async function ackCommand(
  auth: RunAuth,
  commandId: string,
  result?: string,
  error?: string
): Promise<void> {
  await request(
    'POST',
    `/api/runs/${auth.runId}/commands/${commandId}/ack`,
    { result, error },
    auth
  );
}

/**
 * Test gateway connectivity
 */
export async function testConnection(): Promise<boolean> {
  try {
    const response = await fetch(`${config.gatewayUrl}/api/health`, { agent });
    return response.ok;
  } catch {
    return false;
  }
}
