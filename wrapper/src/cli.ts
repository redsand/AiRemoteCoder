#!/usr/bin/env node

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { config, validateConfig } from './config.js';
import { ClaudeRunner } from './services/claude-runner.js';
import { GenericRunner, createGenericRunner } from './services/generic-runner.js';
import { VncRunner } from './services/vnc-runner.js';
import { HandsOnRunner } from './services/hands-on-runner.js';
import {
  testConnection,
  login,
  getAuthStatus,
  listRuns,
  getRun,
  getRunState,
  stopRun,
  haltRun,
  restartRun,
  sendInput,
  sendEscape,
  registerClient,
  sendHeartbeat,
  claimRun,
  type UIAuth
} from './services/gateway-client.js';
import { type WorkerType, isValidWorkerType } from './services/worker-registry.js';
import type { BaseRunner } from './services/base-runner.js';
import { WorkerPool } from './services/worker-pool.js';

const program = new Command();

// Read version from package.json
function getVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return packageJson.version || '1.0.0';
  } catch {
    return '1.0.0'; // Fallback version
  }
}

// Credential storage path
const credentialsPath = join(config.dataDir, 'credentials.json');

interface StoredCredentials {
  sessionToken: string;
  username: string;
  role: string;
  expiresAt: number;
}

/**
 * Load stored credentials
 */
function loadCredentials(): StoredCredentials | null {
  try {
    if (existsSync(credentialsPath)) {
      const data = JSON.parse(readFileSync(credentialsPath, 'utf8'));
      // Check if expired (24 hours)
      if (data.expiresAt && data.expiresAt > Date.now()) {
        return data;
      }
    }
  } catch (err) {
    // Ignore errors
  }
  return null;
}

/**
 * Save credentials
 */
function saveCredentials(creds: StoredCredentials): void {
  try {
    const dir = dirname(credentialsPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(credentialsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('Warning: Could not save credentials:', err);
  }
}

/**
 * Clear stored credentials
 */
function clearCredentials(): void {
  try {
    if (existsSync(credentialsPath)) {
      writeFileSync(credentialsPath, '{}');
    }
  } catch (err) {
    // Ignore errors
  }
}

/**
 * Get UI auth, prompting for login if needed
 */
async function getUIAuth(): Promise<UIAuth> {
  const creds = loadCredentials();
  if (creds?.sessionToken) {
    return { sessionToken: creds.sessionToken };
  }

  console.error('Not logged in. Use "claude-runner login" first.');
  process.exit(1);
}

/**
 * Format timestamp for display
 */
function formatTime(timestamp: number | null): string {
  if (!timestamp) return '-';
  return new Date(timestamp * 1000).toLocaleString();
}

/**
 * Format duration
 */
function formatDuration(start: number | null, end: number | null): string {
  if (!start) return '-';
  const endTime = end || Math.floor(Date.now() / 1000);
  const seconds = endTime - start;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * Status color/symbol
 */
function statusDisplay(status: string): string {
  switch (status) {
    case 'pending': return '⏳ pending';
    case 'running': return '🔄 running';
    case 'done': return '✓ done';
    case 'failed': return '✗ failed';
    default: return status;
  }
}

program
  .name('ai-runner')
  .description('AI Remote Coder wrapper for Connect-Back Gateway - Full workflow control')
  .version(getVersion());

// ============================================================================
// Authentication Commands
// ============================================================================

program
  .command('login')
  .description('Login to the gateway')
  .option('-u, --username <username>', 'Username')
  .option('-p, --password <password>', 'Password')
  .option('-t, --totp <code>', 'TOTP code (if 2FA enabled)')
  .action(async (options) => {
    try {
      const status = await getAuthStatus();
      if (status.needsSetup) {
        console.error('Gateway needs initial setup. Visit the web UI first to create admin account.');
        process.exit(1);
      }

      // Prompt for credentials if not provided
      let username = options.username;
      let password = options.password;

      if (!username) {
        const readline = await import('readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        username = await new Promise<string>(resolve => {
          rl.question('Username: ', resolve);
        });
        rl.close();
      }

      if (!password) {
        const readline = await import('readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        // Hide password input
        process.stdout.write('Password: ');
        password = await new Promise<string>(resolve => {
          let pwd = '';
          process.stdin.setRawMode?.(true);
          process.stdin.resume();
          process.stdin.on('data', (char) => {
            const c = char.toString();
            if (c === '\n' || c === '\r') {
              process.stdin.setRawMode?.(false);
              console.log();
              resolve(pwd);
            } else if (c === '\u0003') {
              process.exit();
            } else if (c === '\u007F') {
              pwd = pwd.slice(0, -1);
            } else {
              pwd += c;
            }
          });
        });
        rl.close();
      }

      const result = await login(username, password, options.totp);

      // Save credentials
      saveCredentials({
        sessionToken: result.token,
        username: result.user.username,
        role: result.user.role,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
      });

      console.log(`✓ Logged in as ${result.user.username} (${result.user.role})`);
    } catch (err: any) {
      console.error('Login failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('logout')
  .description('Logout and clear stored credentials')
  .action(() => {
    clearCredentials();
    console.log('✓ Logged out');
  });

program
  .command('whoami')
  .description('Show current logged in user')
  .action(() => {
    const creds = loadCredentials();
    if (creds?.sessionToken) {
      console.log(`Logged in as: ${creds.username} (${creds.role})`);
      console.log(`Session expires: ${new Date(creds.expiresAt).toLocaleString()}`);
    } else {
      console.log('Not logged in');
    }
  });

// ============================================================================
// Session Management Commands
// ============================================================================

program
  .command('list')
  .alias('ls')
  .description('List all runs/sessions')
  .option('-s, --status <status>', 'Filter by status (pending, running, done, failed)')
  .option('-l, --limit <n>', 'Number of results', '20')
  .option('-o, --offset <n>', 'Offset for pagination', '0')
  .option('-q, --search <query>', 'Search by command or run ID')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const auth = await getUIAuth();
      const result = await listRuns(auth, {
        status: options.status,
        limit: parseInt(options.limit, 10),
        offset: parseInt(options.offset, 10),
        search: options.search
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.runs.length === 0) {
        console.log('No runs found');
        return;
      }

      console.log(`\nRuns (${result.pagination.offset + 1}-${result.pagination.offset + result.runs.length} of ${result.pagination.total}):\n`);
      console.log('ID            Status       Duration   Command');
      console.log('─'.repeat(70));

      for (const run of result.runs) {
        const duration = formatDuration(run.started_at, run.finished_at);
        const command = run.command?.substring(0, 30) || '(no command)';
        console.log(
          `${run.id}  ${statusDisplay(run.status).padEnd(12)} ${duration.padEnd(10)} ${command}`
        );
      }

      if (result.pagination.hasMore) {
        console.log(`\n... use --offset ${result.pagination.offset + result.runs.length} to see more`);
      }
    } catch (err: any) {
      console.error('Failed to list runs:', err.message);
      process.exit(1);
    }
  });

program
  .command('show <runId>')
  .description('Show details for a specific run')
  .option('--json', 'Output as JSON')
  .action(async (runId, options) => {
    try {
      const auth = await getUIAuth();
      const state = await getRunState(auth, runId);

      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }

      const { run, state: runState, recentEvents, canResume } = state;

      console.log('\n=== Run Details ===\n');
      console.log(`ID:          ${run.id}`);
      console.log(`Status:      ${statusDisplay(run.status)}`);
      console.log(`Command:     ${run.command || '(no command)'}`);
      console.log(`Created:     ${formatTime(run.created_at)}`);
      console.log(`Started:     ${formatTime(run.started_at)}`);
      console.log(`Finished:    ${formatTime(run.finished_at)}`);
      console.log(`Duration:    ${formatDuration(run.started_at, run.finished_at)}`);
      console.log(`Exit Code:   ${run.exit_code ?? '-'}`);
      console.log(`Can Resume:  ${canResume ? 'Yes' : 'No'}`);

      if (runState) {
        console.log('\n=== Saved State ===\n');
        console.log(`Working Dir: ${runState.working_dir}`);
        console.log(`Last Seq:    ${runState.last_sequence}`);
      }

      if (run.metadata) {
        console.log('\n=== Metadata ===\n');
        console.log(JSON.stringify(run.metadata, null, 2));
      }

      if (recentEvents.length > 0) {
        console.log(`\n=== Recent Events (last ${recentEvents.length}) ===\n`);
        for (const event of recentEvents.slice(-10)) {
          const time = new Date(event.timestamp * 1000).toLocaleTimeString();
          const data = event.data.substring(0, 60).replace(/\n/g, '\\n');
          console.log(`[${time}] ${event.type}: ${data}${event.data.length > 60 ? '...' : ''}`);
        }
      }
    } catch (err: any) {
      console.error('Failed to get run details:', err.message);
      process.exit(1);
    }
  });

// ============================================================================
// Run Control Commands
// ============================================================================

program
  .command('run')
  .description('Deprecated: use "listen" (runs are started from the gateway)')
  .action(() => {
    console.error('The "run" command is deprecated. Use "ai-runner listen" instead.');
    process.exit(1);
  });

program
  .command('start')
  .description('Deprecated: use "listen" (runs are started from the gateway)')
  .action(() => {
    console.error('The "start" command is deprecated. Use "ai-runner listen" instead.');
    process.exit(1);
  });

program
  .command('stop <runId>')
  .description('Gracefully stop a running session (SIGINT, then SIGKILL after 10s)')
  .action(async (runId) => {
    try {
      const auth = await getUIAuth();
      const result = await stopRun(auth, runId);
      console.log(`✓ Stop requested for run ${runId} (command: ${result.commandId})`);
      console.log('Process will receive SIGINT, then SIGKILL after 10 seconds if still running.');
    } catch (err: any) {
      console.error('Failed to stop run:', err.message);
      process.exit(1);
    }
  });

program
  .command('halt <runId>')
  .description('Hard halt a running session (immediate SIGKILL)')
  .action(async (runId) => {
    try {
      const auth = await getUIAuth();
      const result = await haltRun(auth, runId);
      console.log(`✓ Hard halt requested for run ${runId} (command: ${result.commandId})`);
      console.log('Process will receive immediate SIGKILL.');
    } catch (err: any) {
      console.error('Failed to halt run:', err.message);
      process.exit(1);
    }
  });

program
  .command('escape <runId>')
  .description('Send escape/interrupt sequence to a running session')
  .action(async (runId) => {
    try {
      const auth = await getUIAuth();
      const result = await sendEscape(auth, runId);
      console.log(`✓ Escape sequence sent to run ${runId} (command: ${result.commandId})`);
    } catch (err: any) {
      console.error('Failed to send escape:', err.message);
      process.exit(1);
    }
  });

program
  .command('input <runId> <text>')
  .description('Send input to stdin of a running session')
  .option('-e, --escape', 'Prefix with escape sequence (Ctrl+C)')
  .option('-n, --newline', 'Append newline to input', true)
  .action(async (runId, text, options) => {
    try {
      const auth = await getUIAuth();
      const input = options.newline ? text + '\n' : text;
      const result = await sendInput(auth, runId, input, options.escape);
      console.log(`✓ Input sent to run ${runId} (command: ${result.commandId})`);
    } catch (err: any) {
      console.error('Failed to send input:', err.message);
      process.exit(1);
    }
  });

program
  .command('restart <runId>')
  .description('Restart a completed session with same or new configuration')
  .option('-c, --cmd <command>', 'Override the command/prompt')
  .option('-d, --cwd <path>', 'Override the working directory')
  .option('--start', 'Also start the new run immediately')
  .action(async (runId, options) => {
    try {
      const auth = await getUIAuth();

      // Create new run from existing
      const result = await restartRun(auth, runId, {
        command: options.cmd,
        workingDir: options.cwd
      });

      console.log(`✓ Created new run ${result.id} (restarted from ${result.restartedFrom})`);
      console.log(`Token: ${result.capabilityToken}`);

      if (options.start) {
        // Start the new run immediately
        validateConfig();

        const connected = await testConnection();
        if (!connected) {
          console.error(`Cannot connect to gateway`);
          process.exit(1);
        }

        const runner = new ClaudeRunner({
          runId: result.id,
          capabilityToken: result.capabilityToken,
          workingDir: options.cwd,
          resumeFrom: runId
        });

        runner.on('stdout', (data) => process.stdout.write(data));
        runner.on('stderr', (data) => process.stderr.write(data));
        runner.on('exit', (code) => {
          console.log(`\nRun finished with exit code ${code}`);
          process.exit(code);
        });

        process.on('SIGINT', async () => {
          await runner.stop();
        });

        await runner.start(options.cmd);
      } else {
        console.log('\nTo start this run:');
        console.log(`  claude-runner start --run-id ${result.id} --token ${result.capabilityToken}`);
      }
    } catch (err: any) {
      console.error('Failed to restart run:', err.message);
      process.exit(1);
    }
  });

program
  .command('resume <runId>')
  .alias('continue')
  .description('Resume a stopped/failed session (creates new run from saved state)')
  .option('-p, --prompt <prompt>', 'New prompt to continue with')
  .action(async (runId, options) => {
    try {
      const auth = await getUIAuth();

      // Get the run state first
      const state = await getRunState(auth, runId);

      if (!state.canResume) {
        console.error(`Run ${runId} cannot be resumed (status: ${state.run.status})`);
        console.error('Only completed (done/failed) runs can be resumed.');
        process.exit(1);
      }

      // Create a new run based on saved state
      const result = await restartRun(auth, runId, {
        command: options.prompt
      });

      console.log(`✓ Created resume run ${result.id} (from ${runId})`);

      // Start immediately
      validateConfig();

      const connected = await testConnection();
      if (!connected) {
        console.error(`Cannot connect to gateway`);
        process.exit(1);
      }

      const workingDir = state.state?.working_dir || process.cwd();

      const runner = new ClaudeRunner({
        runId: result.id,
        capabilityToken: result.capabilityToken,
        workingDir,
        resumeFrom: runId
      });

      runner.on('stdout', (data) => process.stdout.write(data));
      runner.on('stderr', (data) => process.stderr.write(data));
      runner.on('exit', (code) => {
        console.log(`\nRun finished with exit code ${code}`);
        process.exit(code);
      });

      process.on('SIGINT', async () => {
        await runner.stop();
      });

      await runner.start(options.prompt);
    } catch (err: any) {
      console.error('Failed to resume run:', err.message);
      process.exit(1);
    }
  });

// ============================================================================
// Agent Listener Mode
// ============================================================================

program
  .command('listen')
  .description('Listen for assigned runs and start workers automatically')
  .option('--agent-id <id>', 'Stable agent ID (defaults to hostname)')
  .option('--agent-label <label>', 'Agent display label (defaults to ai-runner@<hostname>)')
  .option('--max-concurrent <n>', 'Maximum concurrent runs', '1')
  .option('--poll-interval <ms>', 'Polling interval in ms', '2000')
  .option('--client-token <token>', 'Client token for gateway authentication')
  .action(async (options) => {
    try {
      validateConfig();
    } catch (err: any) {
      console.error(`Configuration error: ${err.message}`);
      console.error('Make sure HMAC_SECRET is set in .env or environment');
      process.exit(1);
    }

    if (options.clientToken) {
      config.clientToken = options.clientToken;
    }

    const maxConcurrent = Math.max(1, parseInt(options.maxConcurrent, 10) || 1);
    const pollInterval = Math.max(500, parseInt(options.pollInterval, 10) || 2000);

    console.log('Testing gateway connection...');
    const connected = await testConnection();
    if (!connected) {
      console.error(`Cannot connect to gateway at ${config.gatewayUrl}`);
      console.error('Make sure the gateway is running and GATEWAY_URL is correct');
      process.exit(1);
    }
    console.log('Gateway connection OK');

    const agentId = options.agentId;
    const agentLabel = options.agentLabel;
    const hostname = os.hostname();

    // Register client once (or update existing)
    try {
      await registerClient(
        agentLabel || `ai-runner@${hostname}`,
        agentId || hostname,
        getVersion(),
        ['run_execution', 'log_streaming', 'command_polling']
      );
      console.log('Client registered successfully');
    } catch (err: any) {
      console.error('Failed to register client:', err.message);
      process.exit(1);
    }

    const pool = new WorkerPool({ maxConcurrent });
    let polling = false;

    console.log(`Listening for runs as agent: ${agentId || hostname}`);
    console.log(`Max concurrent runs: ${maxConcurrent}`);
    console.log(`Poll interval: ${pollInterval}ms`);

    const poll = async () => {
      if (polling) return;
      polling = true;

      try {
        if (!pool.checkResourceAvailability('listener')) {
          return;
        }

        const result = await claimRun(agentId || hostname);
        if (!result.run) {
          return;
        }

        const run = result.run;
        const metadata = run.metadata || {};
        const workingDir = metadata.workingDir || process.cwd();
        const autonomous = metadata.autonomous || false;
        const model = metadata.model;
        const integration = metadata.integration;
        const provider = metadata.provider;

        if (!isValidWorkerType(run.workerType)) {
          console.error(`Claimed run ${run.id} has invalid worker type: ${run.workerType}`);
          return;
        }

        console.log(`Claimed run ${run.id} (${run.workerType})`);

        let runner: BaseRunner;
        if (run.workerType === 'claude') {
          runner = new ClaudeRunner({
            runId: run.id,
            capabilityToken: run.capabilityToken,
            workingDir,
            autonomous,
            model,
            integration,
            provider,
            agentId,
            agentLabel
          });
        } else if (run.workerType === 'vnc') {
          runner = new VncRunner({
            runId: run.id,
            capabilityToken: run.capabilityToken,
            workingDir,
            autonomous: false,
            displayMode: 'screen',
            agentId,
            agentLabel
          });
        } else if (run.workerType === 'hands-on') {
          runner = new HandsOnRunner({
            runId: run.id,
            capabilityToken: run.capabilityToken,
            workingDir,
            autonomous: false,
            reason: 'Run assigned to hands-on mode',
            agentId,
            agentLabel
          });
        } else {
          runner = createGenericRunner(run.workerType as WorkerType, {
            runId: run.id,
            capabilityToken: run.capabilityToken,
            workingDir,
            autonomous,
            model,
            integration,
            provider,
            agentId,
            agentLabel
          });
        }

        await pool.spawnWorker(runner, {
          runId: run.id,
          capabilityToken: run.capabilityToken,
          workerType: run.workerType as WorkerType,
          command: run.command || undefined,
          workingDir,
          autonomous,
          model,
          integration,
          provider
        });
      } catch (err: any) {
        console.error('Error while polling for runs:', err.message);
      } finally {
        polling = false;
      }
    };

    const pollTimer = setInterval(poll, pollInterval);
    const heartbeatTimer = setInterval(async () => {
      try {
        await sendHeartbeat(agentId || hostname);
      } catch {
        // Ignore heartbeat errors
      }
    }, config.heartbeatInterval);

    // Initial poll immediately
    poll().catch(() => {});

    const shutdown = async () => {
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      console.log('Shutting down listener...');
      await pool.terminateAll();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// ============================================================================
// Utility Commands
// ============================================================================

program
  .command('assist')
  .description('Start a tmate assist session and post URL to gateway')
  .requiredOption('--run-id <id>', 'Run ID from gateway')
  .requiredOption('--token <token>', 'Capability token from gateway')
  .option('--cwd <path>', 'Working directory (defaults to current)')
  .action(async (options) => {
    try {
      validateConfig();
    } catch (err: any) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }

    const runner = new ClaudeRunner({
      runId: options.runId,
      capabilityToken: options.token,
      workingDir: options.cwd
    });

    const url = await runner.startAssistSession();
    if (url) {
      console.log('\n=== Assist Session Ready ===');
      console.log(`Connect: ${url}`);
      console.log('Session URL has been sent to the gateway.');
      console.log('The session will remain active until you close this terminal.');
    } else {
      console.error('Failed to start assist session');
      process.exit(1);
    }

    // Keep process alive
    process.on('SIGINT', () => {
      console.log('\nAssist session ended');
      process.exit(0);
    });
  });

program
  .command('test-connection')
  .description('Test connectivity to the gateway')
  .action(async () => {
    console.log(`Testing connection to ${config.gatewayUrl}...`);
    const connected = await testConnection();
    if (connected) {
      console.log('✓ Connection successful');
    } else {
      console.error('✗ Connection failed');
      process.exit(1);
    }
  });

program
  .command('info')
  .description('Show configuration info')
  .action(() => {
    console.log('Claude Runner Configuration:');
    console.log(`  Gateway URL: ${config.gatewayUrl}`);
    console.log(`  HMAC Secret: ${config.hmacSecret ? '(set)' : '(not set)'}`);
    console.log(`  Claude Command: ${config.claudeCommand}`);
    console.log(`  Working Dir: ${config.projectRoot}`);
    console.log(`  Runs Dir: ${config.runsDir}`);
    console.log(`  Allow Self-Signed: ${config.allowSelfSignedCerts}`);

    const creds = loadCredentials();
    if (creds?.sessionToken) {
      console.log(`\nLogged in as: ${creds.username} (${creds.role})`);
    } else {
      console.log('\nNot logged in');
    }
  });

// ============================================================================
// Interactive Mode
// ============================================================================

program
  .command('interactive')
  .alias('i')
  .description('Start interactive shell for managing runs')
  .action(async () => {
    const auth = await getUIAuth();
    const readline = await import('readline');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'claude> '
    });

    console.log('Claude Runner Interactive Mode');
    console.log('Commands: list, show <id>, run, stop <id>, halt <id>, escape <id>, restart <id>, resume <id>, quit');
    console.log('');

    rl.prompt();

    rl.on('line', async (line) => {
      const args = line.trim().split(/\s+/);
      const cmd = args[0];

      try {
        switch (cmd) {
          case 'list':
          case 'ls':
            const runs = await listRuns(auth, { limit: 10 });
            for (const run of runs.runs) {
              console.log(`  ${run.id}  ${statusDisplay(run.status).padEnd(12)} ${run.command?.substring(0, 40) || '-'}`);
            }
            break;

          case 'show':
            if (!args[1]) {
              console.log('Usage: show <runId>');
            } else {
              const state = await getRunState(auth, args[1]);
              console.log(`Status: ${statusDisplay(state.run.status)}`);
              console.log(`Command: ${state.run.command || '-'}`);
              console.log(`Duration: ${formatDuration(state.run.started_at, state.run.finished_at)}`);
            }
            break;

          case 'stop':
            if (!args[1]) {
              console.log('Usage: stop <runId>');
            } else {
              await stopRun(auth, args[1]);
              console.log(`Stop requested for ${args[1]}`);
            }
            break;

          case 'halt':
            if (!args[1]) {
              console.log('Usage: halt <runId>');
            } else {
              await haltRun(auth, args[1]);
              console.log(`Halt requested for ${args[1]}`);
            }
            break;

          case 'escape':
            if (!args[1]) {
              console.log('Usage: escape <runId>');
            } else {
              await sendEscape(auth, args[1]);
              console.log(`Escape sent to ${args[1]}`);
            }
            break;

          case 'quit':
          case 'exit':
          case 'q':
            rl.close();
            process.exit(0);
            break;

          case '':
            break;

          default:
            console.log(`Unknown command: ${cmd}`);
            console.log('Commands: list, show <id>, stop <id>, halt <id>, escape <id>, quit');
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
      }

      rl.prompt();
    });

    rl.on('close', () => {
      process.exit(0);
    });
  });

program.parse();
