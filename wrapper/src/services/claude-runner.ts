import { BaseRunner, RunnerOptions, WorkerCommandResult } from './base-runner.js';
import { config } from '../config.js';
import { spawn, ChildProcess } from 'child_process';
import { ackCommand } from './gateway-client.js';
import { resolve as pathResolve, relative as pathRelative, normalize as pathNormalize } from 'path';

// Re-export RunnerOptions for convenience
export type { RunnerOptions };

export interface ClaudeRunnerOptions extends RunnerOptions {
  // No Claude-specific options needed currently
}

/**
 * Claude Code runner implementation
 *
 * CRITICAL ARCHITECTURE:
 * Claude Code is INTERACTIVE - it asks questions and waits for responses.
 *
 * Design:
 * 1. Spawn Claude ONCE with interactive mode (no --print flag)
 * 2. Send initial task via stdin
 * 3. Keep stdin open throughout the session
 * 4. Monitor stdout for Claude's output and questions
 * 5. When __INPUT__ commands arrive, send them via stdin
 * 6. Claude continues in the same session with full context
 *
 * This allows multi-turn conversations where Claude can ask clarifying
 * questions and work with the user interactively.
 */
export class ClaudeRunner extends BaseRunner {
  private claudeProcess: ChildProcess | null = null;

  constructor(options: ClaudeRunnerOptions) {
    super(options);
    // BaseRunner handles log path setup, no need to override
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
   * Build Claude Code command arguments for INTERACTIVE mode
   *
   * Interactive mode (default, no --print):
   * - Spawns Claude once
   * - Accepts input via stdin
   * - Continues in the same session with context
   * - Can ask clarifying questions and wait for responses
   */
  buildCommand(command?: string, autonomous?: boolean): WorkerCommandResult {
    const args: string[] = [];

    // Always use --permission-mode acceptEdits to prevent permission prompts
    args.push('--permission-mode', 'acceptEdits');

    // Add model if specified
    if (this.model) {
      args.push('--model', this.model);
    }

    // IMPORTANT: For interactive mode, do NOT use --print
    // Do NOT add command as argument - it will be sent via stdin
    // This keeps Claude running and accepting input throughout the session

    const fullCommand = `${this.getCommand()} ${args.join(' ')}`.trim();

    return { args, fullCommand };
  }

  /**
   * Start Claude in interactive mode and keep it running
   */
  async start(command?: string): Promise<void> {
    console.log('\n>>> Starting Claude Code in INTERACTIVE mode');

    const { args } = this.buildCommand(undefined, this.autonomous);
    const cmd = this.getCommand();
    const env = this.buildEnvironment();
    const useShell = process.platform === 'win32';

    try {
      // Spawn Claude and KEEP stdin open
      this.claudeProcess = spawn(cmd, args, {
        cwd: this.workingDir,
        shell: useShell,
        stdio: ['pipe', 'pipe', 'pipe'],  // stdin, stdout, stderr - all piped
        env,
        windowsHide: false,
      });

      console.log(`Process spawned with PID: ${this.claudeProcess.pid}`);

      // Handle stdout - Claude's output and questions
      this.claudeProcess.stdout?.on('data', async (data: Buffer) => {
        const text = data.toString();
        console.log(`[Claude stdout] ${text.substring(0, 100)}`);

        // Forward to log and gateway
        (this as any).logStream?.write(`[stdout] ${text}`);

        try {
          const sanitized = text;
          await this.sendEvent('stdout', sanitized);
        } catch (err) {
          console.error('Failed to send event:', err);
        }
      });

      // Handle stderr
      this.claudeProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        console.log(`[Claude stderr] ${text.substring(0, 100)}`);
        (this as any).logStream?.write(`[stderr] ${text}`);
      });

      // Handle process completion
      this.claudeProcess.on('close', async (code, signal) => {
        console.log(`\nClaude process exited with code ${code}, signal ${signal}`);
        this.claudeProcess = null;
        await this.handleExit(code, signal);
      });

      // Handle process error
      this.claudeProcess.on('error', async (err) => {
        console.error(`Claude process error:`, err);
        await this.sendEvent('error', `Process error: ${err.message}`);
        await this.handleExit(1, null);
      });

      // Mark as running
      (this as any).isRunning = true;

      // Send start marker
      await this.sendMarker('started', {
        event: 'started',
        command: command || '(interactive)',
        workingDir: this.workingDir,
        workerType: 'claude',
        interactive: true
      });

      // Send initial command if provided, with a small delay
      if (command) {
        console.log(`Sending initial command to Claude...`);
        await new Promise(resolve => setTimeout(resolve, 500));
        this.sendInputToProcess(command, 'initial');
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
   * Send input to Claude via stdin (keep the process alive)
   */
  private sendInputToProcess(input: string, commandId: string): boolean {
    if (!this.claudeProcess || !this.claudeProcess.stdin) {
      console.error(`Cannot send input: Claude process not running or stdin not available`);
      return false;
    }

    try {
      const inputWithNewline = input.endsWith('\n') ? input : input + '\n';
      console.log(`Sending to Claude stdin: ${input.substring(0, 50)}...`);
      this.claudeProcess.stdin.write(inputWithNewline);
      return true;
    } catch (err) {
      console.error(`Failed to write to Claude stdin:`, err);
      return false;
    }
  }

  /**
   * Override executeCommand to handle __INPUT__ by sending via stdin
   */
  async executeCommand(cmd: any): Promise<void> {
    // Handle __INPUT__ commands
    if (cmd.command.startsWith('__INPUT__:')) {
      const input = cmd.command.substring('__INPUT__:'.length);

      console.log(`\n>>> Claude interactive input command`);
      console.log(`    Command ID: ${cmd.id}`);
      console.log(`    Input: ${input.substring(0, 50)}...`);

      try {
        // Send acknowledgment to gateway
        await this.sendEvent('info', `Received input: ${input.substring(0, 100)}`);

        // Mark as processed to prevent re-execution
        (this as any).markCommandProcessed(cmd.id, 30 * 60 * 1000);

        // Check if Claude is running
        if (!this.claudeProcess) {
          throw new Error('Claude process not running');
        }

        // Send input via stdin
        if (this.sendInputToProcess(input, cmd.id)) {
          console.log(`    ✓ Input sent to Claude`);

          // Acknowledge success
          try {
            await ackCommand(this.auth, cmd.id, `Input sent to Claude: ${input.substring(0, 100)}`);
            console.log(`    ✓ Command acknowledged`);
          } catch (err: any) {
            console.error(`Failed to acknowledge command:`, err.message);
          }
        } else {
          throw new Error('Failed to send input to Claude');
        }

      } catch (err: any) {
        console.error(`\n>>> Failed to process Claude input:`, err.message);
        await this.sendEvent('error', `Failed to process input: ${err.message}`);

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

    console.log('\n>>> Stopping Claude interactive session');
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
