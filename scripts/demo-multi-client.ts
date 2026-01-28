#!/usr/bin/env npx ts-node --esm
/**
 * Multi-Client Demo Script
 *
 * This script simulates multiple clients connecting to the gateway
 * and streaming logs to test the mobile-friendly multi-client UI.
 *
 * Usage:
 *   cd /path/to/AiRemoteCoder
 *   npx ts-node --esm scripts/demo-multi-client.ts
 *
 * Prerequisites:
 *   1. Gateway must be running (npm run dev in gateway/)
 *   2. Set up admin user if not done: http://localhost:3100
 *
 * What it does:
 *   1. Creates 2 simulated clients (dev-laptop, build-server)
 *   2. Each client registers with the gateway
 *   3. Creates 2 runs per client (4 total)
 *   4. Streams simulated log output to each run
 *   5. Demonstrates multi-client dashboard view
 */

import crypto from 'crypto';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3100';
const HMAC_SECRET = process.env.HMAC_SECRET || 'development-secret';

// Client configurations
const CLIENTS = [
  {
    agentId: 'demo-dev-laptop-001',
    displayName: 'dev-laptop',
    version: '1.0.0',
    capabilities: ['npm test', 'git diff', 'git status'],
  },
  {
    agentId: 'demo-build-server-002',
    displayName: 'build-server',
    version: '1.0.0',
    capabilities: ['npm test', 'npm run build', 'pytest'],
  },
];

// Sample log messages to stream
const LOG_MESSAGES = [
  { type: 'stdout', data: 'Starting process...' },
  { type: 'stdout', data: 'Loading configuration...' },
  { type: 'stdout', data: 'Connecting to database...' },
  { type: 'stdout', data: 'Database connection established' },
  { type: 'stdout', data: 'Initializing modules...' },
  { type: 'stdout', data: '  - Module A initialized' },
  { type: 'stdout', data: '  - Module B initialized' },
  { type: 'stdout', data: '  - Module C initialized' },
  { type: 'stdout', data: 'Running tests...' },
  { type: 'stdout', data: '  PASS  src/utils.test.ts' },
  { type: 'stdout', data: '  PASS  src/api.test.ts' },
  { type: 'stderr', data: 'Warning: Deprecated function called' },
  { type: 'stdout', data: '  PASS  src/database.test.ts' },
  { type: 'stdout', data: 'Test Suites: 3 passed, 3 total' },
  { type: 'stdout', data: 'Tests:       12 passed, 12 total' },
  { type: 'stdout', data: 'Snapshots:   0 total' },
  { type: 'stdout', data: 'Time:        4.521s' },
  { type: 'stdout', data: '' },
  { type: 'stdout', data: 'Building project...' },
  { type: 'stdout', data: 'Compiling TypeScript...' },
  { type: 'stdout', data: '  [1/4] Compiling src/index.ts' },
  { type: 'stdout', data: '  [2/4] Compiling src/utils.ts' },
  { type: 'stdout', data: '  [3/4] Compiling src/api.ts' },
  { type: 'stdout', data: '  [4/4] Compiling src/database.ts' },
  { type: 'stdout', data: 'Bundle created: dist/bundle.js (245 KB)' },
  { type: 'stdout', data: 'Build completed successfully!' },
];

interface RunInfo {
  id: string;
  capabilityToken: string;
  clientId: string;
  clientName: string;
}

// Create HMAC signature for wrapper authentication
function createSignature(
  method: string,
  path: string,
  body: string,
  timestamp: number,
  nonce: string,
  runId: string,
  capabilityToken: string
): string {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const message = `${method}\n${path}\n${bodyHash}\n${timestamp}\n${nonce}\n${runId}\n${capabilityToken}`;
  return crypto.createHmac('sha256', HMAC_SECRET).update(message).digest('hex');
}

// Make authenticated request as wrapper
async function wrapperRequest(
  method: string,
  path: string,
  body: object | null,
  runId: string,
  capabilityToken: string
): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyStr = body ? JSON.stringify(body) : '';

  const signature = createSignature(
    method,
    path,
    bodyStr,
    timestamp,
    nonce,
    runId,
    capabilityToken
  );

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Signature': signature,
    'X-Timestamp': String(timestamp),
    'X-Nonce': nonce,
    'X-Run-Id': runId,
    'X-Capability-Token': capabilityToken,
  };

  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method,
    headers,
    body: bodyStr || undefined,
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Request failed: ${res.status} ${error}`);
  }

  return res.json();
}

// Register a client
async function registerClient(client: typeof CLIENTS[0], runId: string, token: string): Promise<void> {
  console.log(`  Registering client: ${client.displayName}`);

  await wrapperRequest('POST', '/api/clients/register', client, runId, token);
}

// Send heartbeat for a client
async function sendHeartbeat(agentId: string, runId: string, token: string): Promise<void> {
  await wrapperRequest('POST', '/api/clients/heartbeat', { agentId }, runId, token);
}

// Send an event to a run
async function sendEvent(
  runId: string,
  token: string,
  type: string,
  data: string,
  sequence: number
): Promise<void> {
  await wrapperRequest('POST', '/api/ingest/event', { type, data, sequence }, runId, token);
}

// Get a session cookie by logging in (for UI operations)
async function getSession(): Promise<string | null> {
  // First check if setup is required
  const statusRes = await fetch(`${GATEWAY_URL}/api/auth/status`);
  const status = await statusRes.json();

  if (status.setupRequired) {
    console.log('Setting up admin user...');
    const setupRes = await fetch(`${GATEWAY_URL}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: 'demo-password-123',
      }),
    });
    if (!setupRes.ok) {
      console.error('Setup failed');
      return null;
    }
    const cookies = setupRes.headers.get('set-cookie');
    if (cookies) {
      return cookies.split(';')[0];
    }
  }

  // Try to login
  const loginRes = await fetch(`${GATEWAY_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'demo-password-123',
    }),
  });

  if (loginRes.ok) {
    const cookies = loginRes.headers.get('set-cookie');
    if (cookies) {
      return cookies.split(';')[0];
    }
  }

  return null;
}

// Create a run via UI API
async function createRun(
  session: string,
  label: string,
  command: string,
  agentId: string,
  repoName: string
): Promise<RunInfo> {
  const res = await fetch(`${GATEWAY_URL}/api/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session,
    },
    body: JSON.stringify({
      label,
      command,
      agentId,
      repoName,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create run: ${await res.text()}`);
  }

  const data = await res.json();
  return {
    id: data.id,
    capabilityToken: data.capabilityToken,
    clientId: agentId,
    clientName: label,
  };
}

// Simulate a run with log streaming
async function simulateRun(run: RunInfo, messageSet: typeof LOG_MESSAGES): Promise<void> {
  let sequence = 0;

  // Send started marker
  await sendEvent(run.id, run.capabilityToken, 'marker', JSON.stringify({ event: 'started' }), sequence++);

  // Stream log messages with delays
  for (const msg of messageSet) {
    await sendEvent(run.id, run.capabilityToken, msg.type, msg.data, sequence++);
    await sleep(100 + Math.random() * 200); // 100-300ms between messages
  }

  // Random chance of failure for demo
  const failed = Math.random() < 0.2;
  const exitCode = failed ? 1 : 0;

  if (failed) {
    await sendEvent(run.id, run.capabilityToken, 'stderr', 'Error: Process failed unexpectedly', sequence++);
  }

  // Send finished marker
  await sendEvent(
    run.id,
    run.capabilityToken,
    'marker',
    JSON.stringify({ event: 'finished', exitCode }),
    sequence++
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Main demo function
async function main() {
  console.log('='.repeat(60));
  console.log('Multi-Client Demo for Connect-Back Gateway');
  console.log('='.repeat(60));
  console.log();
  console.log(`Gateway URL: ${GATEWAY_URL}`);
  console.log();

  // Get session for UI operations
  console.log('1. Authenticating...');
  const session = await getSession();
  if (!session) {
    console.error('   Failed to authenticate. Is the gateway running?');
    console.error(`   Try: cd gateway && npm run dev`);
    process.exit(1);
  }
  console.log('   Authenticated successfully');
  console.log();

  // Create runs for each client
  console.log('2. Creating runs for multiple clients...');
  const runs: RunInfo[] = [];

  for (const client of CLIENTS) {
    // Create 2 runs per client
    for (let i = 1; i <= 2; i++) {
      const run = await createRun(
        session,
        `${client.displayName} - Task ${i}`,
        i === 1 ? 'npm test' : 'npm run build',
        client.agentId,
        i === 1 ? 'my-project' : 'api-service'
      );
      runs.push({ ...run, clientId: client.agentId, clientName: client.displayName });
      console.log(`   Created run ${run.id} for ${client.displayName}`);
    }
  }
  console.log();

  // Register clients
  console.log('3. Registering clients...');
  for (const client of CLIENTS) {
    const clientRun = runs.find((r) => r.clientId === client.agentId);
    if (clientRun) {
      await registerClient(client, clientRun.id, clientRun.capabilityToken);
    }
  }
  console.log();

  // Start heartbeat for all clients in background
  console.log('4. Starting heartbeat for clients...');
  const heartbeatIntervals: NodeJS.Timeout[] = [];
  for (const client of CLIENTS) {
    const clientRun = runs.find((r) => r.clientId === client.agentId);
    if (clientRun) {
      const interval = setInterval(async () => {
        try {
          await sendHeartbeat(client.agentId, clientRun.id, clientRun.capabilityToken);
        } catch (err) {
          // Ignore heartbeat errors
        }
      }, 15000);
      heartbeatIntervals.push(interval);
    }
  }
  console.log();

  // Simulate all runs concurrently
  console.log('5. Streaming logs to all runs (this will take ~30 seconds)...');
  console.log();
  console.log('   Open the UI to see the multi-client dashboard:');
  console.log(`   ${GATEWAY_URL}`);
  console.log();
  console.log('   What to test:');
  console.log('   - Dashboard shows "Active Runs" from multiple clients');
  console.log('   - Runs page filters by client');
  console.log('   - Clients page shows both clients online');
  console.log('   - Run detail shows live log streaming');
  console.log('   - Mobile view (resize browser to 390px width)');
  console.log();

  // Run all simulations in parallel
  await Promise.all(
    runs.map((run, i) => {
      // Stagger start times slightly
      return sleep(i * 500).then(() => {
        console.log(`   Starting simulation for run ${run.id} (${run.clientName})`);
        return simulateRun(run, LOG_MESSAGES);
      });
    })
  );

  console.log();
  console.log('6. Simulation complete!');
  console.log();
  console.log('   Summary:');
  console.log(`   - ${CLIENTS.length} clients registered`);
  console.log(`   - ${runs.length} runs simulated`);
  console.log();

  // Clean up heartbeat intervals
  heartbeatIntervals.forEach((interval) => clearInterval(interval));

  // Keep running for a bit so heartbeats can be observed
  console.log('   Keeping heartbeats alive for 30 more seconds...');
  console.log('   (Press Ctrl+C to exit)');

  // Re-enable heartbeats for observation
  for (const client of CLIENTS) {
    const clientRun = runs.find((r) => r.clientId === client.agentId);
    if (clientRun) {
      const interval = setInterval(async () => {
        try {
          await sendHeartbeat(client.agentId, clientRun.id, clientRun.capabilityToken);
        } catch (err) {
          // Ignore
        }
      }, 10000);
      heartbeatIntervals.push(interval);
    }
  }

  await sleep(30000);

  console.log();
  console.log('Demo complete. Exiting.');
  heartbeatIntervals.forEach((interval) => clearInterval(interval));
  process.exit(0);
}

// Run the demo
main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
