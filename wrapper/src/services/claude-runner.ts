import { spawn, ChildProcess, execSync } from 'child_process';
import { EventEmitter } from 'events';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { redactSecrets } from '../utils/crypto.js';
import {
  sendEvent,
  uploadArtifact,
  pollCommands,
  ackCommand,
  type RunAuth,
  type Command
} from './gateway-client.js';

export interface RunnerOptions {
  runId: string;
  capabilityToken: string;
  command?: string;
  workingDir?: string;
}

export class ClaudeRunner extends EventEmitter {
  private auth: RunAuth;
  private process: ChildProcess | null = null;
  private logPath: string;
  private logStream: ReturnType<typeof createWriteStream> | null = null;
  private commandPollTimer: NodeJS.Timeout | null = null;
  private sequence = 0;
  private isRunning = false;
  private workingDir: string;
  private stopRequested = false;

  constructor(options: RunnerOptions) {
    super();
    this.auth = {
      runId: options.runId,
      capabilityToken: options.capabilityToken
    };
    this.workingDir = options.workingDir || process.cwd();

    // Setup log directory
    const runDir = join(config.runsDir, options.runId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    this.logPath = join(runDir, 'claude.log');
  }

  /**
   * Start Claude Code process
   */
  async start(command?: string): Promise<void> {
    if (this.isRunning) {
      throw new Error('Runner already started');
    }

    this.isRunning = true;
    this.logStream = createWriteStream(this.logPath, { flags: 'a' });

    // Build Claude command
    const claudeArgs = command ? [command] : [];
    const fullCommand = `${config.claudeCommand} ${claudeArgs.join(' ')}`.trim();

    console.log(`Starting Claude Code: ${fullCommand}`);
    console.log(`Working directory: ${this.workingDir}`);

    // Send start marker
    await this.sendMarker('started', { command: fullCommand, workingDir: this.workingDir });

    // Spawn Claude Code process
    this.process = spawn(config.claudeCommand, claudeArgs, {
      cwd: this.workingDir,
      shell: true,
      env: {
        ...process.env,
        // Force non-interactive mode if available
        CI: 'true',
        TERM: 'dumb'
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

    // Start command polling
    this.startCommandPolling();
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

    const exitCode = code ?? (signal ? 128 : 1);

    // Send finish marker
    await this.sendMarker('finished', { exitCode, signal });

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
   * Request graceful stop
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
        const { writeFileSync } = await import('fs');
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
