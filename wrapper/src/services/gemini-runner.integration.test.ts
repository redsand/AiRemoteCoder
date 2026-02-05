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
    geminiCommand: 'gemini',
    geminiModel: 'gemini-pro',
    geminiOutputFormat: 'text',
    geminiPromptFlag: '--prompt',
    geminiApprovalMode: 'yolo',
    geminiArgs: [],
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

describe('Gemini Runner - Integration Tests', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'gemini-test-'));
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
        workerType: 'gemini'
      });
    });

    it('should build gemini command with output format', () => {
      const { args, fullCommand } = runner.buildCommand('create a hello world script', false);
      expect(args).toContain('--output-format');
      expect(args).toContain('text');
      expect(fullCommand).toContain('--output-format text');
    });

    it('should build gemini command with model', () => {
      const { args, fullCommand } = runner.buildCommand('create a hello world script', false);
      expect(args).toContain('--model');
      expect(args).toContain('gemini-pro');
      expect(fullCommand).toContain('--model gemini-pro');
    });

    it('should build gemini command with prompt flag and prompt', () => {
      const { args, fullCommand } = runner.buildCommand('create a hello world script', false);
      expect(args).toContain('--prompt');
      expect(args).toContain('create a hello world script');
      // fullCommand doesn't include quotes around the prompt since args are separate elements
      expect(fullCommand).toContain('--prompt create a hello world script');
    });

    it('should build gemini command with approval mode', () => {
      const { args, fullCommand } = runner.buildCommand('create a hello world script', false);
      expect(args).toContain('--approval-mode');
      expect(args).toContain('yolo');
      expect(fullCommand).toContain('--approval-mode yolo');
    });

    it('should use custom model when specified', () => {
      const customModelRunner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'gemini',
        model: 'gemini-1.5-pro'
      });

      const { args } = customModelRunner.buildCommand('test', false);
      const modelIndex = args.indexOf('--model');
      expect(args[modelIndex + 1]).toBe('gemini-1.5-pro');
    });

    it('should build command without prompt when empty', () => {
      const { args } = runner.buildCommand('', false);
      expect(args).not.toContain('');
      expect(args.every(arg => arg.trim().length > 0)).toBe(true);
    });

    it('should handle long commands with spaces', () => {
      const longCommand = 'create a comprehensive test suite for the authentication module covering edge cases like expired tokens invalid passwords and rate limiting';
      const { args } = runner.buildCommand(longCommand, false);
      expect(args).toContain('--prompt');
      expect(args).toContain(longCommand);
    });

    it('should handle commands with special characters', () => {
      const command = 'create script with "quotes" and $symbols';
      const { args } = runner.buildCommand(command, false);
      expect(args).toContain('--prompt');
      expect(args).toContain(command);
    });
  });

  describe('Command Argument Order', () => {
    let runner: GenericRunner;

    beforeEach(() => {
      runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'gemini'
      });
    });

    it('should have flags in correct order', () => {
      const { args } = runner.buildCommand('test prompt', false);

      // Expected order: --output-format text --model gemini-pro --prompt "test prompt" --approval-mode yolo
      const outputFormatIndex = args.indexOf('--output-format');
      const modelIndex = args.indexOf('--model');
      const promptIndex = args.indexOf('--prompt');
      const approvalIndex = args.indexOf('--approval-mode');

      expect(outputFormatIndex).toBeGreaterThanOrEqual(0);
      expect(modelIndex).toBeGreaterThanOrEqual(0);
      expect(promptIndex).toBeGreaterThanOrEqual(0);
      expect(approvalIndex).toBeGreaterThanOrEqual(0);

      // Output format should come before model
      expect(outputFormatIndex).toBeLessThan(modelIndex);
      // Model should come before prompt
      expect(modelIndex).toBeLessThan(promptIndex);
      // Prompt should come before approval mode
      expect(promptIndex).toBeLessThan(approvalIndex);
    });

    it('should build full command with proper spacing', () => {
      const { fullCommand } = runner.buildCommand('test prompt', false);
      expect(fullCommand).toBe('gemini --output-format text --model gemini-pro --prompt test prompt --approval-mode yolo');
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
        workerType: 'gemini'
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
        workerType: 'gemini'
      });
    });

    it('should build environment with API keys', () => {
      const env = (runner as any).buildEnvironment();
      expect(env).toBeDefined();
      expect(env.GOOGLE_API_KEY).toBe('');
      expect(env.GEMINI_API_KEY).toBe('');
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
        workerType: 'gemini'
      });

      const env = (autonomousRunner as any).buildEnvironment();
      expect(env.TERM).toBe('xterm-256color');
    });
  });

  describe('Model Selection', () => {
    it('should use default model from config when no model specified', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'gemini'
      });

      const { args } = runner.buildCommand('test', false);
      const modelIndex = args.indexOf('--model');
      expect(args[modelIndex + 1]).toBe('gemini-pro');
    });

    it('should use user-specified model', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'gemini',
        model: 'gemini-1.5-flash'
      });

      const { args } = runner.buildCommand('test', false);
      const modelIndex = args.indexOf('--model');
      expect(args[modelIndex + 1]).toBe('gemini-1.5-flash');
    });

    it('should handle custom model name', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'gemini',
        model: 'custom-model-name'
      });

      const { args, fullCommand } = runner.buildCommand('test', false);
      expect(args).toContain('--model');
      expect(args).toContain('custom-model-name');
      expect(fullCommand).toContain('--model custom-model-name');
    });
  });
});

describe('Gemini Runner - Edge Cases', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'gemini-edge-test-'));
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
        workerType: 'gemini'
      });

      const command = 'create a script\nwith newlines\nin the prompt';
      const { args } = runner.buildCommand(command, false);
      expect(args).toContain('--prompt');
      expect(args).toContain(command);
      expect(args[args.indexOf('--prompt') + 1]).toContain('\n');
    });

    it('should handle commands with tabs', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'gemini'
      });

      const command = 'create\tscript\twith\ttabs';
      const { args } = runner.buildCommand(command, false);
      expect(args).toContain('--prompt');
      expect(args).toContain(command);
      expect(args[args.indexOf('--prompt') + 1]).toContain('\t');
    });

    it('should handle very long commands', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'gemini'
      });

      const longCommand = 'x'.repeat(10000);
      const { args } = runner.buildCommand(longCommand, false);
      expect(args).toContain('--prompt');
      expect(args).toContain(longCommand);
      expect(args[args.indexOf('--prompt') + 1].length).toBe(10000);
    });

    it('should handle Unicode characters in commands', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'gemini'
      });

      const command = 'create script with emoji 🚀 and 日本語';
      const { args } = runner.buildCommand(command, false);
      expect(args).toContain('--prompt');
      expect(args).toContain(command);
      expect(args[args.indexOf('--prompt') + 1]).toContain('🚀');
      expect(args[args.indexOf('--prompt') + 1]).toContain('日本語');
    });

    it('should handle commands with multiple spaces', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'gemini'
      });

      const command = 'create   script   with   multiple   spaces';
      const { args } = runner.buildCommand(command, false);
      expect(args).toContain('--prompt');
      expect(args).toContain(command);
      expect(args[args.indexOf('--prompt') + 1]).toBe(command);
    });
  });

  describe('Empty and Whitespace Commands', () => {
    it('should not add empty string to args', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'gemini'
      });

      const { args } = runner.buildCommand('', false);
      expect(args).not.toContain('');
      expect(args.every(arg => arg.length > 0)).toBe(true);
      expect(args).not.toContain('--prompt');
    });

    it('should not add whitespace-only string to args', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'gemini'
      });

      const { args } = runner.buildCommand('   ', false);
      expect(args).not.toContain('   ');
      expect(args.every(arg => arg.trim().length > 0)).toBe(true);
    });
  });
});

describe('Gemini Runner - Different Models', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'gemini-model-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should work with gemini-pro', () => {
    const runner = new GenericRunner({
      runId: 'test-run',
      capabilityToken: 'test-token',
      workingDir: testDir,
      autonomous: false,
      workerType: 'gemini',
      model: 'gemini-pro'
    });

    const { args, fullCommand } = runner.buildCommand('test', false);
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-pro');
    expect(fullCommand).toContain('--model gemini-pro');
  });

  it('should work with gemini-1.5-pro', () => {
    const runner = new GenericRunner({
      runId: 'test-run',
      capabilityToken: 'test-token',
      workingDir: testDir,
      autonomous: false,
      workerType: 'gemini',
      model: 'gemini-1.5-pro'
    });

    const { args, fullCommand } = runner.buildCommand('test', false);
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-1.5-pro');
    expect(fullCommand).toContain('--model gemini-1.5-pro');
  });

  it('should work with gemini-1.5-flash', () => {
    const runner = new GenericRunner({
      runId: 'test-run',
      capabilityToken: 'test-token',
      workingDir: testDir,
      autonomous: false,
      workerType: 'gemini',
      model: 'gemini-1.5-flash'
    });

    const { args, fullCommand } = runner.buildCommand('test', false);
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-1.5-flash');
    expect(fullCommand).toContain('--model gemini-1.5-flash');
  });

  it('should work with gemini-pro-vision', () => {
    const runner = new GenericRunner({
      runId: 'test-run',
      capabilityToken: 'test-token',
      workingDir: testDir,
      autonomous: false,
      workerType: 'gemini',
      model: 'gemini-pro-vision'
    });

    const { args, fullCommand } = runner.buildCommand('test', false);
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-pro-vision');
    expect(fullCommand).toContain('--model gemini-pro-vision');
  });
});