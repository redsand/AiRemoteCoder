#!/usr/bin/env node

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { config, validateConfig } from './config.js';
import { ClaudeRunner } from './services/claude-runner.js';
import { GenericRunner, createGenericRunner } from './services/generic-runner.js';
import {
  testConnection,
  login,
  getAuthStatus,
  listRuns,
  getRun,
  getRunState,
  createRun,
  stopRun,
  haltRun,
  restartRun,
  sendInput,
  sendEscape,
  type UIAuth
} from './services/gateway-client.js';
import { type WorkerType, getWorkerDisplayName, isValidWorkerType } from './services/worker-registry.js';
import type { BaseRunner } from './services/base-runner.js';

const program = new Command();

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
  .name('claude-runner')
  .description('Claude Code wrapper for Connect-Back Gateway - Full workflow control')
  .version('1.0.0');

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
  .description('Create and start a new autonomous run (no prompt needed)')
  .option('-c, --cwd <path>', 'Working directory')
  .option('-p, --prompt <prompt>', 'Initial prompt (optional)')
  .option('-w, --worker-type <type>', 'Worker type (claude, ollama, ollama-launch, codex, gemini, rev)', 'claude')
  .option('-m, --model <model>', 'Model to use (for Ollama, Gemini, etc.)')
  .option('--autonomous', 'Run in fully autonomous mode', true)
  .option('--no-autonomous', 'Run in interactive mode')
  .action(async (options) => {
    try {
      validateConfig();

      // Validate worker type
      const workerType = options.workerType;
      if (!isValidWorkerType(workerType)) {
        console.error(`Invalid worker type: ${workerType}`);
        console.error('Valid worker types: claude, ollama, codex, gemini, rev');
        process.exit(1);
      }

      const auth = await getUIAuth();

      // Create a new run on the gateway with worker type
      const createResult = await createRun(auth, {
        command: options.prompt,
        workingDir: options.cwd || process.cwd(),
        autonomous: options.autonomous,
        workerType,
        model: options.model
      });

      console.log(`Created run: ${createResult.id}`);
      console.log(`Worker: ${getWorkerDisplayName(workerType)}`);
      if (options.model) {
        console.log(`Model: ${options.model}`);
      }
      console.log(`Mode: ${createResult.autonomous ? 'Autonomous' : 'Interactive'}`);

      // Test gateway connection
      const connected = await testConnection();
      if (!connected) {
        console.error(`Cannot connect to gateway at ${config.gatewayUrl}`);
        process.exit(1);
      }

      // Create the appropriate runner based on worker type
      let runner: BaseRunner;

      if (workerType === 'claude') {
        runner = new ClaudeRunner({
          runId: createResult.id,
          capabilityToken: createResult.capabilityToken,
          workingDir: options.cwd,
          autonomous: options.autonomous
        });
      } else {
        runner = createGenericRunner(workerType as WorkerType, {
          runId: createResult.id,
          capabilityToken: createResult.capabilityToken,
          workingDir: options.cwd,
          autonomous: options.autonomous,
          model: options.model
        });
      }

      runner.on('stdout', (data) => process.stdout.write(data));
      runner.on('stderr', (data) => process.stderr.write(data));
      runner.on('exit', (code) => {
        console.log(`\nRun finished with exit code ${code}`);
        process.exit(code);
      });

      // Handle graceful shutdown
      process.on('SIGINT', async () => {
        console.log('\nReceived SIGINT, stopping...');
        await runner.stop();
      });

      process.on('SIGTERM', async () => {
        console.log('\nReceived SIGTERM, stopping...');
        await runner.stop();
      });

      await runner.start(options.prompt);
    } catch (err: any) {
      console.error(`Failed to start: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('start')
  .description('Start a worker run with a specific run ID and token')
  .requiredOption('--run-id <id>', 'Run ID from gateway')
  .requiredOption('--token <token>', 'Capability token from gateway')
  .option('--cmd <command>', 'Worker command/prompt')
  .option('--cwd <path>', 'Working directory (defaults to current)')
  .option('-w, --worker-type <type>', 'Worker type (claude, ollama, ollama-launch, codex, gemini, rev)', 'claude')
  .option('-m, --model <model>', 'Model to use (for Ollama, Gemini, etc.)')
  .option('--autonomous', 'Run in autonomous mode')
  .action(async (options) => {
    try {
      validateConfig();
    } catch (err: any) {
      console.error(`Configuration error: ${err.message}`);
      console.error('Make sure HMAC_SECRET is set in .env or environment');
      process.exit(1);
    }

    // Validate worker type
    const workerType = options.workerType;
    if (!isValidWorkerType(workerType)) {
      console.error(`Invalid worker type: ${workerType}`);
      console.error('Valid worker types: claude, ollama, codex, gemini, rev');
      process.exit(1);
    }

    console.log('Testing gateway connection...');
    const connected = await testConnection();
    if (!connected) {
      console.error(`Cannot connect to gateway at ${config.gatewayUrl}`);
      console.error('Make sure the gateway is running and GATEWAY_URL is correct');
      process.exit(1);
    }
    console.log('Gateway connection OK');
    console.log(`Worker: ${getWorkerDisplayName(workerType)}`);
    if (options.model) {
      console.log(`Model: ${options.model}`);
    }

    // Create the appropriate runner based on worker type
    let runner: BaseRunner;

    if (workerType === 'claude') {
      runner = new ClaudeRunner({
        runId: options.runId,
        capabilityToken: options.token,
        workingDir: options.cwd,
        autonomous: options.autonomous
      });
    } else {
      runner = createGenericRunner(workerType as WorkerType, {
        runId: options.runId,
        capabilityToken: options.token,
        workingDir: options.cwd,
        autonomous: options.autonomous,
        model: options.model
      });
    }

    runner.on('stdout', (data) => process.stdout.write(data));
    runner.on('stderr', (data) => process.stderr.write(data));
    runner.on('exit', (code) => {
      console.log(`\n${getWorkerDisplayName(workerType)} finished with exit code ${code}`);
      process.exit(code);
    });

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nReceived SIGINT, stopping...');
      await runner.stop();
    });

    process.on('SIGTERM', async () => {
      console.log('\nReceived SIGTERM, stopping...');
      await runner.stop();
    });

    try {
      await runner.start(options.cmd);
    } catch (err: any) {
      console.error(`Failed to start: ${err.message}`);
      process.exit(1);
    }
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
