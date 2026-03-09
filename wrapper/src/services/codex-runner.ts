import { BaseRunner, RunnerOptions, WorkerCommandResult } from './base-runner.js';
import { config } from '../config.js';
import { spawn, ChildProcess } from 'child_process';
import { ackCommand } from './gateway-client.js';
import { randomUUID } from 'crypto';

// Re-export RunnerOptions for convenience
export type { RunnerOptions };

export interface CodexRunnerOptions extends RunnerOptions {
  // No Codex-specific options needed currently
}

/**
 * Codex runner implementation with interactive mode
 *
 * ARCHITECTURE: Interactive session with persistent process
 *
 * Codex CLI defaults to interactive mode when no subcommand is specified.
 * Using the 'exec' subcommand would switch to non-interactive headless mode.
 *
 * Design:
 * 1. Generate a unique session ID when the runner starts
 * 2. Spawn ONE persistent Codex process (default interactive mode)
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
 *
 * Note: Codex supports session management via 'resume' subcommand
 * We use a session ID for tracking but Codex manages its own sessions
 */
export class CodexRunner extends BaseRunner {
  private sessionId: string;

  constructor(options: CodexRunnerOptions) {
    super(options);
    // Generate a unique session ID for this runner instance
    // Codex manages its own sessions, but we track ours for logging
    this.sessionId = randomUUID();
    console.log(`Codex session ID: ${this.sessionId}`);
  }

  /**
   * Get the worker type identifier
   */
  getWorkerType(): string {
    return 'codex';
  }

  /**
   * Build environment variables for Codex
   */
  protected buildEnvironment(): NodeJS.ProcessEnv {
    const baseEnv = super.buildEnvironment();
    return {
      ...baseEnv,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      CODEX_API_KEY: process.env.CODEX_API_KEY || ''
    };
  }

  /**
   * Get the CLI command for Codex
   */
  getCommand(): string {
    return config.codexCommand;
  }

  /**
   * Override to use shell mode for Codex on Windows
   * Codex CLI is a PowerShell script on Windows and needs shell mode
   */
  protected shouldUseShell(): boolean {
    return process.platform === 'win32';
  }

  /**
   * Build Codex command arguments for interactive mode
   *
   * INTERACTIVE MODE (default):
   * - Spawn ONE persistent Codex process
   * - Send input via stdin
   * - Keep process alive for the entire session
   * - DO NOT use 'exec' subcommand (that's for non-interactive mode)
   * - DO NOT use 'resume' subcommand (starts a new session)
   */
  buildCommand(_command?: string, autonomous?: boolean): WorkerCommandResult {
    const args: string[] = [];

    // DO NOT use 'exec' subcommand - that's for non-interactive mode
    // DO NOT use 'resume' subcommand - that resumes a previous session
    // By default, Codex runs in interactive mode

    // Add config args
    if (config.codexArgs.length > 0) {
      args.push(...config.codexArgs);
    }

    const fullCommand = args.length > 0
      ? `${this.getCommand()} ${args.join(' ')}`
      : this.getCommand();

    return { args, fullCommand };
  }

  /**
   * Start Codex in interactive mode
   *
   * INTERACTIVE MODE:
   * - Spawn ONE persistent Codex process
   * - Keep stdin open for sending commands
   * - Continuously read stdout/stderr
   * - Process only exits on __STOP__ or error
   */
  async start(command?: string): Promise<void> {
    console.log('\n>>> Starting Codex in interactive mode');

    try {
      // Mark as running
      (this as any).isRunning = true;

      // Send start marker
      await this.sendMarker('started', {
        event: 'started',
        command: command || '(waiting for input)',
        workingDir: this.workingDir,
        workerType: 'codex',
        sessionId: this.sessionId
      });

      // Build command arguments (default interactive mode, no subcommand)
      const { args } = this.buildCommand();
      const cmd = this.getCommand();
      const env = this.buildEnvironment();

      console.log(`[DEBUG] Spawning Codex interactive process: ${cmd} ${args.join(' ')}`);

      // Codex needs shell mode on Windows (it's a PowerShell script)
      const useShell = this.shouldUseShell();

      // Spawn Codex process with piped stdin for sending commands
      this.process = spawn(cmd, args, {
        cwd: this.workingDir,
        shell: useShell,
        stdio: ['pipe', 'pipe', 'pipe'],  // Pipe stdin (for commands), stdout, stderr
        env,
        windowsHide: false,
      });

      console.log(`Process spawned with PID: ${this.process.pid}`);

      // Set up output handlers
      this.setupOutputHandlers();

      // Set up process close handler
      this.process.on('close', async (code, signal) => {
        console.log(`\n>>> Codex process closed (code: ${code}, signal: ${signal})`);

        if ((this as any).stopRequested) {
          // Expected shutdown
          console.log('Codex shut down as requested');
        } else {
          // Unexpected shutdown - process died without stop requested
          console.error('Codex process exited unexpectedly!');
          await this.sendEvent('error', `Codex process exited unexpectedly with code ${code}, signal ${signal}`);
        }

        // Call handleExit to clean up and terminate worker
        await this.handleExit(code, signal);
      });

      this.process.on('error', async (err) => {
        console.error(`Codex process error:`, err);
        await this.sendEvent('error', `Codex process error: ${err.message}`);
        await this.handleExit(1, null);
      });

      // If an initial command was provided, send it after process starts
      if (command && command.trim().length > 0) {
        // Wait a bit for Codex to be ready (interactive mode needs to initialize)
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log(`Sending initial command via stdin...`);
        this.sendInput(command);
      }

      // Start polling and heartbeat
      (this as any).startCommandPolling();
      (this as any).startHeartbeat();

    } catch (err: any) {
      console.error(`Failed to start Codex: ${err.message}`);
      throw err;
    }
  }

  /**
   * Set up stdout/stderr handlers for the persistent Codex process
   */
  private setupOutputHandlers(): void {
    if (!this.process) return;

    // Handle stdout
    this.process.stdout?.on('data', async (data: Buffer) => {
      const text = data.toString();
      console.log(`[Codex stdout] ${text.substring(0, 100)}`);

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
      console.log(`[Codex stderr] ${text.substring(0, 100)}`);
      (this as any).logStream?.write(`[stderr] ${text}`);

      try {
        await this.sendEvent('stderr', text);
      } catch (err) {
        console.error('Failed to send event:', err);
      }
    });
  }

  /**
   * Execute a command by sending it to the persistent Codex process via stdin
   */
  async executeCommand(cmd: any): Promise<void> {
    // Handle __INPUT__ commands
    if (cmd.command.startsWith('__INPUT__:')) {
      const input = cmd.command.substring('__INPUT__:'.length);

      console.log(`\n>>> Codex command (sending via stdin)`);
      console.log(`    Command ID: ${cmd.id}`);
      console.log(`    Input: ${input.substring(0, 50)}...`);

      try {
        // Send acknowledgment to gateway
        await this.sendEvent('info', `Processing Codex command: ${input.substring(0, 100)}`);

        // Mark as processed to prevent re-execution
        (this as any).markCommandProcessed(cmd.id, 30 * 60 * 1000);

        // Send input to Codex via stdin
        this.sendInput(input);

        console.log(`    ✓ Command sent to Codex`);

        // Acknowledge success (we don't wait for output, just acknowledge the command was sent)
        try {
          await ackCommand(this.auth, cmd.id, `Command sent to Codex`);
          console.log(`    ✓ Command acknowledged`);
        } catch (err: any) {
          console.error(`Failed to acknowledge command:`, err.message);
        }

      } catch (err: any) {
        console.error(`\n>>> Failed to process Codex command:`, err.message);
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
   * Stop Codex by killing the persistent process
   */
  async stop(): Promise<void> {
    console.log('\n>>> Stopping Codex');

    (this as any).stopRequested = true;

    try {
      await this.sendEvent('info', 'Stopping Codex interactive session');
    } catch (err) {
      console.error('Failed to send stop event:', err);
    }

    // Kill the persistent Codex process
    if (this.process) {
      console.log('Killing Codex process...');
      this.process.kill('SIGINT');

      // Force kill after a short timeout
      setTimeout(() => {
        if (this.process) {
          console.log('Force killing Codex process...');
          this.process.kill('SIGKILL');
        }
      }, 2000);
    }
  }
}