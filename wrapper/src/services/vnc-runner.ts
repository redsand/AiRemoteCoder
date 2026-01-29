import { BaseRunner, RunnerOptions, WorkerCommandResult } from './base-runner.js';
import { config } from '../config.js';
import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * VNC Runner Options
 */
export interface VncRunnerOptions extends RunnerOptions {
  vncPort?: number;       // VNC server port (default: 5900 + display number)
  displayMode?: 'screen' | 'window';  // 'screen' for full desktop, 'window' for selected window
  windowTitle?: string;   // For window mode: target window title
  resolution?: string;    // Resolution e.g., "1920x1080"
}

/**
 * VNC Runner - Provides remote desktop access via VNC
 *
 * This runner spawns a VNC server that allows users to take full control
 * of either the entire screen or a selected window. This is a critical
 * fallback mechanism when other AI agents fail or need manual intervention.
 *
 * Features:
 * - Full screen or window-specific VNC access
 * - Real-time desktop streaming
 * - Mouse and keyboard control from remote
 * - Acts as fallback when agents fail
 * - Integrates with hands-on AI runner launcher
 */
export class VncRunner extends BaseRunner {
  private vncProcess: ChildProcess | null = null;
  private vncPort: number;
  private displayMode: 'screen' | 'window';
  private windowTitle?: string;
  private resolution: string;
  private vncPassword?: string;
  private vncReady = false;

  constructor(options: VncRunnerOptions) {
    super(options);

    this.vncPort = options.vncPort || 5900;
    this.displayMode = options.displayMode || 'screen';
    this.windowTitle = options.windowTitle;
    this.resolution = options.resolution || '1920x1080';

    // Override log path for VNC-specific logging
    const runDir = join(config.runsDir, options.runId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    (this as any).logPath = join(runDir, 'vnc.log');
    (this as any).stateFile = join(runDir, 'vnc-state.json');
  }

  /**
   * Get the worker type identifier
   */
  getWorkerType(): string {
    return 'vnc';
  }

  /**
   * Get the CLI command for VNC server
   * Supports x11vnc (most common) and falls back to vncserver
   */
  getCommand(): string {
    // Check for x11vnc first (preferred - no Xvfb needed)
    try {
      const { execSync } = require('child_process');
      execSync('which x11vnc', { stdio: 'ignore' });
      return 'x11vnc';
    } catch {
      // Fall back to vncserver
      try {
        const { execSync } = require('child_process');
        execSync('which vncserver', { stdio: 'ignore' });
        return 'vncserver';
      } catch {
        // Last resort: return x11vnc (will error if not installed)
        return 'x11vnc';
      }
    }
  }

  /**
   * Build VNC server command arguments
   */
  buildCommand(command?: string, autonomous?: boolean): WorkerCommandResult {
    const args: string[] = [];
    const cmd = this.getCommand();

    if (cmd === 'x11vnc') {
      // x11vnc arguments for screen sharing
      args.push('-display', process.env.DISPLAY || ':0');
      args.push('-listen', '127.0.0.1');  // Listen on localhost
      args.push('-port', this.vncPort.toString());
      args.push('-forever');  // Keep running until stopped
      args.push('-nopw');     // No password (connection should be secured at gateway level)
      args.push('-shared');   // Allow multiple concurrent connections
      args.push('-bg');       // Run in background

      if (this.displayMode === 'window' && this.windowTitle) {
        args.push('-windowid', this.windowTitle);
      }

      // Performance settings
      args.push('-threads');
      args.push('-wait', '100');
      args.push('-rfbwait', '100');

      // Disable clipboard sync for security
      args.push('-noclipboard');

      // Add resolution if specified
      if (this.resolution) {
        const [width, height] = this.resolution.split('x');
        args.push('-scale', `${width}x${height}`);
      }

    } else if (cmd === 'vncserver') {
      // vncserver arguments (TigerVNC or TightVNC)
      args.push(`:${this.vncPort - 5900}`);
      args.push('-geometry', this.resolution);
      args.push('-depth', '24');
      args.push('-pixelformat', 'rgb888');
    }

    const fullCommand = `${cmd} ${args.join(' ')}`;

    return {
      args,
      fullCommand
    };
  }

  /**
   * Start the VNC server
   */
  async start(command?: string): Promise<void> {
    if (this.isRunning) {
      throw new Error('VNC runner already started');
    }

    this.isRunning = true;

    console.log(`Starting VNC server`);
    console.log(`Display mode: ${this.displayMode}`);
    console.log(`VNC port: ${this.vncPort}`);
    console.log(`Resolution: ${this.resolution}`);

    const { args, fullCommand } = this.buildCommand(command, this.autonomous);

    // Send start marker
    const startMarker = this.buildStartMarker(fullCommand);
    (startMarker as any).vncPort = this.vncPort;
    (startMarker as any).displayMode = this.displayMode;
    (startMarker as any).resolution = this.resolution;
    await this.sendMarker('started', startMarker);

    // Spawn VNC server process
    const cmd = this.getCommand();
    const env = this.buildEnvironment();

    console.log(`Spawning VNC server: ${cmd} with args: ${JSON.stringify(args)}`);

    try {
      this.vncProcess = spawn(cmd, args, {
        cwd: this.workingDir,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        detached: false
      });

      console.log(`VNC process spawned with PID: ${this.vncProcess.pid}`);
      this.vncReady = true;

      // Handle stdout for VNC server output
      this.vncProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString('utf-8');
        console.log(`VNC stdout: ${output}`);
        this.handleOutput('stdout', data);

        // Detect VNC ready messages
        if (output.includes('Listening') || output.includes('accepting') || output.includes('started')) {
          this.vncReady = true;
        }
      });

      // Handle stderr
      this.vncProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString('utf-8');
        console.log(`VNC stderr: ${output}`);
        this.handleOutput('stderr', data);
      });

      // Handle process exit
      this.vncProcess.on('close', async (code, signal) => {
        console.log(`VNC server closed with code: ${code}, signal: ${signal}`);
        await this.handleExit(code, signal);
      });

      this.vncProcess.on('error', async (err) => {
        console.error(`VNC process error:`, err);
        await this.sendEvent('error', `VNC server error: ${err.message}`);
        await this.handleExit(1, null);
      });

      // Start heartbeat (no command polling needed for VNC)
      this.startHeartbeat();

      // Send ready marker
      await this.sendEvent('info', `VNC server ready on port ${this.vncPort}`);

    } catch (error: any) {
      console.error(`Failed to start VNC server:`, error);
      await this.sendEvent('error', `Failed to start VNC server: ${error.message}`);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop the VNC server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log('Stopping VNC server...');
    this.stopRequested = true;

    if (this.vncProcess && !this.vncProcess.killed) {
      this.vncProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 2000));

      if (!this.vncProcess.killed) {
        this.vncProcess.kill('SIGKILL');
      }
    }

    this.isRunning = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.logStream) {
      this.logStream.destroy();
      this.logStream = null;
    }

    await this.sendEvent('info', 'VNC server stopped');
  }

  /**
   * Override getState to include VNC-specific information
   */
  getState() {
    const baseState = super.getState();
    return {
      ...baseState,
      vncPort: this.vncPort,
      displayMode: this.displayMode,
      vncReady: this.vncReady,
      resolution: this.resolution
    };
  }

  /**
   * Override buildStartMarker to include VNC information
   */
  protected buildStartMarker(command: string): Record<string, any> {
    const baseMarker = super.buildStartMarker(command);
    return {
      ...baseMarker,
      vncPort: this.vncPort,
      displayMode: this.displayMode,
      resolution: this.resolution,
      capabilities: ['vnc_access', 'remote_desktop', 'mouse_control', 'keyboard_control']
    };
  }
}
