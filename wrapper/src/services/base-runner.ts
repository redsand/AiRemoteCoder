import { spawn, ChildProcess, execSync } from 'child_process';
import { EventEmitter } from 'events';
import { createWriteStream, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { config } from '../config.js';
import { redactSecrets } from '../utils/crypto.js';
import {
  sendEvent,
  uploadArtifact,
  pollCommands,
  ackCommand,
  updateRunState,
  registerClient,
  sendHeartbeat,
  type RunAuth,
  type Command
} from './gateway-client.js';
import { nanoid } from 'nanoid';

export interface RunnerOptions {
  runId: string;
  capabilityToken: string;
  command?: string;
  workingDir?: string;
  autonomous?: boolean;
  resumeFrom?: string;
  model?: string; // For workers that support model selection (Ollama, Gemini, Rev)
  integration?: string; // For ollama-launch: specifies the IDE integration (claude, codex, opencode, droid)
  provider?: string; // For Rev: specifies the provider (ollama, claude, etc.)
}

export interface WorkerCommandResult {
  args: string[];
  fullCommand: string;
}

/**
 * Base class for all AI worker runners (Claude, Ollama, Codex, Gemini, Rev)
 * Provides common functionality for process spawning, lifecycle management,
 * event streaming, state persistence, and command execution.
 */
export abstract class BaseRunner extends EventEmitter {
  protected auth: RunAuth;
  protected agentId: string; // Unique identifier for this client/agent
  protected process: ChildProcess | null = null;
  protected logPath: string;
  protected logStream: ReturnType<typeof createWriteStream> | null = null;
  protected commandPollTimer: NodeJS.Timeout | null = null;
  protected heartbeatTimer: NodeJS.Timeout | null = null;
  protected sequence = 0;
  protected isRunning = false;
  protected workingDir: string;
  protected stopRequested = false;
  protected haltRequested = false;
  protected autonomous: boolean;
  protected stateFile: string;
  protected resumeFrom?: string;
  protected model?: string;
  protected integration?: string; // For ollama-launch: IDE integration name
  protected provider?: string; // For Rev: provider name (ollama, claude, etc.)
  private processedCommandIds: Set<string> = new Set(); // Track processed commands to prevent duplicates
  private processedCommandExpire: Map<string, NodeJS.Timeout> = new Map(); // Track expiration timers
  private lastOutputTime = 0; // Track when we last received output
  private outputWarningTimer: NodeJS.Timeout | null = null; // Warn if no output for a while
  private spawnedProcesses: Set<ChildProcess> = new Set(); // Track spawned prompt processes
  private lastExecutedCommandId: string | null = null; // Track last executed command to prevent re-execution

  constructor(options: RunnerOptions) {
    super();
    this.auth = {
      runId: options.runId,
      capabilityToken: options.capabilityToken
    };
    // Generate a unique agent ID based on hostname and a random component
    // This allows the same machine to register once and then update on subsequent runs
    const hostname = os.hostname();
    this.agentId = `${hostname}-${nanoid(8)}`;

    this.workingDir = options.workingDir || process.cwd();
    // Store the sandbox root - cannot go above this directory
    (this as any).sandboxRoot = this.workingDir;
    this.autonomous = options.autonomous || false;
    this.resumeFrom = options.resumeFrom;
    this.model = options.model;
    this.integration = options.integration;
    this.provider = options.provider;

    // Setup log directory
    const runDir = join(config.runsDir, options.runId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    this.logPath = join(runDir, 'runner.log');
    this.stateFile = join(runDir, 'state.json');
  }

  /**
   * Get the worker type identifier (abstract method)
   */
  abstract getWorkerType(): string;

  /**
   * Build the command arguments for this worker (abstract method)
   * @param command - Optional command/prompt to pass to the worker
   * @param autonomous - Whether running in autonomous mode
   * @returns Object with args array and full command string
   */
  abstract buildCommand(command?: string, autonomous?: boolean): WorkerCommandResult;

  /**
   * Get the CLI command for this worker
   */
  abstract getCommand(): string;

  /**
   * Start the worker process
   */
  async start(command?: string): Promise<void> {
    if (this.isRunning) {
      throw new Error('Runner already started');
    }

    // Load previous state if resuming
    if (this.resumeFrom) {
      this.loadState();
    }

    this.isRunning = true;
    this.logStream = createWriteStream(this.logPath, { flags: 'a' });

    console.log(`Starting ${this.getWorkerType()}`);
    console.log(`Working directory: ${this.workingDir}`);
    console.log(`Agent ID: ${this.agentId}`);

    // Register client with gateway
    try {
      await registerClient(
        `ai-runner@${os.hostname()}`,
        this.agentId,
        undefined,
        ['run_execution', 'log_streaming', 'command_polling']
      );
      console.log('Client registered successfully');
    } catch (err) {
      console.error('Failed to register client:', err);
      // Don't fail startup if registration fails
    }

    // Save initial state
    this.saveState();

    // Update state on gateway
    try {
      await updateRunState(this.auth, {
        workingDir: this.workingDir,
        lastSequence: this.sequence
      });
    } catch (err) {
      console.error('Failed to update run state:', err);
    }

    // If no initial command provided, just wait for prompts from gateway
    if (!command) {
      console.log(`Waiting for prompts from gateway...`);
      const startMarker = this.buildStartMarker(`${this.getWorkerType()} (waiting for prompt)`);
      await this.sendMarker('started', startMarker);

      // Start command polling and heartbeat
      this.startCommandPolling();
      this.startHeartbeat();
      return;
    }

    // Otherwise, spawn worker process with initial command
    console.log(`Starting with prompt: ${command.substring(0, 100)}`);
    const { args, fullCommand } = this.buildCommand(command, this.autonomous);

    // Send start marker
    const startMarker = this.buildStartMarker(fullCommand);
    await this.sendMarker('started', startMarker);

    // Spawn worker process
    const cmd = this.getCommand();
    const env = this.buildEnvironment();

    console.log(`Spawning process: ${cmd} with args: ${JSON.stringify(args)}`);
    console.log(`Environment: TERM=${env.TERM}`);

    // For Windows compatibility, we may need shell, but try to use it carefully
    // shell: true can interfere with output capture, but some CLIs need it
    const useShell = process.platform === 'win32';

    // Inherit stdin so child processes can detect TTY (required for interactive REPL mode)
    // Pipe stdout/stderr so we can capture output for the gateway
    // Users should send input via the UI's __INPUT__ mechanism, not manual terminal input
    const stdio: any = ['inherit', 'pipe', 'pipe'];

    this.process = spawn(cmd, args, {
      cwd: this.workingDir,
      shell: useShell,
      stdio,
      env,
      windowsHide: false, // Show window on Windows for interactive processes
    });

    console.log(`Process spawned with PID: ${this.process.pid}`);

    // Handle stdout
    this.process.stdout?.on('data', (data: Buffer) => {
      console.log(`Received stdout data: ${data.length} bytes`);
      this.handleOutput('stdout', data);
    });

    // Handle stderr
    this.process.stderr?.on('data', (data: Buffer) => {
      console.log(`Received stderr data: ${data.length} bytes`);
      this.handleOutput('stderr', data);
    });

    // Handle process exit
    this.process.on('close', async (code, signal) => {
      console.log(`\n========================================`);
      console.log(`Process Summary:`);
      console.log(`  Worker: ${this.getWorkerType()}`);
      console.log(`  Exit Code: ${code}`);
      console.log(`  Signal: ${signal}`);
      console.log(`  Commands Processed: ${this.processedCommandIds.size}`);
      console.log(`  Log File: ${this.logPath}`);
      console.log(`========================================\n`);
      await this.handleExit(code, signal);
    });

    this.process.on('error', async (err) => {
      console.error(`${this.getWorkerType()} process error:`, err);
      await this.sendEvent('error', `Process error: ${err.message}`);
      await this.handleExit(1, null);
    });

    // Log when process starts producing output
    if (this.process.stdout) {
      console.log(`stdout handler attached`);
    }
    if (this.process.stderr) {
      console.log(`stderr handler attached`);
    }

    // Start command polling and heartbeat
    this.startCommandPolling();
    this.startHeartbeat();
  }

  /**
   * Build environment variables for the worker process
   * Override in subclasses for worker-specific env vars
   */
  protected buildEnvironment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      TERM: this.autonomous ? 'xterm-256color' : 'dumb',
      // Disable output buffering for better real-time visibility
      PYTHONUNBUFFERED: '1',
      NODE_ENV: 'production'
    };
  }

  /**
   * Build the start marker payload (override in subclasses for worker-specific data)
   */
  protected buildStartMarker(command: string): Record<string, any> {
    return {
      event: 'started',
      command,
      workingDir: this.workingDir,
      autonomous: this.autonomous,
      workerType: this.getWorkerType(),
      model: this.model,
      resumedFrom: this.resumeFrom
    };
  }

  /**
   * Get current run state
   */
  getState(): {
    runId: string;
    isRunning: boolean;
    sequence: number;
    workingDir: string;
    autonomous: boolean;
    stopRequested: boolean;
    workerType: string;
    model?: string;
    haltRequested?: boolean;
  } {
    return {
      runId: this.auth.runId,
      isRunning: this.isRunning,
      sequence: this.sequence,
      workingDir: this.workingDir,
      autonomous: this.autonomous,
      stopRequested: this.stopRequested,
      workerType: this.getWorkerType(),
      model: this.model,
      haltRequested: this.haltRequested || undefined
    };
  }

  /**
   * Save state to disk for recovery
   */
  protected saveState(): void {
    const state = {
      runId: this.auth.runId,
      sequence: this.sequence,
      workingDir: this.workingDir,
      autonomous: this.autonomous,
      workerType: this.getWorkerType(),
      model: this.model,
      savedAt: Date.now()
    };
    try {
      writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('Failed to save state:', err);
    }
  }

  /**
   * Load state from disk
   */
  protected loadState(): boolean {
    try {
      if (existsSync(this.stateFile)) {
        const data = readFileSync(this.stateFile, 'utf8');
        const state = JSON.parse(data);
        this.sequence = state.sequence || 0;
        this.model = state.model;
        return true;
      }
    } catch (err) {
      console.error('Failed to load state:', err);
    }
    return false;
  }

  /**
   * Start heartbeat to update state periodically
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      if (!this.isRunning) return;

      // Save state locally
      this.saveState();

      // Update state on gateway
      try {
        await updateRunState(this.auth, {
          workingDir: this.workingDir,
          lastSequence: this.sequence
        });
      } catch (err) {
        // Ignore heartbeat errors
      }

      // Send client heartbeat to keep client alive in registry
      try {
        await sendHeartbeat(this.agentId);
      } catch (err) {
        // Ignore client heartbeat errors
      }
    }, config.heartbeatInterval);
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Send input to stdin
   */
  sendInput(data: string): boolean {
    if (!this.process?.stdin) {
      console.error('Cannot send input: process stdin not available');
      return false;
    }
    try {
      console.log(`Writing to stdin: ${JSON.stringify(data)} (${data.length} bytes)`);
      const success = this.process.stdin.write(data);
      console.log(`stdin.write() returned: ${success}`);
      // Notify that prompt has been resolved (input sent)
      this.emit('prompt_resolved', data);
      return true;
    } catch (err) {
      console.error('Failed to write to stdin:', err);
      return false;
    }
  }

  /**
   * Send escape sequence (Ctrl+C) to process
   */
  sendEscape(): boolean {
    if (!this.process || !this.isRunning) {
      return false;
    }
    try {
      // Send SIGINT for escape
      this.process.kill('SIGINT');
      return true;
    } catch (err) {
      console.error('Failed to send escape:', err);
      return false;
    }
  }

  /**
   * Handle output from worker process
   */
  private async handleOutput(type: 'stdout' | 'stderr', data: Buffer): Promise<void> {
    const text = data.toString();
    const preview = text.substring(0, 300);
    const truncated = text.length > 300 ? '...' : '';

    // Log to console for visibility - include full length for debugging
    console.log(`[${type}] (${text.length} chars) ${preview}${truncated}`);

    // Write to local log
    this.logStream?.write(`[${type}] ${text}`);

    // Redact secrets before sending
    const sanitized = redactSecrets(text);

    // Detect blocking prompts (patterns that indicate Claude is waiting for user input)
    const promptResult = this.detectBlockingPrompt(sanitized);
    if (promptResult.isPrompt) {
      console.log(`Prompt waiting detected (type: ${promptResult.type})`);
      await this.sendEvent('prompt_waiting', sanitized);
      this.emit('prompt', sanitized);

      // Auto-respond in autonomous mode
      if (this.autonomous) {
        console.log('Autonomous mode: auto-responding to prompt');
        let response = '';

        if (promptResult.type === 'yes') {
          // For trust/safety prompts, answer "1" (Yes, I trust this folder)
          response = '1\n';
        } else if (promptResult.type === 'confirm') {
          // For general yes/no prompts, answer "y"
          response = 'y\n';
        }

        if (response) {
          // Add a delay to ensure the prompt is fully rendered before responding
          await new Promise(resolve => setTimeout(resolve, 500));
          if (this.sendInput(response)) {
            console.log('Auto-response sent successfully');
          } else {
            console.log('Failed to send auto-response');
          }
        }
      }
    }

    // Send to gateway
    try {
      await this.sendEvent(type, sanitized);
    } catch (err) {
      console.error('Failed to send event to gateway:', err);
    }

    this.emit(type, sanitized);
  }

  /**
   * Detect if the worker is waiting for user input (blocking prompt)
   * Returns the prompt type to determine how to respond
   * Common Claude prompt patterns:
   * - "Would you like me to..."
   * - "Should I..."
   * - "Continue?"
   * - "[Y/n]"
   * - "(y/N)"
   * - "Press Enter to continue"
   * - Trust/safety prompts from IDE integrations
   */
  private detectBlockingPrompt(text: string): { isPrompt: boolean; type?: 'yes' | 'confirm' } {
    // Detect trust/safety prompts that should be auto-answered with "1" (yes)
    const trustPrompts = [
      /Is this a project you created or one you trust/i,
      /trust this folder/i,
      /do you want to proceed/i,
      /Yes.*trust.*folder/i,
    ];

    for (const pattern of trustPrompts) {
      if (pattern.test(text)) {
        return { isPrompt: true, type: 'yes' };
      }
    }

    // Detect other blocking prompts
    const promptPatterns = [
      /Would you like me to/i,
      /Should I/i,
      /Do you want me to/i,
      /Continue\??/i,
      /\[Y\/n\]/i,
      /\[y\/N\]/i,
      /\(Y\/n\)/i,
      /\(y\/N\)/i,
      /\[y\/N\]?\s*$/m,
      /Press Enter to continue/i,
      /press enter to continue/i,
      /Enter to proceed/i,
      /Type\s+'y'\s+to\s+continue/i,
      /Type\s+'y'\s+to\s+proceed/i,
      /Type\s+"y"\s+to\s+continue/i,
      /Type\s+'yes'\s+to\s+continue/i,
      /Type\s+'yes'\s+to\s+proceed/i,
      /Type\s+"yes"\s+to\s+continue/i,
      /Would you like to proceed/i,
      /Confirm this change/i,
      /Allow this operation/i,
      /Proceed with this action/i,
      /Are you sure/i,
      /Are you certain/i,
      /\?$/m, // Ends with question mark
    ];

    // Check if any pattern matches
    for (const pattern of promptPatterns) {
      if (pattern.test(text)) {
        return { isPrompt: true, type: 'confirm' };
      }
    }

    return { isPrompt: false };
  }

  /**
   * Send event to gateway
   */
  protected async sendEvent(type: string, data: string): Promise<void> {
    this.sequence++;
    try {
      await sendEvent(this.auth, {
        type: type as any,
        data,
        sequence: this.sequence
      });
      console.log(`✓ Event sent: ${type} (seq: ${this.sequence}, ${data.length} bytes)`);
    } catch (err: any) {
      console.error(`✗ Failed to send event ${type}:`, err.message);

      // Check if this is a fatal error (run deleted, rate limited, etc.)
      if (err.message) {
        const errorMessage = err.message.toLowerCase();
        // Exit on 404 (run not found), 429 (rate limited), or other gateway errors
        if (errorMessage.includes('not found') ||
            errorMessage.includes('429') ||
            errorMessage.includes('rate limit') ||
            errorMessage.includes('unauthorized') ||
            errorMessage.includes('forbidden')) {
          console.error('\n========================================');
          console.error('Fatal error communicating with gateway.');
          console.error('The run may have been deleted or rate limit exceeded.');
          console.error('Exiting gracefully...');
          console.error('========================================\n');
          process.exit(1);
        }
      }

      throw err;
    }
  }

  /**
   * Send marker event
   */
  protected async sendMarker(event: string, details?: object): Promise<void> {
    await this.sendEvent('marker', JSON.stringify({ event, ...details }));
  }

  /**
   * Handle process exit
   */
  protected async handleExit(code: number | null, signal: string | null): Promise<void> {
    this.isRunning = false;
    this.stopCommandPolling();
    this.stopHeartbeat();

    const exitCode = code ?? (signal ? 128 : 1);

    // Save final state
    this.saveState();

    // Send finish marker
    await this.sendMarker('finished', {
      exitCode,
      signal,
      stopRequested: this.stopRequested,
      haltRequested: this.haltRequested,
      workerType: this.getWorkerType()
    });

    // Close log stream
    this.logStream?.end();

    // Upload log file as artifact
    try {
      const logFileName = `${this.getWorkerType()}.log`;
      await uploadArtifact(this.auth, this.logPath, logFileName);
      console.log('Log file uploaded');
    } catch (err) {
      console.error('Failed to upload log:', err);
    }

    this.emit('exit', exitCode);
  }

  /**
   * Request graceful stop (SIGINT, then SIGKILL after timeout)
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.stopRequested = true;
    await this.sendEvent('info', 'Stop requested by operator');

    // Kill all spawned prompt processes first
    console.log(`Stopping ${this.spawnedProcesses.size} spawned processes...`);
    for (const proc of this.spawnedProcesses) {
      try {
        proc.kill('SIGKILL');
      } catch (err) {
        console.error('Error killing spawned process:', err);
      }
    }
    this.spawnedProcesses.clear();

    // If no main process, we're done
    if (!this.process) {
      return;
    }

    // On Windows, SIGINT may not work reliably, so use SIGKILL immediately
    // On other platforms, try SIGINT first but timeout quickly
    const signal = process.platform === 'win32' ? 'SIGKILL' : 'SIGINT';
    console.log(`Sending ${signal} to main process...`);
    this.process.kill(signal);

    // Force kill with SIGKILL after short timeout (2 seconds)
    // This ensures the process doesn't hang
    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        if (this.isRunning && this.process) {
          console.log('Timeout - force killing main process with SIGKILL...');
          try {
            this.process.kill('SIGKILL');
          } catch (err) {
            console.error('Error killing main process:', err);
          }
        }
        resolve();
      }, 2000);

      // Clear timeout if process exits naturally
      if (this.process) {
        this.process.once('close', () => {
          clearTimeout(killTimer);
          resolve();
        });
      }
    });
  }

  /**
   * Hard halt (immediate SIGKILL)
   */
  async halt(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.haltRequested = true;
    await this.sendEvent('info', 'Hard halt requested by operator - killing immediately');

    // Kill all spawned prompt processes first
    console.log(`Hard halting ${this.spawnedProcesses.size} spawned processes...`);
    for (const proc of this.spawnedProcesses) {
      try {
        proc.kill('SIGKILL');
      } catch (err) {
        console.error('Error halting spawned process:', err);
      }
    }
    this.spawnedProcesses.clear();

    // Kill main process if it exists
    if (this.process) {
      this.process.kill('SIGKILL');
    }
  }

  /**
   * Start polling for commands
   */
  private startCommandPolling(): void {
    let pollCount = 0;
    let consecutiveEmptyPolls = 0;
    this.commandPollTimer = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        const commands = await pollCommands(this.auth);
        pollCount++;

        console.log(`\n[POLL #${pollCount}] Retrieved ${commands.length} command(s) from gateway`);

        if (commands.length === 0) {
          consecutiveEmptyPolls++;
          console.log(`[POLL #${pollCount}] No pending commands (${consecutiveEmptyPolls} empty polls in a row)`);
          return;
        }

        consecutiveEmptyPolls = 0;

        // Filter out commands that are already in the dedup window
        const newCommands = commands.filter(cmd => !this.processedCommandIds.has(cmd.id));
        const skippedCount = commands.length - newCommands.length;

        if (skippedCount > 0) {
          console.log(`[POLL #${pollCount}] ⊘ ${skippedCount} command(s) already processed (in dedup window)`);
        }

        if (newCommands.length === 0) {
          console.log(`[POLL #${pollCount}] All commands are in dedup window - nothing new to execute`);
          return;
        }

        console.log(`[POLL #${pollCount}] ✓ ${newCommands.length} new command(s) to execute`);

        for (let i = 0; i < newCommands.length; i++) {
          const cmd = newCommands[i];

          console.log(`[POLL #${pollCount}.${i + 1}] Executing: ID=${cmd.id}, Command=${cmd.command.substring(0, 100)}`);
          await this.executeCommand(cmd);
          console.log(`[POLL #${pollCount}.${i + 1}] ✓ Command execution completed\n`);
        }
      } catch (err) {
        console.error(`[POLL #${pollCount}] Error during polling:`, err);
        // Ignore polling errors
      }
    }, config.commandPollInterval);
  }

  /**
   * Stop polling for commands
   */
  private stopCommandPolling(): void {
    if (this.commandPollTimer) {
      clearInterval(this.commandPollTimer);
      this.commandPollTimer = null;
    }
  }

  /**
   * Mark a command as processed to prevent duplicate execution
   */
  private markCommandProcessed(commandId: string, expireMs: number = 5000): void {
    const wasAlreadyProcessed = this.processedCommandIds.has(commandId);
    this.processedCommandIds.add(commandId);

    // Clear any existing timeout
    const existingTimer = this.processedCommandExpire.get(commandId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timeout to remove from set after expiration
    const timer = setTimeout(() => {
      this.processedCommandIds.delete(commandId);
      this.processedCommandExpire.delete(commandId);
      console.log(`    [DEDUPE EXPIRED] Command ${commandId} removed from deduplication set after ${expireMs / 60000} minute window`);
    }, expireMs);

    this.processedCommandExpire.set(commandId, timer);

    const minutes = expireMs / 60000;
    if (wasAlreadyProcessed) {
      console.log(`    [DEDUPE REFRESH] Command ${commandId} dedup window refreshed to ${minutes} minutes`);
    } else {
      console.log(`    [DEDUPE ADDED] Command ${commandId} added to dedup set (${minutes} minute window)`);
    }
  }

  /**
   * Execute a command from the gateway
   */
  protected async executeCommand(cmd: Command): Promise<void> {
    console.log(`Executing command: ${cmd.command}`);

    // Mark command as being processed to prevent duplicate execution
    // Use 30-minute window so even if ack fails, we won't re-execute within that time
    // This prevents infinite loops from vague prompts that trigger recursive optimization
    this.markCommandProcessed(cmd.id, 30 * 60 * 1000);

    // Handle special commands
    if (cmd.command === '__STOP__') {
      try {
        await this.stop();
        await ackCommand(this.auth, cmd.id, 'Stop initiated');
      } catch (err: any) {
        console.error(`Failed to acknowledge stop command ${cmd.id}:`, err.message);
      }
      return;
    }

    if (cmd.command === '__HALT__') {
      try {
        await this.halt();
        await ackCommand(this.auth, cmd.id, 'Hard halt initiated');
      } catch (err: any) {
        console.error(`Failed to acknowledge halt command ${cmd.id}:`, err.message);
      }
      return;
    }

    if (cmd.command === '__ESCAPE__') {
      const success = this.sendEscape();
      try {
        if (success) {
          await this.sendEvent('info', 'Escape sequence sent (SIGINT)');
          await ackCommand(this.auth, cmd.id, 'Escape sent');
        } else {
          await ackCommand(this.auth, cmd.id, undefined, 'Failed to send escape - process not running');
        }
      } catch (err: any) {
        console.error(`Failed to acknowledge escape command ${cmd.id}:`, err.message);
      }
      return;
    }

    if (cmd.command.startsWith('__INPUT__:')) {
      const input = cmd.command.substring('__INPUT__:'.length);

      try {
        // For workers that support command-line prompts (rev, claude, codex, etc.),
        // spawn a new process with the prompt instead of trying to send input to stdin
        const { args, fullCommand } = this.buildCommand(input, this.autonomous);

        console.log(`\n>>> Executing task via new process`);
        console.log(`    Full command: ${fullCommand}`);
        console.log(`    Command ID: ${cmd.id}`);
        console.log(`    Task text: ${input.substring(0, 150)}${input.length > 150 ? '...' : ''}`);

        // Send info event about what we're executing
        await this.sendEvent('info', `Executing task: ${input}`);

        // Mark as processed BEFORE execution to prevent duplicates
        // Use 30-minute window to prevent re-execution even if ack fails
        const dedupeMs = 30 * 60 * 1000;
        this.markCommandProcessed(cmd.id, dedupeMs);
        console.log(`    ✓ Marked command ${cmd.id} as processed for ${dedupeMs / 60000} minutes`);

        // Track execution start
        const startTime = Date.now();

        // Spawn new process for this task
        console.log(`    ► Starting task execution...`);
        await this.executePrompt(input, args);
        const duration = Date.now() - startTime;

        console.log(`    ◄ Task execution completed after ${duration}ms`);
        const ackResult = await ackCommand(this.auth, cmd.id, `Executed task: ${input.substring(0, 100)}`);
        console.log(`    ✓ Command acknowledged successfully`, ackResult);
      } catch (err: any) {
        console.error(`\n>>> FAILED to execute task ${cmd.id}`);
        console.error(`    Error: ${err.message}`);
        await this.sendEvent('error', `Failed to execute task: ${err.message}`);
        try {
          const ackResult = await ackCommand(this.auth, cmd.id, undefined, `Error: ${err.message}`);
          console.log(`    ✓ Error acknowledged:`, ackResult);
        } catch (ackErr: any) {
          console.error(`    ✗ Failed to acknowledge error for ${cmd.id}:`, ackErr.message);
          await this.sendEvent('error', `Failed to acknowledge command: ${ackErr.message}`);
        }
      }
      return;
    }

    // Validate command is allowlisted
    const isAllowed = config.allowlistedCommands.some(allowed =>
      cmd.command === allowed || cmd.command.startsWith(allowed + ' ')
    );

    if (!isAllowed) {
      await ackCommand(this.auth, cmd.id, undefined, 'Command not in allowlist');
      return;
    }

    // Handle special directory navigation commands
    if (cmd.command.startsWith('cd ')) {
      const path = cmd.command.substring(3).trim();
      const result = this.changeDirectory(path);
      if (result.success) {
        await this.sendEvent('info', result.message);
        await ackCommand(this.auth, cmd.id, result.message);
      } else {
        await this.sendEvent('error', result.message);
        await ackCommand(this.auth, cmd.id, undefined, result.message);
      }
      return;
    }

    // Handle pwd command - show current directory relative to sandbox
    if (cmd.command === 'pwd') {
      const currentDir = this.getWorkingDirectory();
      const message = `Current directory: ${currentDir}`;
      await this.sendEvent('info', message);
      await ackCommand(this.auth, cmd.id, currentDir);
      return;
    }

    // Handle ls/dir commands - show directory listing with relative paths
    if (cmd.command.startsWith('ls') || cmd.command.startsWith('dir') || cmd.command.startsWith('ll')) {
      const args = cmd.command.split(' ').slice(1).join(' ');
      const lsCmd = `ls ${args}`.trim();
      try {
        const result = execSync(lsCmd, {
          cwd: this.workingDir,
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 5 * 1024 * 1024
        });

        const sanitized = redactSecrets(result);
        const header = this.getWorkingDirectory() !== (this as any).sandboxRoot
          ? `Directory: ${this.getWorkingDirectory()}\n`
          : '';

        await this.sendEvent('info', `${header}${sanitized}`);
        await ackCommand(this.auth, cmd.id, sanitized);
      } catch (err: any) {
        const errorMsg = err.stderr || err.message || 'Unknown error';
        const sanitized = redactSecrets(errorMsg);
        await this.sendEvent('error', `Command failed: ${sanitized}`);
        await ackCommand(this.auth, cmd.id, undefined, sanitized);
      }
      return;
    }

    // Execute command in working directory
    try {
      await this.sendEvent('info', `Executing command: ${cmd.command}`);

      const result = execSync(cmd.command, {
        cwd: this.workingDir,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024
      });

      const sanitized = redactSecrets(result);
      await this.sendEvent('info', `Command output:\n${sanitized}`);
      await ackCommand(this.auth, cmd.id, sanitized);

      // If it's a git diff, upload as artifact
      if (cmd.command.startsWith('git diff')) {
        const diffPath = join(config.runsDir, this.auth.runId, 'latest.diff');
        writeFileSync(diffPath, result);
        await uploadArtifact(this.auth, diffPath, 'latest.diff');
      }
    } catch (err: any) {
      const errorMsg = err.stderr || err.message || 'Unknown error';
      const sanitized = redactSecrets(errorMsg);
      await this.sendEvent('error', `Command failed: ${sanitized}`);
      await ackCommand(this.auth, cmd.id, undefined, sanitized);
    }
  }

  /**
   * Execute a prompt by spawning a new worker process
   * Used for handling __INPUT__ commands that contain prompts for workers
   * Note: Rev can get stuck in prompt optimization loops in non-interactive mode,
   * so we timeout execution to prevent infinite loops.
   */
  private async executePrompt(prompt: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const cmd = this.getCommand();
      const env = this.buildEnvironment();
      const useShell = process.platform === 'win32';

      console.log(`Executing prompt with: ${cmd} ${args.join(' ')}`);

      const promptProcess = spawn(cmd, args, {
        cwd: this.workingDir,
        shell: useShell,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        windowsHide: false,
      });

      // Track this process so we can kill it on stop
      this.spawnedProcesses.add(promptProcess);

      // Close stdin immediately since we're not sending any input
      // This allows the spawned process to not wait for stdin
      if (promptProcess.stdin) {
        promptProcess.stdin.end();
      }

      let processCompleted = false;

      // Set a timeout to prevent infinite loops (Rev's prompt optimization can loop indefinitely)
      // Most tasks should complete within 5 minutes; if not, force kill
      const timeoutHandle = setTimeout(() => {
        if (!processCompleted && promptProcess) {
          console.warn(`Prompt execution timeout (5 minutes) - force killing process`);
          promptProcess.kill('SIGKILL');
        }
      }, 5 * 60 * 1000);

      // Capture stdout
      promptProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        console.log(`Prompt stdout: ${output.substring(0, 100)}`);
        this.handleOutput('stdout', data);
      });

      // Capture stderr
      promptProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        console.log(`Prompt stderr: ${output.substring(0, 100)}`);
        this.handleOutput('stderr', data);
      });

      // Handle process completion
      promptProcess.on('close', (code, signal) => {
        processCompleted = true;
        clearTimeout(timeoutHandle);
        console.log(`Prompt process exited with code ${code}, signal ${signal}`);
        // Remove from tracked processes
        this.spawnedProcesses.delete(promptProcess);

        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      });

      // Handle process errors
      promptProcess.on('error', (err) => {
        processCompleted = true;
        clearTimeout(timeoutHandle);
        console.error(`Prompt process error:`, err);
        this.spawnedProcesses.delete(promptProcess);
        reject(err);
      });
    });
  }

  /**
   * Start tmate assist session
   */
  async startAssistSession(): Promise<string | null> {
    try {
      // Check if tmate is available
      execSync('which tmate', { encoding: 'utf8' });
    } catch {
      await this.sendEvent('error', 'tmate not installed. Install with: brew install tmate (macOS) or apt install tmate (Linux)');
      return null;
    }

    try {
      await this.sendEvent('info', 'Starting tmate assist session...');

      // Start tmate in detached mode and get the session URL
      const output = execSync('tmate -F new-session -d -P -f ~/.tmate.conf 2>&1 || tmate -F new-session -d -P 2>&1', {
        cwd: this.workingDir,
        encoding: 'utf8',
        timeout: 30000
      });

      // Parse tmate output for SSH URL
      const sshMatch = output.match(/ssh\s+[\w@\.\-]+/);
      const webMatch = output.match(/https?:\/\/[^\s]+/);

      const sessionUrl = webMatch?.[0] || sshMatch?.[0] || output.trim();

      await sendEvent(this.auth, {
        type: 'assist',
        data: JSON.stringify({ type: 'tmate', url: sessionUrl })
      });

      return sessionUrl;
    } catch (err: any) {
      await this.sendEvent('error', `Failed to start tmate: ${err.message}`);
      return null;
    }
  }

  /**
   * Validate that a path is within the sandbox (initial working directory)
   */
  private validatePathInSandbox(path: string): { valid: boolean; normalized: string } {
    const { resolve, normalize, relative } = require('path');

    const normalized = normalize(path);
    const absolutePath = resolve(this.workingDir, normalized);
    const sandboxRoot = resolve((this as any).sandboxRoot || this.workingDir);

    // Check if the path is within the sandbox
    const resolvedPath = resolve(sandboxRoot, normalized);
    const relativeFromRoot = relative(sandboxRoot, resolvedPath);

    // If path starts with .. or goes above root, it's invalid
    if (relativeFromRoot.startsWith('..') || !absolutePath.startsWith(sandboxRoot)) {
      return { valid: false, normalized: absolutePath };
    }

    return { valid: true, normalized: absolutePath };
  }

  /**
   * Change directory within the sandbox
   */
  private changeDirectory(path: string): { success: boolean; message: string; newDir?: string } {
    const { existsSync, statSync } = require('fs');
    const { resolve, normalize } = require('path');

    // Handle special cases
    if (!path || path === '~') {
      return {
        success: false,
        message: 'Cannot change to home directory - must stay within sandbox'
      };
    }

    if (path === '-') {
      return {
        success: false,
        message: 'Previous directory not tracked - use absolute paths'
      };
    }

    // Normalize and validate the path
    const sandboxRoot = resolve((this as any).sandboxRoot || this.workingDir);
    const absolutePath = resolve(this.workingDir, path);

    // Check if path is within sandbox
    if (!absolutePath.startsWith(sandboxRoot)) {
      return {
        success: false,
        message: `Cannot change directory: path is outside sandbox (${sandboxRoot})`
      };
    }

    // Check if directory exists
    if (!existsSync(absolutePath)) {
      return {
        success: false,
        message: `Directory does not exist: ${path}`
      };
    }

    // Check if it's a directory
    try {
      const stats = statSync(absolutePath);
      if (!stats.isDirectory()) {
        return {
          success: false,
          message: `Not a directory: ${path}`
        };
      }
    } catch (err) {
      return {
        success: false,
        message: `Cannot access directory: ${path}`
      };
    }

    // Update working directory
    this.workingDir = absolutePath;

    // Update state and notify gateway
    this.saveState();
    updateRunState(this.auth, { workingDir: this.workingDir }).catch(() => {});

    return {
      success: true,
      message: `Changed to: ${this.workingDir}`,
      newDir: this.workingDir
    };
  }

  /**
   * Get current working directory
   */
  private getWorkingDirectory(): string {
    // Return relative path from sandbox root for cleaner display
    const { relative } = require('path');
    const sandboxRoot = (this as any).sandboxRoot || this.workingDir;
    const relPath = relative(sandboxRoot, this.workingDir);
    return relPath === '.' ? sandboxRoot : relPath;
  }
}