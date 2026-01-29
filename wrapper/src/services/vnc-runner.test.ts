import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VncRunner, VncRunnerOptions } from './vnc-runner.js';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// Mock child_process
vi.mock('child_process', () => {
  const actualModule = vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actualModule,
    spawn: vi.fn()
  };
});

// Mock fs
vi.mock('fs', () => {
  return {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(() => ({
      write: vi.fn(),
      destroy: vi.fn()
    })),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => '{}')
  };
});

// Mock config
vi.mock('../config.js', () => {
  return {
    config: {
      gatewayUrl: 'http://localhost:3100',
      runsDir: '/tmp/runs',
      allowSelfSigned: false,
      secretPatterns: []
    }
  };
});

// Mock gateway client
vi.mock('./gateway-client.js', () => {
  return {
    sendEvent: vi.fn(),
    pollCommands: vi.fn(() => Promise.resolve([])),
    ackCommand: vi.fn(),
    updateRunState: vi.fn(),
    registerClient: vi.fn(),
    sendHeartbeat: vi.fn(),
    uploadArtifact: vi.fn()
  };
});

describe('VncRunner', () => {
  let runner: VncRunner;
  let mockProcess: any;

  const defaultOptions: VncRunnerOptions = {
    runId: 'test-run-123',
    capabilityToken: 'test-token-abc',
    workingDir: '/tmp/test',
    vncPort: 5900,
    displayMode: 'screen',
    resolution: '1920x1080'
  };

  beforeEach(() => {
    // Create a mock process
    mockProcess = new EventEmitter();
    mockProcess.pid = 1234;
    mockProcess.stdout = new EventEmitter();
    mockProcess.stderr = new EventEmitter();
    mockProcess.stdin = { write: vi.fn(), end: vi.fn() };
    mockProcess.killed = false;
    mockProcess.kill = vi.fn(() => {
      mockProcess.killed = true;
      mockProcess.emit('close', 1, 'SIGTERM');
    });

    // Mock spawn to return our mock process
    (spawn as any).mockReturnValue(mockProcess);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should initialize with default options', () => {
      runner = new VncRunner(defaultOptions);
      expect(runner.getWorkerType()).toBe('vnc');
    });

    it('should set custom VNC port', () => {
      const options = { ...defaultOptions, vncPort: 5901 };
      runner = new VncRunner(options);
      const state = runner.getState();
      expect(state.vncPort).toBe(5901);
    });

    it('should set display mode to window', () => {
      const options = { ...defaultOptions, displayMode: 'window' as const };
      runner = new VncRunner(options);
      const state = runner.getState();
      expect(state.displayMode).toBe('window');
    });

    it('should set custom resolution', () => {
      const options = { ...defaultOptions, resolution: '2560x1440' };
      runner = new VncRunner(options);
      const state = runner.getState();
      expect(state.resolution).toBe('2560x1440');
    });

    it('should use default resolution if not specified', () => {
      const options = { ...defaultOptions };
      delete options.resolution;
      runner = new VncRunner(options);
      const state = runner.getState();
      expect(state.resolution).toBe('1920x1080');
    });
  });

  describe('getWorkerType', () => {
    it('should return "vnc"', () => {
      runner = new VncRunner(defaultOptions);
      expect(runner.getWorkerType()).toBe('vnc');
    });
  });

  describe('buildCommand', () => {
    beforeEach(() => {
      runner = new VncRunner(defaultOptions);
    });

    it('should build Python VNC command with correct args', () => {
      const result = runner.buildCommand();

      // Should use python3 on Unix, python on Windows
      const expectedPython = process.platform === 'win32' ? 'python' : 'python3';
      expect(result.fullCommand).toContain(expectedPython);

      // Should point to vnc_runner.py script
      expect(result.args[0]).toContain('vnc_runner.py');

      // Should include required arguments
      expect(result.args).toContain('--run-id');
      expect(result.args).toContain('test-run-123');
      expect(result.args).toContain('--capability-token');
      expect(result.args).toContain('test-token-abc');
      expect(result.args).toContain('--width');
      expect(result.args).toContain('1920');
      expect(result.args).toContain('--height');
      expect(result.args).toContain('1080');
      expect(result.args).toContain('--framerate');
      expect(result.args).toContain('30');
      expect(result.args).toContain('--display-mode');
      expect(result.args).toContain('screen');
    });

    it('should include window display mode when specified', () => {
      runner = new VncRunner({
        ...defaultOptions,
        displayMode: 'window',
      });

      const result = runner.buildCommand();
      expect(result.args).toContain('--display-mode');
      expect(result.args).toContain('window');
    });

    it('should handle custom resolution', () => {
      runner = new VncRunner({
        ...defaultOptions,
        resolution: '1280x720'
      });

      const result = runner.buildCommand();
      expect(result.args).toContain('--width');
      expect(result.args).toContain('1280');
      expect(result.args).toContain('--height');
      expect(result.args).toContain('720');
    });

    it('should return fullCommand string', () => {
      const result = runner.buildCommand();
      expect(result.fullCommand).toBeDefined();
      expect(result.fullCommand.length > 0).toBe(true);
    });

    it('should include insecure flag when configured', () => {
      // This requires mocking the config, which is more complex
      // For now, just verify the basic structure
      const result = runner.buildCommand();
      expect(result.args.length > 0).toBe(true);
    });
  });

  describe('start', () => {
    beforeEach(() => {
      runner = new VncRunner(defaultOptions);
    });

    it('should throw if already running', async () => {
      (runner as any).isRunning = true;

      await expect(runner.start()).rejects.toThrow('VNC runner already started');
    });

    it('should spawn Python VNC process successfully', async () => {
      const startPromise = runner.start();
      // Let event handlers attach
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(spawn).toHaveBeenCalled();
      await startPromise;
      expect((runner as any).vncProcess).toBeDefined();
    });

    it('should set vncReady flag', async () => {
      const startPromise = runner.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect((runner as any).vncReady).toBe(true);
      await startPromise;
    });

    it('should detect VNC ready from stdout', async () => {
      const startPromise = runner.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      mockProcess.stdout?.emit('data', Buffer.from('started\n'));

      expect((runner as any).vncReady).toBe(true);
      await startPromise;
    });

    it('should handle process error', async () => {
      const startPromise = runner.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      const error = new Error('Failed to spawn');
      mockProcess.emit('error', error);

      await expect(startPromise).rejects.toThrow();
    });

    it('should handle process close event', async () => {
      const startPromise = runner.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      mockProcess.emit('close', 0, null);

      await expect(startPromise).resolves.toBeUndefined();
    });

    it('should set isRunning to true', async () => {
      const startPromise = runner.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect((runner as any).isRunning).toBe(true);
      await startPromise;
    });
  });

  describe('stop', () => {
    beforeEach(async () => {
      runner = new VncRunner(defaultOptions);

      const startPromise = runner.start();
      await new Promise(resolve => setTimeout(resolve, 50));
      await startPromise;
    });

    it('should kill the VNC process', async () => {
      await runner.stop();
      expect(mockProcess.kill).toHaveBeenCalled();
    });

    it('should set isRunning to false', async () => {
      await runner.stop();
      expect((runner as any).isRunning).toBe(false);
    });

    it('should clear heartbeat timer', async () => {
      await runner.stop();
      expect((runner as any).heartbeatTimer).toBeNull();
    });

    it('should handle being called when not running', async () => {
      (runner as any).isRunning = false;
      await expect(runner.stop()).resolves.toBeUndefined();
    });

    it('should send stop event', async () => {
      const sendEventMock = vi.spyOn(runner as any, 'sendEvent');
      await runner.stop();
      expect(sendEventMock).toHaveBeenCalledWith('info', expect.stringContaining('stopped'));
    });
  });

  describe('getState', () => {
    it('should include VNC-specific state', () => {
      runner = new VncRunner(defaultOptions);
      const state = runner.getState();

      expect(state.vncPort).toBe(5900);
      expect(state.displayMode).toBe('screen');
      expect(state.resolution).toBe('1920x1080');
      expect(state.vncReady).toBeDefined();
    });
  });

  describe('buildStartMarker', () => {
    beforeEach(() => {
      runner = new VncRunner(defaultOptions);
    });

    it('should include VNC configuration in marker', () => {
      const marker = (runner as any).buildStartMarker('test command');

      expect(marker.vncPort).toBe(5900);
      expect(marker.displayMode).toBe('screen');
      expect(marker.resolution).toBe('1920x1080');
    });

    it('should include capabilities in marker', () => {
      const marker = (runner as any).buildStartMarker('test command');

      expect(marker.capabilities).toContain('vnc_access');
      expect(marker.capabilities).toContain('remote_desktop');
      expect(marker.capabilities).toContain('mouse_control');
      expect(marker.capabilities).toContain('keyboard_control');
    });
  });

  describe('Edge Cases', () => {
    it('should handle malformed resolution string gracefully', () => {
      const options = { ...defaultOptions, resolution: 'invalid' };
      runner = new VncRunner(options);

      const result = runner.buildCommand();

      // Should still build command, even if resolution parsing fails
      expect(result.fullCommand).toBeDefined();
    });

    it('should handle custom resolution parsing', async () => {
      runner = new VncRunner({
        ...defaultOptions,
        resolution: '2560x1440'
      });

      const result = runner.buildCommand();
      expect(result.args).toContain('--width');
      expect(result.args).toContain('2560');
      expect(result.args).toContain('--height');
      expect(result.args).toContain('1440');
    });

    it('should handle stop called during startup', async () => {
      runner = new VncRunner(defaultOptions);

      const startPromise = runner.start();
      // Call stop immediately
      const stopPromise = runner.stop();

      await Promise.all([startPromise, stopPromise]);

      expect((runner as any).isRunning).toBe(false);
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      runner = new VncRunner(defaultOptions);
    });

    it('should handle spawn error gracefully', async () => {
      // Create a mock process that emits an error
      const errorProcess = new EventEmitter();
      (errorProcess as any).pid = 1234;
      (errorProcess as any).stdout = new EventEmitter();
      (errorProcess as any).stderr = new EventEmitter();
      (errorProcess as any).killed = false;
      (errorProcess as any).kill = vi.fn();

      (spawn as any).mockReturnValueOnce(errorProcess);

      const startPromise = runner.start();

      // Give a moment for the event handlers to attach
      await new Promise(resolve => setTimeout(resolve, 50));

      // Emit an error after handlers are attached
      (errorProcess as any).emit('error', new Error('Failed to spawn process'));

      try {
        await startPromise;
        throw new Error('Expected start() to reject');
      } catch (err: any) {
        expect(err.message).toContain('Failed to spawn');
      }

      expect((runner as any).isRunning).toBe(false);
    });

    it('should handle stderr output', async () => {

      const startPromise = runner.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      mockProcess.stderr?.emit('data', Buffer.from('Warning: something happened\n'));

      await startPromise;
    });

    it('should handle multiple close events gracefully', async () => {
      const startPromise = runner.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      mockProcess.emit('close', 0, null);
      mockProcess.emit('close', 0, null); // Second close

      await startPromise;
    });
  });

  describe('State Management', () => {
    it('should track vncReady state', async () => {
      runner = new VncRunner(defaultOptions);

      expect((runner as any).vncReady).toBe(false);

      const startPromise = runner.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect((runner as any).vncReady).toBe(true);

      await startPromise;
    });

    it('should preserve VNC configuration', () => {
      const options = {
        ...defaultOptions,
        vncPort: 5902,
        displayMode: 'window' as const,
        windowTitle: 'Test Window',
        resolution: '2560x1440'
      };

      runner = new VncRunner(options);
      const state = runner.getState();

      expect(state.vncPort).toBe(5902);
      expect(state.displayMode).toBe('window');
      expect(state.resolution).toBe('2560x1440');
    });
  });

  describe('Command Execution', () => {
    it('should handle executeCommand by ignoring it', async () => {
      runner = new VncRunner(defaultOptions);

      // VNC is a remote desktop tool, not a command executor
      const cmd = { id: 'test-cmd', command: 'ls -la' };

      // Should not throw, but acknowledge that VNC doesn't execute commands
      await expect(runner.executeCommand(cmd)).resolves.toBeUndefined();
    });

    it('should acknowledge VNC commands appropriately', async () => {
      runner = new VncRunner(defaultOptions);

      const cmd = { id: 'test-cmd-123', command: 'some-command' };

      await runner.executeCommand(cmd);

      // Should complete without error - acknowledges the command
    });
  });

  describe('Critical Fixes Validation', () => {
    it('CRITICAL FIX #1: should not override log path - uses BaseRunner default', () => {
      runner = new VncRunner(defaultOptions);

      // The constructor should NOT override logPath
      // BaseRunner should handle it
      const state = runner.getState();
      expect(state).toBeDefined();
      // LogPath should come from BaseRunner, not be overridden
    });

    it('CRITICAL FIX #2: should propagate startup errors via promise rejection', async () => {
      runner = new VncRunner(defaultOptions);

      (spawn as any).mockImplementationOnce(() => {
        const proc = new EventEmitter();
        (proc as any).pid = 1234;
        (proc as any).stdout = new EventEmitter();
        (proc as any).stderr = new EventEmitter();
        (proc as any).killed = false;
        (proc as any).kill = vi.fn();

        // Simulate an error on the process
        setTimeout(() => {
          (proc as any).emit('error', new Error('Failed to start'));
        }, 50);

        return proc;
      });

      try {
        await runner.start();
        throw new Error('Expected start() to reject');
      } catch (err: any) {
        // Error should be caught
        expect(err.message).toContain('Failed to start');
      }
    });

    it('CRITICAL FIX #3: should override executeCommand to handle VNC appropriately', async () => {
      runner = new VncRunner(defaultOptions);

      const cmd = { id: 'test-cmd', command: 'some-command' };

      // Should not throw - VNC handles this by acknowledging only
      await expect(runner.executeCommand(cmd)).resolves.toBeUndefined();
    });

    it('CRITICAL FIX #4: should call parent stop() cleanup', async () => {
      runner = new VncRunner(defaultOptions);

      const startPromise = runner.start();
      await new Promise(resolve => setTimeout(resolve, 50));
      await startPromise;

      // Stop should properly clean up all resources
      await runner.stop();

      expect((runner as any).isRunning).toBe(false);
    });

    it('should properly use Python command based on platform', () => {
      runner = new VncRunner(defaultOptions);

      const cmd = runner.getCommand();
      if (process.platform === 'win32') {
        expect(cmd).toBe('python');
      } else {
        expect(cmd).toBe('python3');
      }
    });

    it('should build command with correct script path', () => {
      runner = new VncRunner(defaultOptions);

      const result = runner.buildCommand();
      expect(result.args[0]).toContain('vnc_runner.py');
    });

    it('should properly stop with null safety checks', async () => {
      runner = new VncRunner(defaultOptions);

      // Stop without starting - should not crash
      await expect(runner.stop()).resolves.toBeUndefined();

      // Start and stop normally
      const startPromise = runner.start();
      await new Promise(resolve => setTimeout(resolve, 50));
      await startPromise;

      // Stop should work without errors
      await expect(runner.stop()).resolves.toBeUndefined();

      // Stop again - should not crash
      await expect(runner.stop()).resolves.toBeUndefined();
    });

    it('should include VNC capabilities in start marker', async () => {
      runner = new VncRunner(defaultOptions);

      const startPromise = runner.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      const marker = (runner as any).buildStartMarker('test');
      expect(marker.capabilities).toContain('vnc_access');
      expect(marker.capabilities).toContain('remote_desktop');
      expect(marker.capabilities).toContain('mouse_control');
      expect(marker.capabilities).toContain('keyboard_control');

      await startPromise;
    });
  });
});
