import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Partial mocks - only mock what's necessary for testing
vi.mock('../config.js', () => ({
  config: {
    projectRoot: tmpdir(),
    runsDir: join(tmpdir(), 'runs'),
    codexCommand: 'codex',
    commandPollInterval: 100,
    heartbeatInterval: 1000,
    allowlistedCommands: ['npm test', 'cd', 'ls', 'pwd', 'git diff'],
    secretPatterns: [/api[_-]?key[=:]\\s*[\"']?[\\w-]+[\"']?/gi],
    codexSubcommand: 'exec',
    codexPromptFlag: '',
    codexResumeOnStart: false,
    codexResumeLast: true,
    codexArgs: [],
    getWorkerCommand: (workerType: string) => {
      const commands: Record<string, string> = {
        claude: 'claude',
        'ollama-launch': 'ollama',
        codex: 'codex',
        gemini: 'gemini',
        rev: 'rev'
      };
      return commands[workerType] || workerType;
    }
  }
}));

vi.mock('./gateway-client.js', () => ({
  sendEvent: vi.fn().mockResolvedValue(undefined),
  uploadArtifact: vi.fn().mockResolvedValue({ artifactId: 'test' }),
  pollCommands: vi.fn().mockResolvedValue([]),
  ackCommand: vi.fn().mockResolvedValue(undefined),
  updateRunState: vi.fn().mockResolvedValue(undefined),
  registerClient: vi.fn().mockResolvedValue(undefined),
  sendHeartbeat: vi.fn().mockResolvedValue(undefined)
}));

import { GenericRunner } from './generic-runner.js';
import { BaseRunner, type RunnerOptions } from './base-runner.js';

describe('Codex Runner - Integration Tests', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'codex-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('buildCommand() - Real Behavior', () => {
    let runner: GenericRunner;

    beforeEach(() => {
      runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'codex'
      });
    });

    it('should build codex exec command with prompt', () => {
      const { args, fullCommand } = runner.buildCommand('create a hello world script', false);
      expect(args).toEqual(['exec', 'create a hello world script']);
      expect(fullCommand).toBe('codex exec create a hello world script');
    });

    it('should build codex exec command without prompt', () => {
      const { args, fullCommand } = runner.buildCommand(undefined, false);
      expect(args).toEqual(['exec']);
      expect(fullCommand).toBe('codex exec');
    });

    it('should build codex resume command when resumeFrom is set', () => {
      const resumeRunner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'codex',
        resumeFrom: 'previous-run'
      });

      const { args, fullCommand } = resumeRunner.buildCommand('continue', false);
      expect(args).toEqual(['resume', '--last', 'continue']);
      expect(fullCommand).toBe('codex resume --last continue');
    });

    it('should handle long commands with spaces', () => {
      const longCommand = 'create a comprehensive test suite for the authentication module covering edge cases like expired tokens invalid passwords and rate limiting';
      const { args } = runner.buildCommand(longCommand, false);
      expect(args).toEqual(['exec', longCommand]);
      expect(args[1]).toBe(longCommand);
    });

    it('should handle empty command', () => {
      const { args, fullCommand } = runner.buildCommand('', false);
      expect(args).toEqual(['exec']);
      expect(fullCommand).toBe('codex exec');
    });

    it('should handle commands with special characters', () => {
      const command = 'create a script with "quotes" and $symbols';
      const { args } = runner.buildCommand(command, false);
      expect(args).toEqual(['exec', command]);
      expect(args[1]).toBe(command);
    });
  });

  describe('shouldUseShell() - Windows PowerShell script', () => {
    let runner: GenericRunner;

    beforeEach(() => {
      runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'codex'
      });
    });

    it('should return true on Windows (for PowerShell scripts)', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });

      try {
        const useShell = (runner as any).shouldUseShell();
        expect(useShell).toBe(true);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('should return false on non-Windows platforms', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux' });

      try {
        const useShell = (runner as any).shouldUseShell();
        expect(useShell).toBe(false);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });

  describe('Environment Variables', () => {
    let runner: GenericRunner;

    beforeEach(() => {
      runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'codex'
      });
    });

    it('should build environment with API keys', () => {
      const env = (runner as any).buildEnvironment();
      expect(env).toBeDefined();
      expect(env.OPENAI_API_KEY).toBe('');
      expect(env.CODEX_API_KEY).toBe('');
      // Should also have inherited PATH and other process env vars
      expect(env.TERM).toBeDefined();
      expect(env.PYTHONUNBUFFERED).toBe('1');
    });

    it('should include TERM=dumb for non-autonomous mode', () => {
      const env = (runner as any).buildEnvironment();
      expect(env.TERM).toBe('dumb');
    });

    it('should include TERM=xterm-256color for autonomous mode', () => {
      const autonomousRunner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: true,
        workerType: 'codex'
      });

      const env = (autonomousRunner as any).buildEnvironment();
      expect(env.TERM).toBe('xterm-256color');
    });
  });

  describe('Real Command Execution', () => {
    let runner: GenericRunner;

    beforeEach(() => {
      runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'codex'
      });
    });

    // These tests would require the actual codex command to be available
    // They are marked as .skip for now and can be enabled when testing with real codex

    it.skip('should spawn codex process with correct arguments', async () => {
      const { spawn } = await import('child_process');
      const { args } = runner.buildCommand('test prompt', false);
      const cmd = runner.getCommand();

      const proc = spawn(cmd, args, {
        cwd: testDir,
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      expect(proc.pid).toBeDefined();

      // Clean up
      proc.kill();
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    it.skip('should create hello world.js file via codex', async () => {
      const fs = require('fs');

      const prompt = 'Create a file named hello.js that logs "Hello, World!" to the console';
      const { args } = runner.buildCommand(prompt, false);
      const cmd = runner.getCommand();

      return new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd, args, {
          cwd: testDir,
          shell: process.platform === 'win32',
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        proc.on('close', (code) => {
          if (code === 0) {
            const helloPath = join(testDir, 'hello.js');
            if (existsSync(helloPath)) {
              const content = readFileSync(helloPath, 'utf-8');
              expect(content).toContain('Hello, World!');
              resolve();
            } else {
              reject(new Error('hello.js file was not created'));
            }
          } else {
            reject(new Error(`Process exited with code ${code}\nStdout: ${stdout}\nStderr: ${stderr}`));
          }
        });

        proc.on('error', (err) => {
          reject(err);
        });
      });
    });
  });
});

describe('Codex Runner - Shell Mode Behavior', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'codex-shell-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Shell vs Non-Shell Command Building', () => {
    it('should build command that works in both shell and non-shell mode', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'codex'
      });

      const { args, fullCommand } = runner.buildCommand('create a simple script', false);

      // In non-shell mode: codex, exec, "create a simple script"
      // In shell mode: codex exec "create a simple script"
      // The args array should be the same regardless
      expect(args).toEqual(['exec', 'create a simple script']);
      expect(fullCommand).toBe('codex exec create a simple script');
    });

    it('should preserve quotes in commands for shell mode', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'codex'
      });

      const command = 'create script with "quoted text" inside';
      const { args } = runner.buildCommand(command, false);

      // The args should preserve the quotes as part of the string
      expect(args[1]).toBe(command);
      expect(args[1]).toContain('"quoted text"');
    });
  });
});

describe('Codex Runner - Edge Cases', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'codex-edge-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Command Argument Handling', () => {
    it('should handle commands with newlines', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'codex'
      });

      const command = 'create a script\nwith newlines\nin the prompt';
      const { args } = runner.buildCommand(command, false);
      expect(args[1]).toBe(command);
      expect(args[1]).toContain('\n');
    });

    it('should handle commands with tabs', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'codex'
      });

      const command = 'create\tscript\twith\ttabs';
      const { args } = runner.buildCommand(command, false);
      expect(args[1]).toBe(command);
      expect(args[1]).toContain('\t');
    });

    it('should handle very long commands', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'codex'
      });

      const longCommand = 'x'.repeat(10000);
      const { args } = runner.buildCommand(longCommand, false);
      expect(args[1]).toBe(longCommand);
      expect(args[1].length).toBe(10000);
    });

    it('should handle Unicode characters in commands', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'codex'
      });

      const command = 'create script with emoji 🚀 and 日本語';
      const { args } = runner.buildCommand(command, false);
      expect(args[1]).toBe(command);
      expect(args[1]).toContain('🚀');
      expect(args[1]).toContain('日本語');
    });
  });

  describe('Resume Functionality', () => {
    it('should build resume command with --last flag by default', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'codex',
        resumeFrom: 'some-session'
      });

      const { args } = runner.buildCommand('continue', false);
      expect(args).toContain('resume');
      expect(args).toContain('--last');
    });

    it('should append command after resume flags', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'codex',
        resumeFrom: 'some-session'
      });

      const { args } = runner.buildCommand('add more tests', false);
      expect(args).toEqual(['resume', '--last', 'add more tests']);
    });
  });
});