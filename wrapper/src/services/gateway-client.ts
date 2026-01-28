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
  type: 'stdout' | 'stderr' | 'marker' | 'info' | 'error' | 'assist' | 'prompt_waiting' | 'prompt_resolved';
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

/**
 * Update run state (for resume functionality)
 */
export async function updateRunState(
  auth: RunAuth,
  state: {
    workingDir?: string;
    lastSequence?: number;
    stdinBuffer?: string;
    environment?: Record<string, string>;
  }
): Promise<void> {
  await request('POST', `/api/runs/${auth.runId}/state`, state, auth);
}

/**
 * List runs from gateway (requires UI auth, but can be called with wrapper for status)
 */
export interface RunInfo {
  id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  command: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  metadata: Record<string, any> | null;
}

export interface ListRunsResponse {
  runs: RunInfo[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

/**
 * Request authenticated endpoint for UI operations
 * Note: These require UI session auth, typically called from CLI with stored credentials
 */
export interface UIAuth {
  sessionToken: string;
}

async function uiRequest(
  method: string,
  path: string,
  body?: object,
  auth?: UIAuth
): Promise<any> {
  const url = `${config.gatewayUrl}${path}`;

  const headers: Record<string, string> = {};

  if (auth?.sessionToken) {
    headers['Authorization'] = `Bearer ${auth.sessionToken}`;
  }

  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    agent
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Gateway error: ${JSON.stringify(error)}`);
  }

  return response.json();
}

export async function listRuns(
  auth: UIAuth,
  options?: { status?: string; limit?: number; offset?: number; search?: string }
): Promise<ListRunsResponse> {
  const params = new URLSearchParams();
  if (options?.status) params.append('status', options.status);
  if (options?.limit) params.append('limit', options.limit.toString());
  if (options?.offset) params.append('offset', options.offset.toString());
  if (options?.search) params.append('search', options.search);

  const queryString = params.toString();
  const path = `/api/runs${queryString ? `?${queryString}` : ''}`;

  return uiRequest('GET', path, undefined, auth);
}

export async function getRun(auth: UIAuth, runId: string): Promise<RunInfo & { artifacts: any[] }> {
  return uiRequest('GET', `/api/runs/${runId}`, undefined, auth);
}

export async function getRunState(auth: UIAuth, runId: string): Promise<{
  run: RunInfo;
  state: {
    working_dir: string;
    original_command: string | null;
    last_sequence: number;
    stdin_buffer: string | null;
    environment: string | null;
  } | null;
  recentEvents: any[];
  canResume: boolean;
}> {
  return uiRequest('GET', `/api/runs/${runId}/state`, undefined, auth);
}

export async function createRun(
  auth: UIAuth,
  options: {
    command?: string;
    metadata?: Record<string, any>;
    workingDir?: string;
    autonomous?: boolean;
    workerType?: string;
    model?: string;
  }
): Promise<{ id: string; capabilityToken: string; status: string; autonomous?: boolean }> {
  return uiRequest('POST', '/api/runs', options, auth);
}

export async function stopRun(auth: UIAuth, runId: string): Promise<{ ok: boolean; commandId: string }> {
  return uiRequest('POST', `/api/runs/${runId}/stop`, {}, auth);
}

export async function haltRun(auth: UIAuth, runId: string): Promise<{ ok: boolean; commandId: string }> {
  return uiRequest('POST', `/api/runs/${runId}/halt`, {}, auth);
}

export async function restartRun(
  auth: UIAuth,
  runId: string,
  options?: { command?: string; workingDir?: string }
): Promise<{ id: string; capabilityToken: string; status: string; restartedFrom: string }> {
  return uiRequest('POST', `/api/runs/${runId}/restart`, options || {}, auth);
}

export async function sendInput(
  auth: UIAuth,
  runId: string,
  input: string,
  escape?: boolean
): Promise<{ ok: boolean; commandId: string }> {
  return uiRequest('POST', `/api/runs/${runId}/input`, { input, escape }, auth);
}

export async function sendEscape(
  auth: UIAuth,
  runId: string
): Promise<{ ok: boolean; commandId: string }> {
  return uiRequest('POST', `/api/runs/${runId}/escape`, {}, auth);
}

/**
 * Login to get UI session token
 */
export async function login(
  username: string,
  password: string,
  totpCode?: string
): Promise<{ token: string; user: { id: string; username: string; role: string } }> {
  return uiRequest('POST', '/api/auth/login', { username, password, totpCode });
}

/**
 * Check auth status
 */
export async function getAuthStatus(): Promise<{ needsSetup: boolean }> {
  return uiRequest('GET', '/api/auth/status');
}
