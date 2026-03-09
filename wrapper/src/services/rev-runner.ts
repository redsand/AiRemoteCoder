import { BaseRunner, RunnerOptions, WorkerCommandResult } from './base-runner.js';
import { config } from '../config.js';
import { spawn, ChildProcess } from 'child_process';
import { ackCommand } from './gateway-client.js';
import { randomUUID } from 'crypto';

// Re-export RunnerOptions for convenience
export type { RunnerOptions };

export interface RevRunnerOptions extends RunnerOptions {
  // No Rev-specific options needed currently
}

/**
 * Rev runner implementation with interactive REPL mode
 *
 * ARCHITECTURE: Interactive session with persistent process
 *
 * Rev supports --repl mode which allows maintaining conversation context
 * across multiple commands without respawning for each input.
 *
 * Design:
 * 1. Generate a unique session ID when the runner starts
 * 2. Spawn ONE persistent Rev process with --repl flag
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
export class RevRunner extends BaseRunner {
  private sessionId: string;

  constructor(options: RevRunnerOptions) {
    super(options);
    // Generate a unique session ID for this runner instance
    // Rev will maintain conversation context in this session
    this.sessionId = randomUUID();
    console.log(`Rev session ID: ${this.sessionId}`);
  }

  /**
   * Get the worker type identifier
   */
  getWorkerType(): string {
    return 'rev';
  }

  /**
   * Build environment variables for Rev
   */
  protected buildEnvironment(): NodeJS.ProcessEnv {
    const baseEnv = super.buildEnvironment();
    const revEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      REV_API_KEY: process.env.REV_API_KEY || ''
    };

    // Add provider-specific env vars
    if (this.provider === 'ollama') {
      revEnv.OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
    }

    return revEnv;
  }

  /**
   * Get the CLI command for Rev
   */
  getCommand(): string {
    return config.revCommand;
  }

  /**
   * Override to disable shell mode for Rev
   * Rev CLI doesn't need shell mode and using it causes argument escaping issues on Windows
   */
  protected shouldUseShell(): boolean {
    return false;
  }

  /**
   * Override to enable piped stdin for Rev
   * Rev needs piped stdin for REPL mode to receive programmatic input
   */
  protected shouldPipeStdin(): boolean {
    return true;
  }

  /**
   * Build Rev command arguments for interactive REPL mode
   *
   * INTERACTIVE MODE (--repl):
   * - Spawn ONE persistent Rev process
   * - Send input via stdin
   * - Keep process alive for the entire session
   * - Use --trust-workspace to prevent permission prompts
   */
  buildCommand(_command?: string, _autonomous?: boolean): WorkerCommandResult {
    const args: string[] = [];

    // Use --repl for interactive mode
    args.push('--repl');

    // Always use --trust-workspace in interactive mode to prevent permission prompts
    args.push('--trust-workspace');

    // Add LLM provider if specified
    if (this.provider) {
      args.push('--llm-provider', this.provider);
    }

    // Add model if specified
    if (this.model) {
      args.push('--model', this.model);
    }

    const fullCommand = `${this.getCommand()} ${args.join(' ')}`;

    return { args, fullCommand };
  }

  /**
   * Start Rev in interactive REPL mode
   *
   * INTERACTIVE MODE:
   * - Spawn ONE persistent Rev process
   * - Keep stdin open for sending commands
   * - Continuously read stdout/stderr
   * - Process only exits on __STOP__ or error
   */
  async start(command?: string): Promise<void> {
    console.log('\n>>> Starting Rev in interactive REPL mode');

    try {
      // Mark as running
      (this as any).isRunning = true;

      // Send start marker
      await this.sendMarker('started', {
        event: 'started',
        command: command || '(waiting for input)',
        workingDir: this.workingDir,
        workerType: 'rev',
        sessionId: this.sessionId,
        provider: this.provider,
        model: this.model
      });

      // Build command arguments (use --repl mode)
      const { args } = this.buildCommand();
      const cmd = this.getCommand();
      const env = this.buildEnvironment();

      console.log(`[DEBUG] Spawning Rev REPL process: ${cmd} ${args.join(' ')}`);

      // Spawn Rev process with piped stdin for sending commands
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
        console.log(`\n>>> Rev process closed (code: ${code}, signal: ${signal})`);

        if ((this as any).stopRequested) {
          // Expected shutdown
          console.log('Rev shut down as requested');
        } else {
          // Unexpected shutdown - process died without stop requested
          console.error('Rev process exited unexpectedly!');
          await this.sendEvent('error', `Rev process exited unexpectedly with code ${code}, signal ${signal}`);
        }

        // Call handleExit to clean up and terminate worker
        await this.handleExit(code, signal);
      });

      this.process.on('error', async (err) => {
        console.error(`Rev process error:`, err);
        await this.sendEvent('error', `Rev process error: ${err.message}`);
        await this.handleExit(1, null);
      });

      // If an initial command was provided, send it after process starts
      if (command && command.trim().length > 0) {
        // Wait a bit for Rev to be ready (REPL needs to initialize)
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log(`Sending initial command via stdin...`);
        this.sendInput(command);
      }

      // Start polling and heartbeat
      (this as any).startCommandPolling();
      (this as any).startHeartbeat();

    } catch (err: any) {
      console.error(`Failed to start Rev: ${err.message}`);
      throw err;
    }
  }

  /**
   * Set up stdout/stderr handlers for the persistent Rev process
   */
  private setupOutputHandlers(): void {
    if (!this.process) return;

    // Handle stdout
    this.process.stdout?.on('data', async (data: Buffer) => {
      const text = data.toString();
      console.log(`[Rev stdout] ${text.substring(0, 100)}`);

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
      console.log(`[Rev stderr] ${text.substring(0, 100)}`);
      (this as any).logStream?.write(`[stderr] ${text}`);

      try {
        await this.sendEvent('stderr', text);
      } catch (err) {
        console.error('Failed to send event:', err);
      }
    });
  }

  /**
   * Execute a command by sending it to the persistent Rev process via stdin
   */
  async executeCommand(cmd: any): Promise<void> {
    // Handle __INPUT__ commands
    if (cmd.command.startsWith('__INPUT__:')) {
      const input = cmd.command.substring('__INPUT__:'.length);

      console.log(`\n>>> Rev command (sending via stdin)`);
      console.log(`    Command ID: ${cmd.id}`);
      console.log(`    Input: ${input.substring(0, 50)}...`);

      try {
        // Send acknowledgment to gateway
        await this.sendEvent('info', `Processing Rev command: ${input.substring(0, 100)}`);

        // Mark as processed to prevent re-execution
        (this as any).markCommandProcessed(cmd.id, 30 * 60 * 1000);

        // Send input to Rev via stdin
        this.sendInput(input);

        console.log(`    ✓ Command sent to Rev`);

        // Acknowledge success (we don't wait for output, just acknowledge the command was sent)
        try {
          await ackCommand(this.auth, cmd.id, `Command sent to Rev`);
          console.log(`    ✓ Command acknowledged`);
        } catch (err: any) {
          console.error(`Failed to acknowledge command:`, err.message);
        }

      } catch (err: any) {
        console.error(`\n>>> Failed to process Rev command:`, err.message);
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
   * Stop Rev by killing the persistent process
   */
  async stop(): Promise<void> {
    console.log('\n>>> Stopping Rev');

    (this as any).stopRequested = true;

    try {
      await this.sendEvent('info', 'Stopping Rev REPL session');
    } catch (err) {
      console.error('Failed to send stop event:', err);
    }

    // Kill the persistent Rev process
    if (this.process) {
      console.log('Killing Rev process...');
      this.process.kill('SIGINT');

      // Force kill after a short timeout
      setTimeout(() => {
        if (this.process) {
          console.log('Force killing Rev process...');
          this.process.kill('SIGKILL');
        }
      }, 2000);
    }
  }
}