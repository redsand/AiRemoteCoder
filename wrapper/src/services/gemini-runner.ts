import { BaseRunner, RunnerOptions, WorkerCommandResult } from './base-runner.js';
import { config } from '../config.js';
import { spawn, ChildProcess } from 'child_process';
import { ackCommand } from './gateway-client.js';
import { randomUUID } from 'crypto';

// Re-export RunnerOptions for convenience
export type { RunnerOptions };

export interface GeminiRunnerOptions extends RunnerOptions {
  // No Gemini-specific options needed currently
}

/**
 * Gemini runner implementation with interactive mode
 *
 * ARCHITECTURE: Interactive session with persistent process
 *
 * Gemini CLI defaults to interactive mode (no special flag needed).
 * Using -p/--prompt would switch to non-interactive headless mode.
 *
 * Design:
 * 1. Generate a unique session ID when the runner starts
 * 2. Spawn ONE persistent Gemini process (default interactive mode)
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
 * Note: Gemini supports session management via --resume flag
 * We use a session ID for tracking but Gemini manages its own sessions
 */
export class GeminiRunner extends BaseRunner {
  private sessionId: string;

  constructor(options: GeminiRunnerOptions) {
    super(options);
    // Generate a unique session ID for this runner instance
    // Gemini manages its own sessions, but we track ours for logging
    this.sessionId = randomUUID();
    console.log(`Gemini session ID: ${this.sessionId}`);
  }

  /**
   * Get the worker type identifier
   */
  getWorkerType(): string {
    return 'gemini';
  }

  /**
   * Build environment variables for Gemini
   */
  protected buildEnvironment(): NodeJS.ProcessEnv {
    const baseEnv = super.buildEnvironment();
    return {
      ...baseEnv,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || '',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || ''
    };
  }

  /**
   * Get the CLI command for Gemini
   */
  getCommand(): string {
    return config.geminiCommand;
  }

  /**
   * Override to disable shell mode for Gemini
   * Gemini CLI doesn't need shell mode and using it causes argument escaping issues on Windows
   */
  protected shouldUseShell(): boolean {
    return false;
  }

  /**
   * Build Gemini command arguments for interactive mode
   *
   * INTERACTIVE MODE (default):
   * - Spawn ONE persistent Gemini process
   * - Send input via stdin
   * - Keep process alive for the entire session
   * - Use --approval-mode yolo to prevent permission prompts
   * - DO NOT use -p/--prompt (that's for non-interactive headless mode)
   */
  buildCommand(_command?: string, autonomous?: boolean): WorkerCommandResult {
    const args: string[] = [];

    // DO NOT use -p/--prompt - that switches to non-interactive headless mode
    // By default, Gemini runs in interactive mode

    // Use --approval-mode yolo to auto-approve all tools
    args.push('--approval-mode', 'yolo');

    // Add model if specified
    if (this.model) {
      args.push('--model', this.model);
    }

    // Use text output format for consistency
    args.push('--output-format', 'text');

    // Add config args
    if (config.geminiArgs.length > 0) {
      args.push(...config.geminiArgs);
    }

    const fullCommand = `${this.getCommand()} ${args.join(' ')}`;

    return { args, fullCommand };
  }

  /**
   * Start Gemini in interactive mode
   *
   * INTERACTIVE MODE:
   * - Spawn ONE persistent Gemini process
   * - Keep stdin open for sending commands
   * - Continuously read stdout/stderr
   * - Process only exits on __STOP__ or error
   */
  async start(command?: string): Promise<void> {
    console.log('\n>>> Starting Gemini in interactive mode');

    try {
      // Mark as running
      (this as any).isRunning = true;

      // Send start marker
      await this.sendMarker('started', {
        event: 'started',
        command: command || '(waiting for input)',
        workingDir: this.workingDir,
        workerType: 'gemini',
        sessionId: this.sessionId,
        model: this.model
      });

      // Build command arguments (default interactive mode, no -p flag)
      const { args } = this.buildCommand();
      const cmd = this.getCommand();
      const env = this.buildEnvironment();

      console.log(`[DEBUG] Spawning Gemini interactive process: ${cmd} ${args.join(' ')}`);

      // Spawn Gemini process with piped stdin for sending commands
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
        console.log(`\n>>> Gemini process closed (code: ${code}, signal: ${signal})`);

        if ((this as any).stopRequested) {
          // Expected shutdown
          console.log('Gemini shut down as requested');
        } else {
          // Unexpected shutdown - process died without stop requested
          console.error('Gemini process exited unexpectedly!');
          await this.sendEvent('error', `Gemini process exited unexpectedly with code ${code}, signal ${signal}`);
        }

        // Call handleExit to clean up and terminate worker
        await this.handleExit(code, signal);
      });

      this.process.on('error', async (err) => {
        console.error(`Gemini process error:`, err);
        await this.sendEvent('error', `Gemini process error: ${err.message}`);
        await this.handleExit(1, null);
      });

      // If an initial command was provided, send it after process starts
      if (command && command.trim().length > 0) {
        // Wait a bit for Gemini to be ready (interactive mode needs to initialize)
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log(`Sending initial command via stdin...`);
        this.sendInput(command);
      }

      // Start polling and heartbeat
      (this as any).startCommandPolling();
      (this as any).startHeartbeat();

    } catch (err: any) {
      console.error(`Failed to start Gemini: ${err.message}`);
      throw err;
    }
  }

  /**
   * Set up stdout/stderr handlers for the persistent Gemini process
   */
  private setupOutputHandlers(): void {
    if (!this.process) return;

    // Handle stdout
    this.process.stdout?.on('data', async (data: Buffer) => {
      const text = data.toString();
      console.log(`[Gemini stdout] ${text.substring(0, 100)}`);

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
      console.log(`[Gemini stderr] ${text.substring(0, 100)}`);
      (this as any).logStream?.write(`[stderr] ${text}`);

      try {
        await this.sendEvent('stderr', text);
      } catch (err) {
        console.error('Failed to send event:', err);
      }
    });
  }

  /**
   * Execute a command by sending it to the persistent Gemini process via stdin
   */
  async executeCommand(cmd: any): Promise<void> {
    // Handle __INPUT__ commands
    if (cmd.command.startsWith('__INPUT__:')) {
      const input = cmd.command.substring('__INPUT__:'.length);

      console.log(`\n>>> Gemini command (sending via stdin)`);
      console.log(`    Command ID: ${cmd.id}`);
      console.log(`    Input: ${input.substring(0, 50)}...`);

      try {
        // Send acknowledgment to gateway
        await this.sendEvent('info', `Processing Gemini command: ${input.substring(0, 100)}`);

        // Mark as processed to prevent re-execution
        (this as any).markCommandProcessed(cmd.id, 30 * 60 * 1000);

        // Send input to Gemini via stdin
        this.sendInput(input);

        console.log(`    ✓ Command sent to Gemini`);

        // Acknowledge success (we don't wait for output, just acknowledge the command was sent)
        try {
          await ackCommand(this.auth, cmd.id, `Command sent to Gemini`);
          console.log(`    ✓ Command acknowledged`);
        } catch (err: any) {
          console.error(`Failed to acknowledge command:`, err.message);
        }

      } catch (err: any) {
        console.error(`\n>>> Failed to process Gemini command:`, err.message);
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
   * Stop Gemini by killing the persistent process
   */
  async stop(): Promise<void> {
    console.log('\n>>> Stopping Gemini');

    (this as any).stopRequested = true;

    try {
      await this.sendEvent('info', 'Stopping Gemini interactive session');
    } catch (err) {
      console.error('Failed to send stop event:', err);
    }

    // Kill the persistent Gemini process
    if (this.process) {
      console.log('Killing Gemini process...');
      this.process.kill('SIGINT');

      // Force kill after a short timeout
      setTimeout(() => {
        if (this.process) {
          console.log('Force killing Gemini process...');
          this.process.kill('SIGKILL');
        }
      }, 2000);
    }
  }
}