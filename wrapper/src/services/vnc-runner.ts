import { BaseRunner, RunnerOptions, WorkerCommandResult } from './base-runner.js';
import { spawn, execSync, ChildProcess } from 'child_process';
import { ackCommand } from './gateway-client.js';

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
 * VNC Start Marker - extends with VNC-specific properties
 */
interface VncStartMarker extends Record<string, any> {
  vncPort: number;
  displayMode: 'screen' | 'window';
  resolution: string;
  capabilities: string[];
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
 *
 * CRITICAL: VNC is a remote desktop tool, not a command executor.
 * It does not process commands from the gateway - it only streams the desktop.
 */
export class VncRunner extends BaseRunner {
  private vncProcess: ChildProcess | null = null;
  private vncPort: number;
  private displayMode: 'screen' | 'window';
  private windowTitle?: string;
  private resolution: string;
  private vncReady = false;
  private startupPromise: Promise<void> | null = null;
  private startupResolve: (() => void) | null = null;
  private startupReject: ((error: Error) => void) | null = null;

  constructor(options: VncRunnerOptions) {
    super(options);

    this.vncPort = options.vncPort || 5900;
    this.displayMode = options.displayMode || 'screen';
    this.windowTitle = options.windowTitle;
    this.resolution = options.resolution || '1920x1080';

    // NOTE: DO NOT override log path here
    // BaseRunner handles logging correctly relative to working directory
    // Overriding causes logs to be written to wrong directory
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
    // Import execSync once at the top to avoid repeated require calls
    try {
      execSync('which x11vnc', { stdio: 'ignore' });
      return 'x11vnc';
    } catch {
      // Fall back to vncserver
      try {
        execSync('which vncserver', { stdio: 'ignore' });
        return 'vncserver';
      } catch {
        // If neither is found, throw error instead of silently failing
        throw new Error('Neither x11vnc nor vncserver found. Please install VNC server: sudo apt-get install x11vnc OR tigervnc-server');
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
      // Note: DISPLAY must be set or default to :0
      const display = process.env.DISPLAY || ':0';
      if (!display) {
        throw new Error('DISPLAY environment variable not set. Cannot start VNC server without a display.');
      }
      args.push('-display', display);
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
        if (width && height) {
          args.push('-scale', `${width}x${height}`);
        }
      }

    } else if (cmd === 'vncserver') {
      // vncserver arguments (TigerVNC or TightVNC)
      const displayNum = (this.vncPort - 5900).toString();
      args.push(`:${displayNum}`);
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
   * Returns a promise that resolves when VNC is ready or rejects on startup failure
   */
  async start(command?: string): Promise<void> {
    if ((this as any).isRunning) {
      throw new Error('VNC runner already started');
    }

    // Create a promise that can be rejected if startup fails
    this.startupPromise = new Promise<void>((resolve, reject) => {
      this.startupResolve = resolve;
      this.startupReject = reject;
    });

    (this as any).isRunning = true;

    console.log(`Starting VNC server`);
    console.log(`Display mode: ${this.displayMode}`);
    console.log(`VNC port: ${this.vncPort}`);
    console.log(`Resolution: ${this.resolution}`);

    try {
      const { args, fullCommand } = this.buildCommand(command, (this as any).autonomous);

      // Send start marker
      const startMarker: VncStartMarker = {
        ...this.buildStartMarker(fullCommand),
        vncPort: this.vncPort,
        displayMode: this.displayMode,
        resolution: this.resolution,
        capabilities: ['vnc_access', 'remote_desktop', 'mouse_control', 'keyboard_control']
      };
      await this.sendMarker('started', startMarker);

      // Spawn VNC server process
      const cmd = this.getCommand();
      const env = this.buildEnvironment();

      console.log(`Spawning VNC server: ${cmd} with args: ${JSON.stringify(args)}`);

      this.vncProcess = spawn(cmd, args, {
        cwd: (this as any).workingDir,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        detached: false
      });

      if (!this.vncProcess) {
        throw new Error('Failed to spawn VNC process');
      }

      console.log(`VNC process spawned with PID: ${this.vncProcess.pid}`);
      this.vncReady = true;

      // Handle stdout for VNC server output
      this.vncProcess.stdout?.on('data', async (data: Buffer) => {
        const output = data.toString('utf-8');
        console.log(`VNC stdout: ${output}`);
        // handleOutput is private in BaseRunner, use type casting
        await (this as any).handleOutput('stdout', data);

        // Detect VNC ready messages
        if (output.includes('Listening') || output.includes('accepting') || output.includes('started')) {
          this.vncReady = true;
          console.log('VNC server ready for connections');
          // Resolve the startup promise when ready
          if (this.startupResolve) {
            this.startupResolve();
            this.startupResolve = null;
          }
        }
      });

      // Handle stderr
      this.vncProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString('utf-8');
        console.log(`VNC stderr: ${output}`);
        (this as any).handleOutput('stderr', data);
      });

      // Handle process exit
      this.vncProcess.on('close', async (code, signal) => {
        console.log(`VNC server closed with code: ${code}, signal: ${signal}`);
        await this.handleExit(code, signal);
      });

      // Handle process error - THIS IS CRITICAL for startup failure detection
      this.vncProcess.on('error', async (err) => {
        console.error(`VNC process error:`, err);
        await this.sendEvent('error', `VNC server error: ${err.message}`);
        await this.handleExit(1, null);
        // CRITICAL FIX: Reject the startup promise so caller knows about the error
        if (this.startupReject) {
          this.startupReject(err);
          this.startupReject = null;
        }
      });

      // Start heartbeat (no command polling needed for VNC)
      (this as any).startHeartbeat();

      // Send ready marker
      await this.sendEvent('info', `VNC server ready on port ${this.vncPort}`);

      // Wait for startup promise or return immediately
      // VNC might not send "Listening" message, so use a timeout
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (this.startupResolve) {
            this.startupResolve();
            this.startupResolve = null;
          }
          resolve();
        }, 2000);
      });

      await Promise.race([this.startupPromise, timeout]);

    } catch (error: any) {
      console.error(`Failed to start VNC server:`, error);
      await this.sendEvent('error', `Failed to start VNC server: ${error.message}`);
      (this as any).isRunning = false;

      // Reject the startup promise
      if (this.startupReject) {
        this.startupReject(error);
        this.startupReject = null;
      }

      throw error;
    }
  }

  /**
   * Override executeCommand to handle VNC-specific behavior
   * VNC is a remote desktop tool, not a command executor
   */
  async executeCommand(cmd: any): Promise<void> {
    console.log(`VNC runner received command: ${cmd.id}`);
    console.log(`VNC is a remote desktop tool and does not execute commands`);

    // VNC runners don't execute commands - they provide remote desktop access
    // Acknowledge the command but don't process it
    try {
      await ackCommand(this.auth, cmd.id, 'VNC runner does not execute commands - provides remote desktop access only');
    } catch (err: any) {
      console.error(`Failed to acknowledge command:`, err.message);
    }
  }

  /**
   * Stop the VNC server
   */
  async stop(): Promise<void> {
    if (!(this as any).isRunning) {
      return;
    }

    console.log('Stopping VNC server...');
    (this as any).stopRequested = true;

    try {
      await this.sendEvent('info', 'Stopping VNC server');
    } catch (err) {
      console.error('Failed to send stop event:', err);
    }

    if (this.vncProcess && !this.vncProcess.killed) {
      try {
        this.vncProcess.kill('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 2000));

        if (!this.vncProcess.killed) {
          this.vncProcess.kill('SIGKILL');
        }
      } catch (err) {
        console.error('Failed to kill VNC process:', err);
      }
    }

    // Clear heartbeat
    if ((this as any).heartbeatTimer) {
      clearInterval((this as any).heartbeatTimer);
      (this as any).heartbeatTimer = null;
    }

    // Close log stream if exists
    if ((this as any).logStream) {
      try {
        (this as any).logStream.destroy();
      } catch (err) {
        console.error('Failed to close log stream:', err);
      }
      (this as any).logStream = null;
    }

    (this as any).isRunning = false;

    try {
      await this.sendEvent('info', 'VNC server stopped');
    } catch (err) {
      console.error('Failed to send stop event:', err);
    }

    // CRITICAL FIX: Call parent class cleanup
    await super.stop();
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
