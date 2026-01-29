import { BaseRunner, RunnerOptions, WorkerCommandResult } from './base-runner.js';
import { config } from '../config.js';
import { spawn, ChildProcess } from 'child_process';
import { ackCommand } from './gateway-client.js';
import { randomUUID } from 'crypto';
import { resolve as pathResolve, relative as pathRelative, normalize as pathNormalize } from 'path';

// Re-export RunnerOptions for convenience
export type { RunnerOptions };

export interface ClaudeRunnerOptions extends RunnerOptions {
  // No Claude-specific options needed currently
}

/**
 * Claude Code runner implementation
 *
 * ARCHITECTURE: Session-based context preservation
 *
 * Claude Code has a brilliant feature: --session-id allows maintaining conversation context
 * across multiple invocations. Each run with the same --session-id automatically loads the
 * previous conversation history.
 *
 * Design:
 * 1. Generate a unique session ID when the runner starts
 * 2. For each command/input, spawn Claude with --print and --session-id
 * 3. Pass the command/prompt as argument
 * 4. Claude outputs result and exits (process completes)
 * 5. Claude's session file maintains full conversation history
 * 6. Next invocation with same --session-id restores context
 *
 * This gives us:
 * - Multi-turn conversation with full context preservation
 * - No need for persistent stdin management
 * - Clean process lifecycle (spawn → execute → exit)
 * - Each invocation is independent and reliable
 * - Claude handles all context management internally
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
   * Get the CLI command for Claude
   */
  getCommand(): string {
    return config.claudeCommand;
  }

  /**
   * Build Claude Code command arguments with session ID
   *
   * Using --print mode for piped automation + --session-id for context preservation
   */
  buildCommand(command?: string, autonomous?: boolean): WorkerCommandResult {
    const args: string[] = [];

    // Use --print for non-interactive mode (returns result and exits)
    args.push('--print');

    // Always use --permission-mode acceptEdits to prevent permission prompts
    args.push('--permission-mode', 'acceptEdits');

    // Use session ID to maintain conversation context across invocations
    args.push('--session-id', this.sessionId);

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
   * Start Claude with a session ID
   * If initial command provided, execute it immediately
   */
  async start(command?: string): Promise<void> {
    console.log('\n>>> Starting Claude Code with session-based context');

    try {
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

      // If an initial command was provided, execute it immediately
      if (command) {
        console.log(`Executing initial command...`);
        await this.executeClaudeCommand(command, 'initial');
      } else {
        console.log(`Claude session ready, waiting for __INPUT__ commands...`);
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
   * Execute a Claude command by spawning a new process
   * Claude automatically restores context from the session file
   */
  private async executeClaudeCommand(input: string, commandId: string): Promise<string> {
    const { args } = this.buildCommand(input, this.autonomous);
    const cmd = this.getCommand();
    const env = this.buildEnvironment();
    const useShell = process.platform === 'win32';

    console.log(`Spawning Claude (session: ${this.sessionId.substring(0, 8)}...): ${input.substring(0, 50)}...`);

    return new Promise<string>((resolve, reject) => {
      const claudeProcess = spawn(cmd, args, {
        cwd: this.workingDir,
        shell: useShell,
        stdio: ['ignore', 'pipe', 'pipe'],  // ignore stdin, pipe stdout/stderr
        env,
        windowsHide: false,
      });

      console.log(`Process spawned with PID: ${claudeProcess.pid}`);

      let output = '';
      let errors = '';

      // Handle stdout
      claudeProcess.stdout?.on('data', async (data: Buffer) => {
        const text = data.toString();
        output += text;
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
      claudeProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        errors += text;
        console.log(`[Claude stderr] ${text.substring(0, 100)}`);
        (this as any).logStream?.write(`[stderr] ${text}`);
      });

      // Handle process completion
      claudeProcess.on('close', async (code, signal) => {
        console.log(`Claude process exited with code ${code}`);

        if (code === 0) {
          resolve(output);
        } else {
          const errorMsg = errors || output || `Process exited with code ${code}`;
          reject(new Error(errorMsg));
        }

        await this.handleExit(code, signal);
      });

      // Handle process error
      claudeProcess.on('error', (err) => {
        console.error(`Claude process error:`, err);
        reject(err);
      });
    });
  }

  /**
   * Override executeCommand to handle __INPUT__ by spawning Claude with the session ID
   */
  async executeCommand(cmd: any): Promise<void> {
    // Handle __INPUT__ commands
    if (cmd.command.startsWith('__INPUT__:')) {
      const input = cmd.command.substring('__INPUT__:'.length);

      console.log(`\n>>> Claude command (will restore session context)`);
      console.log(`    Command ID: ${cmd.id}`);
      console.log(`    Input: ${input.substring(0, 50)}...`);

      try {
        // Send acknowledgment to gateway
        await this.sendEvent('info', `Processing Claude command: ${input.substring(0, 100)}`);

        // Mark as processed to prevent re-execution
        (this as any).markCommandProcessed(cmd.id, 30 * 60 * 1000);

        // Execute Claude with the command
        // Claude automatically loads previous conversation from session file
        const output = await this.executeClaudeCommand(input, cmd.id);
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
    console.log('\n>>> Stopping Claude');
    (this as any).stopRequested = true;

    try {
      await this.sendEvent('info', 'Stopping Claude session');
    } catch (err) {
      console.error('Failed to send stop event:', err);
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
