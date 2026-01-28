import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config
vi.mock('../config.js', () => ({
  config: {
    projectRoot: '/test/project',
    runsDir: '/test/project/.data/runs',
    claudeCommand: 'claude',
    ollamaCommand: 'ollama',
    ollamaModel: 'codellama:7b',
    codexCommand: 'codex-cli',
    geminiCommand: 'gemini-cli',
    geminiModel: 'gemini-pro',
    revCommand: 'rev',
    commandPollInterval: 2000,
    heartbeatInterval: 30000,
    allowlistedCommands: ['npm test', 'cd', 'ls', 'pwd'],
    secretPatterns: [/api[_-]?key[=:]\s*["']?[\w-]+["']?/gi],
    getWorkerCommand: (workerType: string) => {
      const commands: Record<string, string> = {
        claude: 'claude',
        ollama: 'ollama',
        'ollama-launch': 'ollama',
        codex: 'codex-cli',
        gemini: 'gemini-cli',
        rev: 'rev'
      };
      return commands[workerType] || workerType;
    },
    getDefaultModel: (workerType: string) => {
      const models: Record<string, string | undefined> = {
        ollama: 'codellama:7b',
        'ollama-launch': 'claude',
        gemini: 'gemini-pro'
      };
      return models[workerType];
    }
  }
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  createWriteStream: vi.fn(() => ({
    write: vi.fn(),
    end: vi.fn()
  }))
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn()
}));

// Mock gateway client
vi.mock('./gateway-client.js', () => ({
  sendEvent: vi.fn().mockResolvedValue(undefined),
  uploadArtifact: vi.fn().mockResolvedValue({ artifactId: 'test' }),
  pollCommands: vi.fn().mockResolvedValue([]),
  ackCommand: vi.fn().mockResolvedValue(undefined),
  updateRunState: vi.fn().mockResolvedValue(undefined)
}));

import { config } from '../config.js';
import { GenericRunner, createGenericRunner } from './generic-runner.js';
import type { WorkerType } from './worker-registry.js';

describe('GenericRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Runner Creation', () => {
    it('should create runner for Ollama', () => {
      const runner = new GenericRunner({
        runId: 'test-run-1',
        capabilityToken: 'token-abc',
        workingDir: '/test/project',
        autonomous: false,
        workerType: 'ollama',
        model: 'codellama:7b'
      });

      expect(runner.getWorkerType()).toBe('ollama');
    });

    it('should create runner for Ollama Launch', () => {
      const runner = new GenericRunner({
        runId: 'test-run-2',
        capabilityToken: 'token-xyz',
        workingDir: '/test/project',
        autonomous: false,
        workerType: 'ollama-launch',
        model: 'claude'
      });

      expect(runner.getWorkerType()).toBe('ollama-launch');
    });

    it('should create runner for Codex', () => {
      const runner = createGenericRunner('codex', {
        runId: 'test-run-3',
        capabilityToken: 'token-codex',
        workingDir: '/test/project',
        autonomous: false
      });

      expect(runner.getWorkerType()).toBe('codex');
    });

    it('should create runner for Gemini', () => {
      const runner = createGenericRunner('gemini', {
        runId: 'test-run-4',
        capabilityToken: 'token-gemini',
        workingDir: '/test/project',
        autonomous: false,
        model: 'gemini-pro'
      });

      expect(runner.getWorkerType()).toBe('gemini');
    });

    it('should create runner for Rev', () => {
      const runner = createGenericRunner('rev', {
        runId: 'test-run-5',
        capabilityToken: 'token-rev',
        workingDir: '/test/project',
        autonomous: false
      });

      expect(runner.getWorkerType()).toBe('rev');
    });
  });

  describe('Command Building', () => {
    it('should build Ollama run command', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'token',
        workingDir: '/test/project',
        autonomous: false,
        workerType: 'ollama',
        model: 'codellama:13b'
      });

      const result = runner.buildCommand('explain this code', false);
      expect(result.args).toEqual(['run', 'codellama:13b', 'explain this code']);
      expect(result.fullCommand).toBe('ollama run codellama:13b explain this code');
    });

    it('should build Ollama run command with default model', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'token',
        workingDir: '/test/project',
        autonomous: false,
        workerType: 'ollama'
        // no model specified
      });

      const result = runner.buildCommand('test prompt', false);
      expect(result.args).toEqual(['run', 'codellama:7b', 'test prompt']);
      expect(result.fullCommand).toContain('codellama:7b');
    });

    it('should build Ollama launch command', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'token',
        workingDir: '/test/project',
        autonomous: true,
        workerType: 'ollama-launch',
        model: 'claude'
      });

      const result = runner.buildCommand('fix bug', true);
      // The prompt is included as an argument when provided
      expect(result.args).toEqual(['launch', 'claude', 'fix bug', '--config']);
      expect(result.fullCommand).toBe('ollama launch claude fix bug --config');
    });

    it('should build Ollama launch command without config flag', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'token',
        workingDir: '/test/project',
        autonomous: false,
        workerType: 'ollama-launch',
        model: 'claude'
      });

      const result = runner.buildCommand('fix bug', false);
      // The prompt is included as an argument when provided
      expect(result.args).toEqual(['launch', 'claude', 'fix bug']);
      expect(result.fullCommand).toBe('ollama launch claude fix bug');
    });

    it('should build Codex command', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'token',
        workingDir: '/test/project',
        autonomous: false,
        workerType: 'codex'
      });

      const result = runner.buildCommand('write tests', false);
      expect(result.args).toEqual(['write tests']);
      expect(result.fullCommand).toBe('codex-cli write tests');
    });

    it('should build Codex command without prompt', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'token',
        workingDir: '/test/project',
        autonomous: false,
        workerType: 'codex'
      });

      const result = runner.buildCommand(undefined, false);
      expect(result.args).toEqual([]);
      expect(result.fullCommand).toBe('codex-cli');
    });

    it('should build Gemini command with model', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'token',
        workingDir: '/test/project',
        autonomous: false,
        workerType: 'gemini',
        model: 'gemini-1.5-pro'
      });

      const result = runner.buildCommand('refactor', false);
      expect(result.args).toEqual(['--model', 'gemini-1.5-pro', 'refactor']);
      expect(result.fullCommand).toBe('gemini-cli --model gemini-1.5-pro refactor');
    });

    it('should build Rev command', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'token',
        workingDir: '/test/project',
        autonomous: false,
        workerType: 'rev'
      });

      const result = runner.buildCommand('analyze', false);
      expect(result.args).toEqual(['analyze']);
      expect(result.fullCommand).toBe('rev analyze');
    });

    it('should handle empty command for autonomous mode', () => {
      const runner = new GenericRunner({
        runId: 'test-run',
        capabilityToken: 'token',
        workingDir: '/test/project',
        autonomous: true,
        workerType: 'ollama'
      });

      const result = runner.buildCommand(undefined, true);
      expect(result.args).toEqual(['run', 'codellama:7b']);
      expect(result.fullCommand).toContain('ollama run codellama:7b');
    });
  });

  describe('Get Command', () => {
    it('should return correct command for each worker type', () => {
      const ollamaRunner = new GenericRunner({
        runId: 'test',
        capabilityToken: 'token',
        workerType: 'ollama'
      });
      expect(ollamaRunner.getCommand()).toBe('ollama');

      const codexRunner = new GenericRunner({
        runId: 'test',
        capabilityToken: 'token',
        workerType: 'codex'
      });
      expect(codexRunner.getCommand()).toBe('codex-cli');

      const geminiRunner = new GenericRunner({
        runId: 'test',
        capabilityToken: 'token',
        workerType: 'gemini'
      });
      expect(geminiRunner.getCommand()).toBe('gemini-cli');
    });
  });

  describe('Environment Variables', () => {
    it('should build Ollama environment with OLLAMA_HOST', () => {
      const runner = new GenericRunner({
        runId: 'test',
        capabilityToken: 'token',
        workerType: 'ollama',
        model: 'codellama:7b'
      });

      const env = runner['buildEnvironment']();
      expect(env).toBeDefined();
      expect(env.OLLAMA_HOST).toBeDefined();
      expect(env.OLLAMA_HOST).toBe('http://localhost:11434');
    });

    it('should build Codex environment with API keys', () => {
      const runner = new GenericRunner({
        runId: 'test',
        capabilityToken: 'token',
        workerType: 'codex'
      });

      const env = runner['buildEnvironment']();
      expect(env).toBeDefined();
      expect(env.OPENAI_API_KEY).toBe('');
      expect(env.CODEX_API_KEY).toBe('');
    });

    it('should build Gemini environment with API keys', () => {
      const runner = new GenericRunner({
        runId: 'test',
        capabilityToken: 'token',
        workerType: 'gemini'
      });

      const env = runner['buildEnvironment']();
      expect(env).toBeDefined();
      expect(env.GOOGLE_API_KEY).toBe('');
      expect(env.GEMINI_API_KEY).toBe('');
    });

    it('should build Rev environment with API key', () => {
      const runner = new GenericRunner({
        runId: 'test',
        capabilityToken: 'token',
        workerType: 'rev'
      });

      const env = runner['buildEnvironment']();
      expect(env).toBeDefined();
      expect(env.REV_API_KEY).toBe('');
    });
  });

  describe('Custom Command Builder', () => {
    it('should use custom buildCommandFn if provided', () => {
      const customBuilder = vi.fn(() => ({
        args: ['custom', 'args'],
        fullCommand: 'custom command'
      }));

      const runner = new GenericRunner({
        runId: 'test',
        capabilityToken: 'token',
        workingDir: '/test',
        workerType: 'ollama',
        buildCommandFn: customBuilder
      });

      const result = runner.buildCommand('test', false);
      expect(customBuilder).toHaveBeenCalledWith('test', false, undefined);
      expect(result.fullCommand).toBe('custom command');
    });
  });
});

describe('GenericRunner Edge Cases', () => {
  it('should handle empty model for workers that support it', () => {
    const runner = new GenericRunner({
      runId: 'test',
      capabilityToken: 'token',
      workerType: 'ollama'
      // model not specified
    });

    const result = runner.buildCommand('test', false);
    expect(result.args[1]).toBe('codellama:7b'); // Uses default
  });

  it('should handle long commands', () => {
    const runner = new GenericRunner({
      runId: 'test',
      capabilityToken: 'token',
      workerType: 'codex'
    });

    const longCmd = 'write a comprehensive unit test suite for the authentication module including edge cases like expired tokens, invalid passwords, and rate limiting';
    const result = runner.buildCommand(longCmd, false);
    expect(result.args).toEqual([longCmd]);
  });

  it('should handle commands with special characters', () => {
    const runner = new GenericRunner({
      runId: 'test',
      capabilityToken: 'token',
      workerType: 'ollama',
      model: 'custom-model'
    });

    const result = runner.buildCommand('test "quoted" command', false);
    expect(result.args).toEqual(['run', 'custom-model', 'test "quoted" command']);
  });
});