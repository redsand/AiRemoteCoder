import { BaseRunner, RunnerOptions, WorkerCommandResult } from './base-runner.js';
import { config } from '../config.js';
import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Hands-On Runner Options
 */
export interface HandsOnRunnerOptions extends RunnerOptions {
  reason?: string;  // Reason why hands-on mode was launched (e.g., "agent failed")
  shell?: string;   // Shell to use (bash, zsh, fish, etc.) - defaults to user's shell
  fallbackFrom?: string;  // The agent type that failed (claude, gemini, etc.)
}

/**
 * Hands-On Runner - Manual User Intervention Mode
 *
 * This runner launches an interactive shell that gives users complete manual
 * control to fix issues that automated agents cannot resolve. This is a critical
 * fallback mechanism that bridges the gap between automated and manual work.
 *
 * Features:
 * - Full interactive shell access
 * - Complete filesystem control
 * - Manual process execution and debugging
 * - Can be launched from any failing agent
 * - All commands logged and streamed to gateway
 * - Full stdin/stdout/stderr bidirectional communication
 *
 * Use Cases:
 * - Agent failed and needs human intervention
 * - Complex debugging requiring manual investigation
 * - Emergency manual control when agents stuck
 * - Testing and validation before committing changes
 */
export class HandsOnRunner extends BaseRunner {
  private shellProcess: ChildProcess | null = null;
  private reason?: string;
  private fallbackFrom?: string;
  private shell: string;
  private shellReady = false;

  constructor(options: HandsOnRunnerOptions) {
    super(options);

    this.reason = options.reason;
    this.fallbackFrom = options.fallbackFrom;
    this.shell = options.shell || process.env.SHELL || '/bin/bash';

    // Override log path for hands-on-specific logging
    const runDir = join(config.runsDir, options.runId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    (this as any).logPath = join(runDir, 'hands-on.log');
    (this as any).stateFile = join(runDir, 'hands-on-state.json');
  }

  /**
   * Get the worker type identifier
   */
  getWorkerType(): string {
    return 'hands-on';
  }

  /**
   * Get the CLI command - always use the configured shell
   */
  getCommand(): string {
    return this.shell;
  }

  /**
   * Build shell command arguments
   */
  buildCommand(command?: string, autonomous?: boolean): WorkerCommandResult {
    // For hands-on mode, we start an interactive shell with minimal arguments
    const args: string[] = [];

    // Make it interactive and login shell
    if (this.shell.includes('bash')) {
      args.push('--norc');  // Skip .bashrc to avoid blocking prompts
      args.push('-i');      // Interactive
    } else if (this.shell.includes('zsh')) {
      args.push('-i');      // Interactive
    } else if (this.shell.includes('fish')) {
      args.push('-i');      // Interactive
    }

    const fullCommand = `${this.shell} ${args.join(' ')}`;

    return {
      args,
      fullCommand
    };
  }

  /**
   * Start the hands-on interactive shell
   */
  async start(command?: string): Promise<void> {
    if (this.isRunning) {
      throw new Error('Hands-on runner already started');
    }

    this.isRunning = true;

    console.log(`Starting hands-on interactive shell`);
    if (this.reason) {
      console.log(`Reason: ${this.reason}`);
    }
    if (this.fallbackFrom) {
      console.log(`Fallback from: ${this.fallbackFrom}`);
    }
    console.log(`Shell: ${this.shell}`);
    console.log(`Working directory: ${this.workingDir}`);

    const { args, fullCommand } = this.buildCommand(command, false);

    // Send start marker
    const startMarker = this.buildStartMarker(fullCommand);
    (startMarker as any).reason = this.reason;
    (startMarker as any).fallbackFrom = this.fallbackFrom;
    (startMarker as any).shell = this.shell;
    (startMarker as any).interactive = true;
    await this.sendMarker('started', startMarker);

    // Spawn interactive shell process
    const cmd = this.getCommand();
    const env = this.buildEnvironment();

    console.log(`Spawning interactive shell: ${cmd} with args: ${JSON.stringify(args)}`);

    try {
      // Key difference: inherit stdin so user can type interactively
      // Pipe stdout/stderr for logging
      this.shellProcess = spawn(cmd, args, {
        cwd: this.workingDir,
        shell: false,
        stdio: ['inherit', 'pipe', 'pipe'],  // inherit stdin for interactive input
        env,
        detached: false
      });

      console.log(`Shell process spawned with PID: ${this.shellProcess.pid}`);
      this.shellReady = true;

      // Handle stdout
      this.shellProcess.stdout?.on('data', (data: Buffer) => {
        console.log(`Shell stdout: ${data.length} bytes`);
        this.handleOutput('stdout', data);
      });

      // Handle stderr
      this.shellProcess.stderr?.on('data', (data: Buffer) => {
        console.log(`Shell stderr: ${data.length} bytes`);
        this.handleOutput('stderr', data);
      });

      // Handle process exit
      this.shellProcess.on('close', async (code, signal) => {
        console.log(`Interactive shell closed with code: ${code}, signal: ${signal}`);
        await this.handleExit(code, signal);
      });

      this.shellProcess.on('error', async (err) => {
        console.error(`Shell process error:`, err);
        await this.sendEvent('error', `Shell error: ${err.message}`);
        await this.handleExit(1, null);
      });

      // Start command polling and heartbeat
      this.startCommandPolling();
      this.startHeartbeat();

      // Send ready marker
      const readyMsg = this.reason
        ? `Hands-on mode ready (${this.reason})`
        : 'Hands-on mode ready - full manual control';
      await this.sendEvent('info', readyMsg);

    } catch (error: any) {
      console.error(`Failed to start hands-on shell:`, error);
      await this.sendEvent('error', `Failed to start shell: ${error.message}`);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop the hands-on session
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log('Stopping hands-on session...');
    this.stopRequested = true;

    if (this.shellProcess && !this.shellProcess.killed) {
      this.shellProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));

      if (!this.shellProcess.killed) {
        this.shellProcess.kill('SIGKILL');
      }
    }

    this.isRunning = false;

    if (this.commandPollTimer) {
      clearInterval(this.commandPollTimer);
      this.commandPollTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.logStream) {
      this.logStream.destroy();
      this.logStream = null;
    }

    await this.sendEvent('info', 'Hands-on session ended');
  }

  /**
   * Override getState to include hands-on-specific information
   */
  getState() {
    const baseState = super.getState();
    return {
      ...baseState,
      reason: this.reason,
      fallbackFrom: this.fallbackFrom,
      shell: this.shell,
      shellReady: this.shellReady,
      isHandsOn: true
    };
  }

  /**
   * Override buildStartMarker to include hands-on information
   */
  protected buildStartMarker(command: string): Record<string, any> {
    const baseMarker = super.buildStartMarker(command);
    return {
      ...baseMarker,
      reason: this.reason,
      fallbackFrom: this.fallbackFrom,
      shell: this.shell,
      interactive: true,
      capabilities: ['manual_control', 'full_shell_access', 'filesystem_control', 'process_execution', 'keyboard_input']
    };
  }
}
