import { spawn, ChildProcess, execSync } from 'child_process';
import { EventEmitter } from 'events';
import { createWriteStream, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { redactSecrets } from '../utils/crypto.js';
import {
  sendEvent,
  uploadArtifact,
  pollCommands,
  ackCommand,
  updateRunState,
  type RunAuth,
  type Command
} from './gateway-client.js';

export interface RunnerOptions {
  runId: string;
  capabilityToken: string;
  command?: string;
  workingDir?: string;
  autonomous?: boolean;
  resumeFrom?: string;
  model?: string; // For workers that support model selection (Ollama, Gemini)
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
  private processedCommandIds: Set<string> = new Set(); // Track processed commands to prevent duplicates
  private processedCommandExpire: Map<string, NodeJS.Timeout> = new Map(); // Track expiration timers

  constructor(options: RunnerOptions) {
    super();
    this.auth = {
      runId: options.runId,
      capabilityToken: options.capabilityToken
    };
    this.workingDir = options.workingDir || process.cwd();
    // Store the sandbox root - cannot go above this directory
    (this as any).sandboxRoot = this.workingDir;
    this.autonomous = options.autonomous || false;
    this.resumeFrom = options.resumeFrom;
    this.model = options.model;

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

    // Build command based on worker type and mode
    const { args, fullCommand } = this.buildCommand(command, this.autonomous);

    console.log(`Starting ${this.getWorkerType()}: ${fullCommand}`);
    console.log(`Working directory: ${this.workingDir}`);

    // Send start marker
    const startMarker = this.buildStartMarker(fullCommand);
    await this.sendMarker('started', startMarker);

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

    // Spawn worker process with stdin available
    const cmd = this.getCommand();
    const env = this.buildEnvironment();

    console.log(`Spawning process: ${cmd} with args: ${JSON.stringify(args)}`);
    console.log(`Environment: TERM=${env.TERM}`);

    this.process = spawn(cmd, args, {
      cwd: this.workingDir,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env
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
      console.log(`${this.getWorkerType()} exited with code ${code}, signal ${signal}`);
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
      return false;
    }
    try {
      this.process.stdin.write(data);
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

    // Log to console for visibility
    console.log(`[${type}] ${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`);

    // Write to local log
    this.logStream?.write(`[${type}] ${text}`);

    // Redact secrets before sending
    const sanitized = redactSecrets(text);

    // Detect blocking prompts (patterns that indicate Claude is waiting for user input)
    const promptDetected = this.detectBlockingPrompt(sanitized);
    if (promptDetected) {
      console.log('Prompt waiting detected');
      await this.sendEvent('prompt_waiting', sanitized);
      this.emit('prompt', sanitized);
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
   * Common Claude prompt patterns:
   * - "Would you like me to..."
   * - "Should I..."
   * - "Continue?"
   * - "[Y/n]"
   * - "(y/N)"
   * - "Press Enter to continue"
   */
  private detectBlockingPrompt(text: string): boolean {
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
        return true;
      }
    }

    return false;
  }

  /**
   * Send event to gateway
   */
  private async sendEvent(type: string, data: string): Promise<void> {
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
      throw err;
    }
  }

  /**
   * Send marker event
   */
  private async sendMarker(event: string, details?: object): Promise<void> {
    await this.sendEvent('marker', JSON.stringify({ event, ...details }));
  }

  /**
   * Handle process exit
   */
  private async handleExit(code: number | null, signal: string | null): Promise<void> {
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
    if (!this.isRunning || !this.process) {
      return;
    }

    this.stopRequested = true;
    await this.sendEvent('info', 'Stop requested by operator');

    // Send SIGINT first (graceful)
    this.process.kill('SIGINT');

    // Force kill after timeout
    setTimeout(() => {
      if (this.isRunning && this.process) {
        console.log('Force killing process...');
        this.process.kill('SIGKILL');
      }
    }, 10000);
  }

  /**
   * Hard halt (immediate SIGKILL)
   */
  async halt(): Promise<void> {
    if (!this.isRunning || !this.process) {
      return;
    }

    this.haltRequested = true;
    await this.sendEvent('info', 'Hard halt requested by operator - killing immediately');

    // Immediate SIGKILL
    this.process.kill('SIGKILL');
  }

  /**
   * Start polling for commands
   */
  private startCommandPolling(): void {
    this.commandPollTimer = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        const commands = await pollCommands(this.auth);
        for (const cmd of commands) {
          // Skip if this command was recently processed
          if (this.processedCommandIds.has(cmd.id)) {
            console.warn(`Skipping recently processed command: ${cmd.id}`);
            continue;
          }
          await this.executeCommand(cmd);
        }
      } catch (err) {
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
    this.processedCommandIds.add(commandId);

    // Clear any existing timeout
    const existingTimer = this.processedCommandExpire.get(commandId);
    if (existingTimer) clearTimeout(existingTimer);

    // Set new timeout to remove from set after expiration
    const timer = setTimeout(() => {
      this.processedCommandIds.delete(commandId);
      this.processedCommandExpire.delete(commandId);
    }, expireMs);

    this.processedCommandExpire.set(commandId, timer);
  }

  /**
   * Execute a command from the gateway
   */
  private async executeCommand(cmd: Command): Promise<void> {
    console.log(`Executing command: ${cmd.command}`);

    // Mark command as being processed to prevent duplicate execution
    // if ack fails, it will be re-polled after expiration
    this.markCommandProcessed(cmd.id, 10000);

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
      const success = this.sendInput(input);
      try {
        if (success) {
          // Send prompt_resolved event to indicate the prompt was answered
          await this.sendEvent('prompt_resolved', `Response: ${input.replace(/\n/g, '\\n')}`);
          await this.sendEvent('info', `Input sent: ${input.length} bytes`);
          await ackCommand(this.auth, cmd.id, `Sent ${input.length} bytes to stdin`);
        } else {
          await ackCommand(this.auth, cmd.id, undefined, 'Failed to send input - process not running');
        }
      } catch (err: any) {
        console.error(`Failed to acknowledge input command ${cmd.id}:`, err.message);
        await this.sendEvent('error', `Failed to acknowledge input: ${err.message}`);
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