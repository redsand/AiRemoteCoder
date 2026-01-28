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
  resumeFrom?: string; // Run ID to resume from
}

export class ClaudeRunner extends EventEmitter {
  private auth: RunAuth;
  private process: ChildProcess | null = null;
  private logPath: string;
  private logStream: ReturnType<typeof createWriteStream> | null = null;
  private commandPollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sequence = 0;
  private isRunning = false;
  private workingDir: string;
  private stopRequested = false;
  private haltRequested = false;
  private autonomous: boolean;
  private stateFile: string;
  private resumeFrom?: string;

  constructor(options: RunnerOptions) {
    super();
    this.auth = {
      runId: options.runId,
      capabilityToken: options.capabilityToken
    };
    this.workingDir = options.workingDir || process.cwd();
    this.autonomous = options.autonomous || false;
    this.resumeFrom = options.resumeFrom;

    // Setup log directory
    const runDir = join(config.runsDir, options.runId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    this.logPath = join(runDir, 'claude.log');
    this.stateFile = join(runDir, 'state.json');
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
  } {
    return {
      runId: this.auth.runId,
      isRunning: this.isRunning,
      sequence: this.sequence,
      workingDir: this.workingDir,
      autonomous: this.autonomous,
      stopRequested: this.stopRequested
    };
  }

  /**
   * Save state to disk for recovery
   */
  private saveState(): void {
    const state = {
      runId: this.auth.runId,
      sequence: this.sequence,
      workingDir: this.workingDir,
      autonomous: this.autonomous,
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
  private loadState(): boolean {
    try {
      if (existsSync(this.stateFile)) {
        const data = readFileSync(this.stateFile, 'utf8');
        const state = JSON.parse(data);
        this.sequence = state.sequence || 0;
        return true;
      }
    } catch (err) {
      console.error('Failed to load state:', err);
    }
    return false;
  }

  /**
   * Start Claude Code process
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

    // Build Claude command based on mode
    let claudeArgs: string[] = [];
    let fullCommand: string;

    if (this.autonomous) {
      // Autonomous mode: no prompt, just start Claude in interactive mode
      // Use --dangerously-skip-permissions if available for full autonomy
      claudeArgs = ['--dangerously-skip-permissions'];
      fullCommand = `${config.claudeCommand} (autonomous mode)`;
      console.log('Starting Claude Code in autonomous mode');
    } else if (command) {
      claudeArgs = [command];
      fullCommand = `${config.claudeCommand} ${claudeArgs.join(' ')}`.trim();
      console.log(`Starting Claude Code: ${fullCommand}`);
    } else {
      // Interactive mode without prompt
      fullCommand = config.claudeCommand;
      console.log('Starting Claude Code in interactive mode');
    }

    console.log(`Working directory: ${this.workingDir}`);

    // Send start marker
    await this.sendMarker('started', {
      command: fullCommand,
      workingDir: this.workingDir,
      autonomous: this.autonomous,
      resumedFrom: this.resumeFrom
    });

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

    // Spawn Claude Code process with stdin available
    this.process = spawn(config.claudeCommand, claudeArgs, {
      cwd: this.workingDir,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'], // Enable stdin for input
      env: {
        ...process.env,
        // Don't force CI mode for autonomous/interactive - allow full functionality
        TERM: this.autonomous ? 'xterm-256color' : 'dumb'
      }
    });

    // Handle stdout
    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleOutput('stdout', data);
    });

    // Handle stderr
    this.process.stderr?.on('data', (data: Buffer) => {
      this.handleOutput('stderr', data);
    });

    // Handle process exit
    this.process.on('close', async (code, signal) => {
      console.log(`Claude Code exited with code ${code}, signal ${signal}`);
      await this.handleExit(code, signal);
    });

    this.process.on('error', async (err) => {
      console.error('Claude Code process error:', err);
      await this.sendEvent('error', `Process error: ${err.message}`);
      await this.handleExit(1, null);
    });

    // Start command polling and heartbeat
    this.startCommandPolling();
    this.startHeartbeat();
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
    if (!this.process?.stdin || !this.isRunning) {
      return false;
    }
    try {
      this.process.stdin.write(data);
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
   * Handle output from Claude Code
   */
  private async handleOutput(type: 'stdout' | 'stderr', data: Buffer): Promise<void> {
    const text = data.toString();

    // Write to local log
    this.logStream?.write(`[${type}] ${text}`);

    // Redact secrets before sending
    const sanitized = redactSecrets(text);

    // Send to gateway
    try {
      await this.sendEvent(type, sanitized);
    } catch (err) {
      console.error('Failed to send event:', err);
    }

    this.emit(type, sanitized);
  }

  /**
   * Send event to gateway
   */
  private async sendEvent(type: string, data: string): Promise<void> {
    this.sequence++;
    await sendEvent(this.auth, {
      type: type as any,
      data,
      sequence: this.sequence
    });
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
      haltRequested: this.haltRequested
    });

    // Close log stream
    this.logStream?.end();

    // Upload log file as artifact
    try {
      await uploadArtifact(this.auth, this.logPath, 'claude.log');
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
   * Execute a command from the gateway
   */
  private async executeCommand(cmd: Command): Promise<void> {
    console.log(`Executing command: ${cmd.command}`);

    // Handle special commands
    if (cmd.command === '__STOP__') {
      await this.stop();
      await ackCommand(this.auth, cmd.id, 'Stop initiated');
      return;
    }

    if (cmd.command === '__HALT__') {
      await this.halt();
      await ackCommand(this.auth, cmd.id, 'Hard halt initiated');
      return;
    }

    if (cmd.command === '__ESCAPE__') {
      const success = this.sendEscape();
      if (success) {
        await this.sendEvent('info', 'Escape sequence sent (SIGINT)');
        await ackCommand(this.auth, cmd.id, 'Escape sent');
      } else {
        await ackCommand(this.auth, cmd.id, undefined, 'Failed to send escape - process not running');
      }
      return;
    }

    if (cmd.command.startsWith('__INPUT__:')) {
      const input = cmd.command.substring('__INPUT__:'.length);
      const success = this.sendInput(input);
      if (success) {
        await this.sendEvent('info', `Input sent: ${input.length} bytes`);
        await ackCommand(this.auth, cmd.id, `Sent ${input.length} bytes to stdin`);
      } else {
        await ackCommand(this.auth, cmd.id, undefined, 'Failed to send input - process not running');
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

    // Execute command in working directory
    try {
      await this.sendEvent('info', `Executing command: ${cmd.command}`);

      const result = execSync(cmd.command, {
        cwd: this.workingDir,
        encoding: 'utf8',
        timeout: 60000, // 1 minute timeout
        maxBuffer: 10 * 1024 * 1024 // 10MB
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
}
