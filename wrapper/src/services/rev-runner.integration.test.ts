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
    revCommand: 'rev',
    commandPollInterval: 100,
    heartbeatInterval: 1000,
    allowlistedCommands: ['npm test', 'cd', 'ls', 'pwd', 'git diff'],
    secretPatterns: [/api[_-]?key[=:]\\s*[\"']?[\\w-]+[\"']?/gi],
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

describe('Rev Runner - Integration Tests', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'rev-test-'));
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
        workerType: 'rev'
      });
    });

    it('should build rev command with prompt as positional argument', () => {
      const { args, fullCommand } = runner.buildCommand('create a hello world script', false);
      expect(args).toContain('create a hello world script');
      expect(fullCommand).toBe('rev create a hello world script');
    });

    it('should build rev command without prompt', () => {
      const { args, fullCommand } = runner.buildCommand(undefined, false);
      expect(args).toEqual([]);
      expect(fullCommand).toBe('rev');
    });

    it('should add --llm-provider when provider is specified', () => {
      const providerRunner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev',
        provider: 'ollama'
      });

      const { args, fullCommand } = providerRunner.buildCommand('test', false);
      expect(args).toContain('--llm-provider');
      expect(args).toContain('ollama');
      expect(fullCommand).toBe('rev --llm-provider ollama test');
    });

    it('should add --model when model is specified', () => {
      const modelRunner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev',
        model: 'glm-4.7:cloud'
      });

      const { args, fullCommand } = modelRunner.buildCommand('test', false);
      expect(args).toContain('--model');
      expect(args).toContain('glm-4.7:cloud');
      expect(fullCommand).toBe('rev --model glm-4.7:cloud test');
    });

    it('should add both provider and model when both are specified', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev',
        provider: 'ollama',
        model: 'glm-4.7:cloud'
      });

      const { args, fullCommand } = runner.buildCommand('test', false);
      expect(args).toContain('--llm-provider');
      expect(args).toContain('ollama');
      expect(args).toContain('--model');
      expect(args).toContain('glm-4.7:cloud');
      expect(args).toContain('test');
      expect(fullCommand).toBe('rev --llm-provider ollama --model glm-4.7:cloud test');
    });

    it('should add --trust-workspace in autonomous mode', () => {
      const autonomousRunner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: true,
        workerType: 'rev'
      });

      const { args, fullCommand } = autonomousRunner.buildCommand('test', true);
      expect(args).toContain('--trust-workspace');
      expect(fullCommand).toBe('rev --trust-workspace test');
    });

    it('should handle long commands with spaces', () => {
      const longCommand = 'create a comprehensive test suite for the authentication module covering edge cases like expired tokens invalid passwords and rate limiting';
      const { args } = runner.buildCommand(longCommand, false);
      expect(args).toContain(longCommand);
      expect(args[args.length - 1]).toBe(longCommand);
    });

    it('should handle commands with special characters', () => {
      const command = 'create script with "quotes" and $symbols';
      const { args } = runner.buildCommand(command, false);
      expect(args).toContain(command);
    });
  });

  describe('shouldUseShell() - Non-Shell Mode', () => {
    let runner: GenericRunner;

    beforeEach(() => {
      runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev'
      });
    });

    it('should return false on Windows (to avoid argument escaping issues)', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });

      try {
        const useShell = (runner as any).shouldUseShell();
        expect(useShell).toBe(false);
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
        workerType: 'rev'
      });
    });

    it('should build environment with REV_API_KEY', () => {
      const env = (runner as any).buildEnvironment();
      expect(env).toBeDefined();
      expect(env.REV_API_KEY).toBe('');
      expect(env.TERM).toBeDefined();
      expect(env.PYTHONUNBUFFERED).toBe('1');
    });

    it('should include OLLAMA_HOST when provider is ollama', () => {
      const providerRunner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev',
        provider: 'ollama'
      });

      const env = (providerRunner as any).buildEnvironment();
      expect(env.OLLAMA_HOST).toBe('http://localhost:11434');
    });

    it('should not include OLLAMA_HOST when provider is not ollama', () => {
      const env = (runner as any).buildEnvironment();
      expect(env.OLLAMA_HOST).toBeUndefined();
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
        workerType: 'rev'
      });

      const env = (autonomousRunner as any).buildEnvironment();
      expect(env.TERM).toBe('xterm-256color');
    });
  });
});

describe('Rev Runner - Model and Provider Selection', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'rev-model-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Provider Options', () => {
    it('should work with ollama provider', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev',
        provider: 'ollama'
      });

      const { args, fullCommand } = runner.buildCommand('test', false);
      expect(args).toContain('--llm-provider');
      expect(args[args.indexOf('--llm-provider') + 1]).toBe('ollama');
      expect(fullCommand).toContain('--llm-provider ollama');
    });

    it('should work with claude provider', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev',
        provider: 'claude'
      });

      const { args } = runner.buildCommand('test', false);
      expect(args).toContain('--llm-provider');
      expect(args[args.indexOf('--llm-provider') + 1]).toBe('claude');
    });

    it('should work with custom provider', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev',
        provider: 'custom-provider'
      });

      const { args } = runner.buildCommand('test', false);
      expect(args).toContain('--llm-provider');
      expect(args[args.indexOf('--llm-provider') + 1]).toBe('custom-provider');
    });
  });

  describe('Model Options', () => {
    it('should honor user-specified model', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev',
        model: 'glm-4.7:cloud'
      });

      const { args, fullCommand } = runner.buildCommand('test', false);
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('glm-4.7:cloud');
      expect(fullCommand).toContain('--model glm-4.7:cloud');
    });

    it('should work with ollama models', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev',
        model: 'codellama:7b'
      });

      const { args } = runner.buildCommand('test', false);
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('codellama:7b');
    });

    it('should work with claude models', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev',
        model: 'claude-3-opus'
      });

      const { args } = runner.buildCommand('test', false);
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('claude-3-opus');
    });

    it('should work with gemini models', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev',
        model: 'gemini-pro'
      });

      const { args } = runner.buildCommand('test', false);
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('gemini-pro');
    });
  });

  describe('Provider + Model Combination', () => {
    it('should use both ollama provider and custom model', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev',
        provider: 'ollama',
        model: 'glm-4.7:cloud'
      });

      const { args, fullCommand } = runner.buildCommand('test', false);
      expect(args).toContain('--llm-provider');
      expect(args).toContain('ollama');
      expect(args).toContain('--model');
      expect(args).toContain('glm-4.7:cloud');
      expect(fullCommand).toBe('rev --llm-provider ollama --model glm-4.7:cloud test');
    });

    it('should use both claude provider and custom model', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev',
        provider: 'claude',
        model: 'claude-3-opus'
      });

      const { args, fullCommand } = runner.buildCommand('test', false);
      expect(args).toContain('--llm-provider');
      expect(args).toContain('claude');
      expect(args).toContain('--model');
      expect(args).toContain('claude-3-opus');
      expect(fullCommand).toBe('rev --llm-provider claude --model claude-3-opus test');
    });
  });
});

describe('Rev Runner - Edge Cases', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'rev-edge-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Command Argument Handling', () => {
    let runner: GenericRunner;

    beforeEach(() => {
      runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev'
      });
    });

    it('should handle commands with newlines', () => {
      const command = 'create a script\nwith newlines\nin the prompt';
      const { args } = runner.buildCommand(command, false);
      expect(args).toContain(command);
      expect(args[args.length - 1]).toContain('\n');
    });

    it('should handle commands with tabs', () => {
      const command = 'create\tscript\twith\ttabs';
      const { args } = runner.buildCommand(command, false);
      expect(args).toContain(command);
      expect(args[args.length - 1]).toContain('\t');
    });

    it('should handle very long commands', () => {
      const longCommand = 'x'.repeat(10000);
      const { args } = runner.buildCommand(longCommand, false);
      expect(args).toContain(longCommand);
      expect(args[args.length - 1].length).toBe(10000);
    });

    it('should handle Unicode characters in commands', () => {
      const command = 'create script with emoji 🚀 and 日本語';
      const { args } = runner.buildCommand(command, false);
      expect(args).toContain(command);
      expect(args[args.length - 1]).toContain('🚀');
      expect(args[args.length - 1]).toContain('日本語');
    });

    it('should handle commands with multiple spaces', () => {
      const command = 'create   script   with   multiple   spaces';
      const { args } = runner.buildCommand(command, false);
      expect(args).toContain(command);
      expect(args[args.length - 1]).toBe(command);
    });
  });

  describe('Autonomous Mode', () => {
    it('should add --trust-workspace with provider and model in autonomous mode', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: true,
        workerType: 'rev',
        provider: 'ollama',
        model: 'glm-4.7:cloud'
      });

      const { args, fullCommand } = runner.buildCommand('test', true);
      expect(args).toContain('--llm-provider');
      expect(args).toContain('ollama');
      expect(args).toContain('--model');
      expect(args).toContain('glm-4.7:cloud');
      expect(args).toContain('--trust-workspace');
      expect(fullCommand).toBe('rev --llm-provider ollama --model glm-4.7:cloud --trust-workspace test');
    });

    it('should add --trust-workspace without provider in autonomous mode', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: true,
        workerType: 'rev',
        model: 'glm-4.7:cloud'
      });

      const { args } = runner.buildCommand('test', true);
      expect(args).toContain('--model');
      expect(args).toContain('glm-4.7:cloud');
      expect(args).toContain('--trust-workspace');
      expect(args).not.toContain('--llm-provider');
    });

    it('should not add --trust-workspace in non-autonomous mode', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev',
        provider: 'ollama',
        model: 'glm-4.7:cloud'
      });

      const { args } = runner.buildCommand('test', false);
      expect(args).toContain('--llm-provider');
      expect(args).toContain('--model');
      expect(args).toContain('glm-4.7:cloud');
      expect(args).not.toContain('--trust-workspace');
    });
  });

  describe('Empty and Whitespace Commands', () => {
    let runner: GenericRunner;

    beforeEach(() => {
      runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev'
      });
    });

    it('should not add empty string to args', () => {
      const { args } = runner.buildCommand('', false);
      expect(args).toEqual([]);
      expect(args).not.toContain('');
    });

    it('should not add whitespace-only string to args', () => {
      const { args } = runner.buildCommand('   ', false);
      expect(args).not.toContain('   ');
      expect(args.every(arg => arg.trim().length > 0)).toBe(true);
    });
  });
});