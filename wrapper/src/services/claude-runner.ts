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
 * CRITICAL ARCHITECTURAL DIFFERENCE:
 * Claude Code is INTERACTIVE - it asks questions and waits for responses.
 *
 * Unlike Rev (single-execution): claude "prompt" → exit
 * Claude runs as: claude → wait for input → respond → repeat
 *
 * Implementation:
 * 1. Start Claude once with no prompt argument
 * 2. Keep stdin open throughout session
 * 3. Send __INPUT__ commands via stdin (not as CLI args)
 * 4. Read responses from stdout continuously
 * 5. Auto-respond in autonomous mode or wait for user input
 *
 * This matches Claude's interactive REPL design.
 */
export class ClaudeRunner extends BaseRunner {
  private claudeProcess: ChildProcess | null = null;
  private claudeReady = false;
  private inputQueue: { input: string; commandId: string }[] = [];

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
   * Build Claude Code command arguments for interactive mode
   *
   * For interactive Claude, we start with flags only (no prompt argument).
   * The prompt will be sent via stdin.
   */
  buildCommand(command?: string, autonomous?: boolean): WorkerCommandResult {
    const args: string[] = [];

    // Always use --permission-mode acceptEdits to prevent permission prompts
    args.push('--permission-mode', 'acceptEdits');

    // Use text output format for consistency
    args.push('--output-format', 'text');

    // Add model if specified
    if (this.model) {
      args.push('--model', this.model);
    }

    // IMPORTANT: For interactive Claude, do NOT add command to args
    // The command/prompt will be sent via stdin, not as CLI argument
    // This allows Claude to stay running and accept multiple inputs

    const fullCommand = `${this.getCommand()} ${args.join(' ')}`.trim();

    return { args, fullCommand };
  }

  /**
   * Override start to launch Claude in interactive mode
   * Claude process stays running throughout the session
   */
  async start(command?: string): Promise<void> {
    console.log('\n>>> Starting Claude Code in interactive mode');

    // Build command with no prompt (interactive mode)
    const { args } = this.buildCommand(undefined, this.autonomous);
    const cmd = this.getCommand();
    const env = this.buildEnvironment();
    const useShell = process.platform === 'win32';

    try {
      // Spawn Claude process and KEEP stdin open
      this.claudeProcess = spawn(cmd, args, {
        cwd: this.workingDir,
        shell: useShell,
        stdio: ['pipe', 'pipe', 'pipe'],  // stdin, stdout, stderr - all piped
        env,
        windowsHide: false,
      });

      console.log(`Process spawned with PID: ${this.claudeProcess.pid}`);

      // Handle stdout - this is where Claude's prompts and responses appear
      this.claudeProcess.stdout?.on('data', async (data: Buffer) => {
        const text = data.toString();
        console.log(`[Claude stdout] ${text.substring(0, 100)}`);

        // Forward to log and gateway
        (this as any).logStream?.write(`[stdout] ${text}`);

        try {
          const sanitized = text;  // TODO: redact secrets
          await this.sendEvent('stdout', sanitized);
        } catch (err) {
          console.error('Failed to send event:', err);
        }

        // Detect if Claude is waiting for input
        if (text.includes('What would you like') ||
            text.includes('How can I help') ||
            text.includes('Let me know') ||
            text.includes('Enter') ||
            text.match(/\?$/m)) {
          console.log('Claude waiting for input detected');
          this.claudeReady = true;

          // Auto-respond in autonomous mode if we have pending input
          if (this.autonomous && this.inputQueue.length > 0) {
            const { input, commandId } = this.inputQueue.shift()!;
            console.log(`Auto-sending input in autonomous mode: ${input}`);
            this.sendInputToProcess(input, commandId);
          }
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
        this.claudeReady = false;
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
        autonomous: this.autonomous,
        interactive: true
      });

      // If an initial command was provided, send it after a brief delay
      if (command) {
        console.log(`Waiting for Claude to be ready to receive initial command...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
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
   * Send input to Claude via stdin
   */
  private sendInputToProcess(input: string, commandId: string): boolean {
    if (!this.claudeProcess || !this.claudeProcess.stdin) {
      console.error(`Cannot send input: Claude process not running or stdin not available`);
      return false;
    }

    try {
      // Add newline if not present
      const inputWithNewline = input.endsWith('\n') ? input : input + '\n';

      console.log(`Sending input to Claude: ${input.substring(0, 50)}`);
      this.claudeProcess.stdin.write(inputWithNewline);

      return true;
    } catch (err) {
      console.error(`Failed to write to Claude stdin:`, err);
      return false;
    }
  }

  /**
   * Override executeCommand to handle __INPUT__ differently for Claude
   * Instead of spawning a new process, send the input via stdin
   */
  async executeCommand(cmd: any): Promise<void> {
    // Handle __INPUT__ commands by sending via stdin (not spawning new process)
    if (cmd.command.startsWith('__INPUT__:')) {
      const input = cmd.command.substring('__INPUT__:'.length);

      console.log(`\n>>> Claude interactive input command`);
      console.log(`    Command ID: ${cmd.id}`);
      console.log(`    Input: ${input.substring(0, 100)}`);

      try {
        // Send acknowledgment to gateway immediately
        await this.sendEvent('info', `Received input: ${input}`);

        // Check if Claude is ready
        if (!this.claudeProcess) {
          throw new Error('Claude process not running');
        }

        if (this.claudeReady) {
          // Claude is waiting for input, send it immediately
          if (this.sendInputToProcess(input, cmd.id)) {
            console.log(`    ✓ Input sent to Claude`);
            // Mark as processed to prevent re-execution
            (this as any).markCommandProcessed(cmd.id, 30 * 60 * 1000);

            // Acknowledge with gateway
            try {
              await ackCommand(this.auth, cmd.id, `Input sent to Claude: ${input.substring(0, 100)}`);
              console.log(`    ✓ Command acknowledged`);
            } catch (err: any) {
              console.error(`Failed to acknowledge command:`, err.message);
            }
          } else {
            throw new Error('Failed to send input to Claude');
          }
        } else {
          // Claude not ready yet, queue the input
          console.log(`    Claude not ready yet, queueing input`);
          this.inputQueue.push({ input, commandId: cmd.id });
          (this as any).markCommandProcessed(cmd.id, 30 * 60 * 1000);

          try {
            await ackCommand(this.auth, cmd.id, `Input queued for Claude: ${input.substring(0, 100)}`);
          } catch (err: any) {
            console.error(`Failed to acknowledge command:`, err.message);
          }
        }
      } catch (err: any) {
        console.error(`\n>>> Failed to process Claude input:`, err.message);
        await this.sendEvent('error', `Failed to process input: ${err.message}`);

        try {
          await ackCommand(this.auth, cmd.id, undefined, `Error: ${err.message}`);
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
      await this.sendEvent('info', 'Stop requested - closing Claude session');
    } catch (err) {
      console.error('Failed to send stop event:', err);
    }

    // Send exit signal to Claude via stdin
    if (this.claudeProcess.stdin) {
      try {
        this.claudeProcess.stdin.write('exit\n');
        console.log('Sent exit command to Claude');
      } catch (err) {
        console.error('Failed to send exit command:', err);
      }
    }

    // Wait a moment for graceful exit
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Force kill if still running
    if (this.claudeProcess) {
      console.log('Force killing Claude process');
      const signal = process.platform === 'win32' ? 'SIGKILL' : 'SIGINT';
      this.claudeProcess.kill(signal);
    }
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
      savedAt: Date.now(),
      claudeReady: this.claudeReady,
      queuedInputs: this.inputQueue.length
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
