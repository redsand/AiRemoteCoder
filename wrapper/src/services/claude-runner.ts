import { BaseRunner, RunnerOptions, WorkerCommandResult } from './base-runner.js';
import { config } from '../config.js';
import { spawn, ChildProcess } from 'child_process';
import { ackCommand } from './gateway-client.js';
import { randomUUID } from 'crypto';
import { resolve as pathResolve, relative as pathRelative, normalize as pathNormalize, join as pathJoin } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'fs';

// Re-export RunnerOptions for convenience
export type { RunnerOptions };

export interface ClaudeRunnerOptions extends RunnerOptions {
  // No Claude-specific options needed currently
}

/**
 * Claude Code runner implementation
 *
 * ARCHITECTURE: Interactive session with persistent process
 *
 * Claude Code interactive mode allows maintaining conversation context
 * across multiple commands without respawning for each input.
 *
 * Design:
 * 1. Generate a unique session ID when the runner starts
 * 2. Spawn ONE persistent Claude process (no --print flag)
 * 3. Keep stdin open for sending commands
 * 4. Continuously read stdout/stderr
 * 5. Send commands via stdin when __INPUT__ received
 * 6. Process stays alive until __STOP__ or error
 * 7. Session ID maintains conversation context
 *
 * This gives us:
 * - True interactive experience (continuous conversation)
 * - Efficient resource usage (one process, not many)
 * - Real-time bidirectional communication
 * - Full conversation context preservation
 */
export class ClaudeRunner extends BaseRunner {
  private sessionId: string;

  constructor(options: ClaudeRunnerOptions) {
    super(options);
    // Generate a unique session ID for this runner instance
    // Claude will maintain conversation context in this session
    this.sessionId = randomUUID();
    console.log(`Claude session ID: ${this.sessionId}`);
  }

  /**
   * Get the worker type identifier
   */
  getWorkerType(): string {
    return 'claude';
  }

  /**
   * Extend environment with gateway auth so .claude/hooks/ scripts
   * can POST tool-use and lifecycle events directly to the gateway.
   */
  protected buildEnvironment(): NodeJS.ProcessEnv {
    return {
      ...super.buildEnvironment(),
      AI_GATEWAY_URL: config.gatewayUrl,
      AI_HMAC_SECRET: config.hmacSecret,
      AI_RUN_ID: this.auth.runId,
      AI_CAPABILITY_TOKEN: this.auth.capabilityToken,
      AI_ALLOW_SELF_SIGNED: config.allowSelfSignedCerts ? 'true' : 'false',
    };
  }

  /**
   * Get the CLI command for Claude
   */
  getCommand(): string {
    return config.claudeCommand;
  }

  /**
   * Override to disable shell mode for Claude
   * Claude CLI doesn't need shell mode and using it causes argument escaping issues on Windows
   */
  protected shouldUseShell(): boolean {
    return false;
  }

  /**
   * Build Claude Code command arguments for interactive mode
   *
   * INTERACTIVE MODE:
   * - Spawn ONE persistent Claude process
   * - Send input via stdin
   * - Keep process alive for the entire session
   * - Use --permission-mode to prevent permission prompts
   * - Use --session-id for conversation context
   */
  buildCommand(_command?: string, _autonomous?: boolean): WorkerCommandResult {
    const args: string[] = [];

    // DO NOT use --print for interactive mode
    // We keep the process alive and send input via stdin

    // Always use --permission-mode acceptEdits to prevent permission prompts
    args.push('--permission-mode', 'acceptEdits');

    // Use session ID to maintain conversation context
    args.push('--session-id', this.sessionId);

    // Add model if specified
    if (this.model) {
      args.push('--model', this.model);
    }

    const fullCommand = `${this.getCommand()} ${args.join(' ')}`.trim();

    return { args, fullCommand };
  }

  /**
   * Provision .claude/hooks/ and settings.json into workingDir so Claude
   * picks up the hook scripts regardless of which directory it runs in.
   *
   * - If workingDir IS the AiRemoteCoder project root, the files are already
   *   committed to the repo and nothing needs to happen.
   * - Otherwise we copy the hook scripts and merge our hooks entry into the
   *   target's settings.json, preserving any hooks the target already defines.
   */
  private ensureHooksDirectory(): void {
    const sourceClaudeDir = pathJoin(config.projectRoot, '.claude');
    const targetClaudeDir = pathJoin(this.workingDir, '.claude');

    // Same directory – files are already in place.
    if (pathResolve(sourceClaudeDir) === pathResolve(targetClaudeDir)) {
      return;
    }

    const sourceHooksDir = pathJoin(sourceClaudeDir, 'hooks');
    const sourceSettingsPath = pathJoin(sourceClaudeDir, 'settings.json');

    // Nothing to provision if the source doesn't have our hooks.
    if (!existsSync(sourceHooksDir) || !existsSync(sourceSettingsPath)) {
      return;
    }

    // Ensure target .claude/hooks/ exists.
    const targetHooksDir = pathJoin(targetClaudeDir, 'hooks');
    mkdirSync(targetHooksDir, { recursive: true });

    // Copy every hook script, overwriting so they stay current with the
    // bundled version from the wrapper package.
    for (const file of readdirSync(sourceHooksDir)) {
      if (file.endsWith('.py')) {
        copyFileSync(pathJoin(sourceHooksDir, file), pathJoin(targetHooksDir, file));
      }
    }

    // Merge hooks into target settings.json.  Read both sides, add only the
    // hook keys that the target does not already define, then write back.
    const sourceSettings: Record<string, any> = JSON.parse(readFileSync(sourceSettingsPath, 'utf8'));
    const targetSettingsPath = pathJoin(targetClaudeDir, 'settings.json');

    let targetSettings: Record<string, any> = {};
    if (existsSync(targetSettingsPath)) {
      try {
        targetSettings = JSON.parse(readFileSync(targetSettingsPath, 'utf8'));
      } catch {
        // malformed – start fresh
      }
    }

    if (sourceSettings.hooks) {
      if (!targetSettings.hooks) {
        targetSettings.hooks = {};
      }
      for (const [name, value] of Object.entries(sourceSettings.hooks)) {
        if (!targetSettings.hooks[name]) {
          targetSettings.hooks[name] = value;
        }
      }
      writeFileSync(targetSettingsPath, JSON.stringify(targetSettings, null, 2));
    }

    console.log('Provisioned .claude/hooks into', targetClaudeDir);
  }

  /**
   * Start Claude in interactive mode
   *
   * INTERACTIVE MODE:
   * - Spawn ONE persistent Claude process
   * - Keep stdin open for sending commands
   * - Continuously read stdout/stderr
   * - Process only exits on __STOP__ or error
   */
  async start(command?: string): Promise<void> {
    console.log('\n>>> Starting Claude Code in interactive mode');

    try {
      // Provision hook scripts into workingDir before Claude starts
      this.ensureHooksDirectory();

      // Mark as running
      (this as any).isRunning = true;

      // Send start marker
      await this.sendMarker('started', {
        event: 'started',
        command: command || '(waiting for input)',
        workingDir: this.workingDir,
        workerType: 'claude',
        sessionId: this.sessionId
      });

      // Build command arguments (no --print for interactive mode)
      const { args } = this.buildCommand();
      const cmd = this.getCommand();
      const env = this.buildEnvironment();

      console.log(`[DEBUG] Spawning Claude interactive process: ${cmd} ${args.join(' ')}`);

      // Spawn Claude process with piped stdin for sending commands
      this.process = spawn(cmd, args, {
        cwd: this.workingDir,
        shell: false,  // No shell mode - use direct spawning for proper argument handling
        stdio: ['pipe', 'pipe', 'pipe'],  // Pipe stdin (for commands), stdout, stderr
        env,
        windowsHide: false,
      });

      console.log(`Process spawned with PID: ${this.process.pid}`);

      // Set up output handlers
      this.setupOutputHandlers();

      // Set up process close handler
      this.process.on('close', async (code, signal) => {
        console.log(`\n>>> Claude process closed (code: ${code}, signal: ${signal})`);

        if ((this as any).stopRequested) {
          // Expected shutdown
          console.log('Claude shut down as requested');
        } else {
          // Unexpected shutdown - process died without stop requested
          console.error('Claude process exited unexpectedly!');
          await this.sendEvent('error', `Claude process exited unexpectedly with code ${code}, signal ${signal}`);
        }

        // Call handleExit to clean up and terminate worker
        await this.handleExit(code, signal);
      });

      this.process.on('error', async (err) => {
        console.error(`Claude process error:`, err);
        await this.sendEvent('error', `Claude process error: ${err.message}`);
        await this.handleExit(1, null);
      });

      // If an initial command was provided, send it after process starts
      if (command && command.trim().length > 0) {
        // Wait a bit for Claude to be ready
        await new Promise(resolve => setTimeout(resolve, 500));
        console.log(`Sending initial command via stdin...`);
        this.sendInput(command);
      }

      // Start polling and heartbeat
      (this as any).startCommandPolling();
      (this as any).startHeartbeat();

    } catch (err: any) {
      console.error(`Failed to start Claude: ${err.message}`);
      throw err;
    }
  }

  /**
   * Set up stdout/stderr handlers for the persistent Claude process
   */
  private setupOutputHandlers(): void {
    if (!this.process) return;

    // Handle stdout
    this.process.stdout?.on('data', async (data: Buffer) => {
      const text = data.toString();
      console.log(`[Claude stdout] ${text.substring(0, 100)}`);

      // Forward to log and gateway
      (this as any).logStream?.write(`[stdout] ${text}`);

      try {
        await this.sendEvent('stdout', text);
      } catch (err) {
        console.error('Failed to send event:', err);
      }

      // Emit for prompt detection
      this.emit('stdout', text);
    });

    // Handle stderr
    this.process.stderr?.on('data', async (data: Buffer) => {
      const text = data.toString();
      console.log(`[Claude stderr] ${text.substring(0, 100)}`);
      (this as any).logStream?.write(`[stderr] ${text}`);

      try {
        await this.sendEvent('stderr', text);
      } catch (err) {
        console.error('Failed to send event:', err);
      }
    });
  }

  /**
   * Execute a command by sending it to the persistent Claude process via stdin
   */
  async executeCommand(cmd: any): Promise<void> {
    // Handle __INPUT__ commands
    if (cmd.command.startsWith('__INPUT__:')) {
      const input = cmd.command.substring('__INPUT__:'.length);

      console.log(`\n>>> Claude command (sending via stdin)`);
      console.log(`    Command ID: ${cmd.id}`);
      console.log(`    Input: ${input.substring(0, 50)}...`);

      try {
        // Send acknowledgment to gateway
        await this.sendEvent('info', `Processing Claude command: ${input.substring(0, 100)}`);

        // Mark as processed to prevent re-execution
        (this as any).markCommandProcessed(cmd.id, 30 * 60 * 1000);

        // Send input to Claude via stdin
        this.sendInput(input);

        console.log(`    ✓ Command sent to Claude`);

        // Acknowledge success (we don't wait for output, just acknowledge the command was sent)
        try {
          await ackCommand(this.auth, cmd.id, `Command sent to Claude`);
          console.log(`    ✓ Command acknowledged`);
        } catch (err: any) {
          console.error(`Failed to acknowledge command:`, err.message);
        }

      } catch (err: any) {
        console.error(`\n>>> Failed to process Claude command:`, err.message);
        await this.sendEvent('error', `Failed to process command: ${err.message}`);

        // Acknowledge failure
        try {
          await ackCommand(this.auth, cmd.id, undefined, `Error: ${err.message.substring(0, 200)}`);
        } catch (ackErr: any) {
          console.error(`Failed to acknowledge error:`, ackErr.message);
        }
      }

      return;
    }

    // For non-input commands, use base class implementation
    await super.executeCommand(cmd);
  }

  /**
   * Stop Claude by killing the persistent process
   */
  async stop(): Promise<void> {
    console.log('\n>>> Stopping Claude');

    (this as any).stopRequested = true;

    try {
      await this.sendEvent('info', 'Stopping Claude session');
    } catch (err) {
      console.error('Failed to send stop event:', err);
    }

    // Kill the persistent Claude process
    if (this.process) {
      console.log('Killing Claude process...');
      this.process.kill('SIGINT');

      // Force kill after a short timeout
      setTimeout(() => {
        if (this.process) {
          console.log('Force killing Claude process...');
          this.process.kill('SIGKILL');
        }
      }, 2000);
    }
  }
}

/**
 * Parse a cd command and extract the target directory
 * Returns null if not a cd command, empty string for bare 'cd', or the trimmed path
 */
export function parseCdCommand(command: string): string | null {
  if (!command.startsWith('cd')) {
    return null;
  }
  // Check if it's exactly 'cd' (bare cd)
  if (command === 'cd') {
    return '';
  }
  // Must have space after 'cd'
  if (!command.startsWith('cd ')) {
    return null;
  }
  return command.substring(3).trim();
}

/**
 * Validate that a path stays within the sandbox root
 * Prevents directory traversal attacks
 */
export function isPathSafe(path: string, sandboxRoot: string): boolean {
  try {
    // Normalize paths first to handle both POSIX and Windows formats
    const normalizedRoot = pathNormalize(sandboxRoot);
    const normalizedPath = pathNormalize(path);

    // Resolve the path relative to the sandbox root
    const resolved = pathResolve(normalizedRoot, normalizedPath);
    const normalizedResolved = pathNormalize(resolved);

    // Normalize the root as well
    const normalizedRootResolved = pathNormalize(pathResolve(normalizedRoot));

    // Convert both to forward slashes for consistent comparison
    const resolvedForComparison = normalizedResolved.replace(/\\/g, '/').toLowerCase();
    const rootForComparison = normalizedRootResolved.replace(/\\/g, '/').toLowerCase();

    // Check if resolved path is within the sandbox
    // This works even if paths have different drive letters or are POSIX vs Windows
    return (
      resolvedForComparison === rootForComparison ||
      resolvedForComparison.startsWith(rootForComparison + '/')
    );
  } catch {
    return false;
  }
}

/**
 * Get the relative path from root, or return root if at root
 */
export function getRelativePath(current: string, root: string): string {
  try {
    // Normalize both paths for comparison
    const normalizedRoot = pathNormalize(root);
    const normalizedCurrent = pathNormalize(current);

    const rel = pathRelative(normalizedRoot, normalizedCurrent);

    // If relative path is empty or '.', we're at the root - return original root path
    if (!rel || rel === '.') {
      return root;
    }
    // Convert backslashes to forward slashes for consistency
    return rel.replace(/\\/g, '/');
  } catch {
    return '';
  }
}
