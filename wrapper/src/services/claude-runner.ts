import { BaseRunner, RunnerOptions, WorkerCommandResult } from './base-runner.js';
import { config } from '../config.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve as pathResolve, relative as pathRelative, normalize as pathNormalize } from 'path';
import { spawn, ChildProcess } from 'child_process';
import { ackCommand } from './gateway-client.js';

// Re-export RunnerOptions for convenience
export type { RunnerOptions };

export interface ClaudeRunnerOptions extends RunnerOptions {
  // No Claude-specific options needed currently
}

/**
 * Claude Code runner implementation
 *
 * Claude Code executes in two modes:
 * 1. Interactive mode (default): Shows prompts/questions, but requires TTY for responses
 * 2. Print mode (--print): Non-interactive, provides output and exits
 *
 * Since we're running in a non-TTY environment (piped stdio), we use print mode:
 * - Prompt is passed as CLI argument
 * - Claude outputs response + any questions
 * - Process exits
 *
 * For follow-up interactions:
 * - Spawn a new Claude process with the new prompt/context
 * - Build conversation history in the prompt if needed
 *
 * This matches how Claude is designed to work in automated/piped environments.
 */
export class ClaudeRunner extends BaseRunner {
  private claudeProcess: ChildProcess | null = null;

  constructor(options: ClaudeRunnerOptions) {
    super(options);

    // Override log path to maintain backward compatibility
    const runDir = join(config.runsDir, options.runId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    (this as any).logPath = join(runDir, 'claude.log');
    (this as any).stateFile = join(runDir, 'state.json');
  }

  /**
   * Get the worker type identifier
   */
  getWorkerType(): string {
    return 'claude';
  }

  /**
   * Get the CLI command for Claude
   */
  getCommand(): string {
    return config.claudeCommand;
  }

  /**
   * Build Claude Code command arguments
   *
   * Claude Code's --print mode is the only reliable way to handle piped I/O:
   * - Takes prompt as CLI argument (not stdin)
   * - Outputs result and exits
   * - Works in non-TTY environments (piped stdio)
   *
   * Claude's default interactive mode requires a TTY and doesn't work with piped stdin.
   */
  buildCommand(command?: string, autonomous?: boolean): WorkerCommandResult {
    const args: string[] = [];

    // Use --print for non-interactive mode (piped I/O friendly)
    args.push('--print');

    // Always use --permission-mode acceptEdits to prevent permission prompts
    args.push('--permission-mode', 'acceptEdits');

    // Add model if specified
    if (this.model) {
      args.push('--model', this.model);
    }

    // Add the command/prompt as the final argument
    if (command) {
      args.push(command);
    }

    const fullCommand = `${this.getCommand()} ${args.join(' ')}`.trim();

    return { args, fullCommand };
  }

  /**
   * Override start to launch Claude in print mode with a command
   * Claude processes and exits after outputting results
   *
   * If no initial command provided, just mark as running and wait for __INPUT__ commands
   */
  async start(command?: string): Promise<void> {
    console.log('\n>>> Starting Claude Code');

    try {
      // Mark as running
      (this as any).isRunning = true;

      // Send start marker
      await this.sendMarker('started', {
        event: 'started',
        command: command || '(waiting for input)',
        workingDir: this.workingDir,
        workerType: 'claude'
      });

      // If an initial command was provided, spawn Claude with it
      if (command) {
        console.log(`Initial command provided, spawning Claude...`);
        await this.spawnClaudeForInput(command, 'initial');
      } else {
        console.log(`No initial command, waiting for __INPUT__ commands from gateway...`);
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
   * Spawn a Claude process for a specific input
   * Handles all stdout/stderr and completion
   */
  private async spawnClaudeForInput(input: string, commandId: string): Promise<string> {
    // Build command with the prompt as an argument
    const { args } = this.buildCommand(input, this.autonomous);
    const cmd = this.getCommand();
    const env = this.buildEnvironment();
    const useShell = process.platform === 'win32';

    console.log(`Spawning Claude with input: ${input.substring(0, 50)}...`);

    // Spawn Claude process
    this.claudeProcess = spawn(cmd, args, {
      cwd: this.workingDir,
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],  // ignore stdin, pipe stdout/stderr
      env,
      windowsHide: false,
    });

    console.log(`Process spawned with PID: ${this.claudeProcess.pid}`);

    return new Promise<string>((resolve, reject) => {
      let output = '';
      let errors = '';

      // Handle stdout
      this.claudeProcess!.stdout?.on('data', async (data: Buffer) => {
        const text = data.toString();
        output += text;
        console.log(`[Claude stdout] ${text.substring(0, 100)}`);

        // Forward to log and gateway
        (this as any).logStream?.write(`[stdout] ${text}`);

        try {
          const sanitized = text;  // TODO: redact secrets
          await this.sendEvent('stdout', sanitized);
        } catch (err) {
          console.error('Failed to send event:', err);
        }
      });

      // Handle stderr
      this.claudeProcess!.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        errors += text;
        console.log(`[Claude stderr] ${text.substring(0, 100)}`);
        (this as any).logStream?.write(`[stderr] ${text}`);
      });

      // Handle process completion
      this.claudeProcess!.on('close', async (code, signal) => {
        console.log(`\nClaude process exited with code ${code}, signal ${signal}`);
        this.claudeProcess = null;

        if (code === 0) {
          resolve(output);
        } else {
          const errorMsg = errors || output || `Process exited with code ${code}`;
          reject(new Error(errorMsg));
        }

        await this.handleExit(code, signal);
      });

      // Handle process error
      this.claudeProcess!.on('error', async (err) => {
        console.error(`Claude process error:`, err);
        this.claudeProcess = null;
        reject(err);
        await this.sendEvent('error', `Process error: ${err.message}`);
        await this.handleExit(1, null);
      });
    });
  }


  /**
   * Override executeCommand to handle __INPUT__ by spawning a new Claude process
   * Claude exits after each command, so we spawn fresh for each input
   */
  async executeCommand(cmd: any): Promise<void> {
    // Handle __INPUT__ commands
    if (cmd.command.startsWith('__INPUT__:')) {
      const input = cmd.command.substring('__INPUT__:'.length);

      console.log(`\n>>> Processing Claude input command`);
      console.log(`    Command ID: ${cmd.id}`);
      console.log(`    Input: ${input.substring(0, 50)}...`);

      try {
        // Send acknowledgment to gateway
        await this.sendEvent('info', `Processing Claude command: ${input.substring(0, 100)}`);

        // Mark as processed to prevent re-execution
        (this as any).markCommandProcessed(cmd.id, 30 * 60 * 1000);

        // Spawn Claude for this input
        const output = await this.spawnClaudeForInput(input, cmd.id);
        console.log(`    ✓ Claude completed`);

        // Acknowledge success
        try {
          await ackCommand(this.auth, cmd.id, `Claude output: ${output.substring(0, 200)}`);
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
   * Override stop to handle Claude-specific cleanup
   */
  async stop(): Promise<void> {
    if (!this.claudeProcess) {
      return;
    }

    console.log('\n>>> Stopping Claude');
    (this as any).stopRequested = true;

    try {
      await this.sendEvent('info', 'Stopping Claude process');
    } catch (err) {
      console.error('Failed to send stop event:', err);
    }

    // Kill the process if still running
    if (this.claudeProcess && !this.claudeProcess.killed) {
      try {
        console.log('Killing Claude process');
        const signal = process.platform === 'win32' ? 'SIGKILL' : 'SIGINT';
        this.claudeProcess.kill(signal);
      } catch (err) {
        console.error('Failed to kill Claude process:', err);
      }
    }

    this.claudeProcess = null;
  }

  /**
   * Build the start marker with Claude-specific data
   */
  protected buildStartMarker(command: string): Record<string, any> {
    return {
      ...super.buildStartMarker(command),
      workerType: 'claude',
      interactive: true
    };
  }

  /**
   * Get current run state
   */
  getState() {
    return super.getState();
  }

  /**
   * Save state to disk
   */
  protected saveState(): void {
    const state = {
      runId: this.auth.runId,
      sequence: this.sequence,
      workingDir: this.workingDir,
      autonomous: this.autonomous,
      savedAt: Date.now()
    };
    try {
      writeFileSync((this as any).stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('Failed to save state:', err);
    }
  }

  /**
   * Load state from disk
   */
  protected loadState(): boolean {
    try {
      if (existsSync((this as any).stateFile)) {
        const data = readFileSync((this as any).stateFile, 'utf8');
        const state = JSON.parse(data);
        this.sequence = state.sequence || 0;
        return true;
      }
    } catch (err) {
      console.error('Failed to load state:', err);
    }
    return false;
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
