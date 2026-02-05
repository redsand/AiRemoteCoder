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
    gatewayUrl: 'https://localhost:3100',
    hmacSecret: 'test-secret-32-characters-long',
    claudeCommand: 'claude',
    commandPollInterval: 100,
    heartbeatInterval: 1000,
    allowlistedCommands: ['npm test', 'cd', 'ls', 'pwd', 'git diff'],
    secretPatterns: [/api[_-]?key[=:]\\s*[\"']?[\\w-]+[\"']?/gi],
    allowSelfSignedCerts: false,
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

import { ClaudeRunner } from './claude-runner.js';
import { BaseRunner, type RunnerOptions } from './base-runner.js';

describe('Claude Runner - Integration Tests', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'claude-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('buildCommand() - Real Behavior', () => {
    let runner: ClaudeRunner;

    beforeEach(() => {
      runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false
      });
    });

    it('should build claude command with permission mode', () => {
      const { args, fullCommand } = runner.buildCommand();
      expect(args).toContain('--permission-mode');
      expect(args).toContain('acceptEdits');
      expect(fullCommand).toContain('--permission-mode acceptEdits');
    });

    it('should build claude command with session ID', () => {
      const { args } = runner.buildCommand();
      expect(args).toContain('--session-id');
      const sessionIndex = args.indexOf('--session-id');
      expect(args[sessionIndex + 1]).toBeDefined();
      expect(args[sessionIndex + 1].length).toBeGreaterThan(0);
    });

    it('should NOT include --print flag (interactive mode)', () => {
      const { args } = runner.buildCommand();
      expect(args).not.toContain('--print');
    });

    it('should add model when specified', () => {
      const modelRunner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        model: 'claude-3-opus'
      });

      const { args, fullCommand } = modelRunner.buildCommand();
      expect(args).toContain('--model');
      expect(args).toContain('claude-3-opus');
      expect(fullCommand).toContain('--model claude-3-opus');
    });

    it('should not add model when not specified', () => {
      const { args } = runner.buildCommand();
      expect(args).not.toContain('--model');
    });

    it('should generate unique session ID for each runner', () => {
      const runner1 = new ClaudeRunner({
        runId: 'test-run-1',
        capabilityToken: 'token-1',
        workingDir: testDir,
        autonomous: false
      });

      const runner2 = new ClaudeRunner({
        runId: 'test-run-2',
        capabilityToken: 'token-2',
        workingDir: testDir,
        autonomous: false
      });

      const { args: args1 } = runner1.buildCommand();
      const { args: args2 } = runner2.buildCommand();

      const sessionId1 = args1[args1.indexOf('--session-id') + 1];
      const sessionId2 = args2[args2.indexOf('--session-id') + 1];

      expect(sessionId1).toBeDefined();
      expect(sessionId2).toBeDefined();
      expect(sessionId1).not.toBe(sessionId2);
    });
  });

  describe('shouldUseShell() - Non-Shell Mode', () => {
    let runner: ClaudeRunner;

    beforeEach(() => {
      runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false
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
    let runner: ClaudeRunner;

    beforeEach(() => {
      runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false
      });
    });

    it('should build environment with gateway auth vars', () => {
      const env = (runner as any).buildEnvironment();
      expect(env).toBeDefined();
      expect(env.AI_GATEWAY_URL).toBeDefined();
      expect(env.AI_HMAC_SECRET).toBeDefined();
      expect(env.AI_RUN_ID).toBe('test-run');
      expect(env.AI_CAPABILITY_TOKEN).toBe('test-token');
      expect(env.AI_ALLOW_SELF_SIGNED).toBe('false');
    });

    it('should include TERM=dumb for non-autonomous mode', () => {
      const env = (runner as any).buildEnvironment();
      expect(env.TERM).toBe('dumb');
    });

    it('should include TERM=xterm-256color for autonomous mode', () => {
      const autonomousRunner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: true
      });

      const env = (autonomousRunner as any).buildEnvironment();
      expect(env.TERM).toBe('xterm-256color');
    });
  });

  describe('getWorkerType() and getCommand()', () => {
    it('should return correct worker type', () => {
      const runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false
      });

      expect(runner.getWorkerType()).toBe('claude');
    });

    it('should return correct command', () => {
      const runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false
      });

      expect(runner.getCommand()).toBe('claude');
    });
  });

  describe('Session ID', () => {
    it('should have a unique session ID after construction', () => {
      const runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false
      });

      const sessionId = (runner as any).sessionId;
      expect(sessionId).toBeDefined();
      expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should generate different session IDs for different runners', () => {
      const runner1 = new ClaudeRunner({
        runId: 'test-run-1',
        capabilityToken: 'token-1',
        workingDir: testDir,
        autonomous: false
      });

      const runner2 = new ClaudeRunner({
        runId: 'test-run-2',
        capabilityToken: 'token-2',
        workingDir: testDir,
        autonomous: false
      });

      const sessionId1 = (runner1 as any).sessionId;
      const sessionId2 = (runner2 as any).sessionId;

      expect(sessionId1).not.toBe(sessionId2);
    });
  });

  describe('Model Selection', () => {
    it('should use user-specified model', () => {
      const runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        model: 'claude-3-opus'
      });

      const { args } = runner.buildCommand();
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('claude-3-opus');
    });

    it('should not add model flag when not specified', () => {
      const runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false
      });

      const { args } = runner.buildCommand();
      expect(args).not.toContain('--model');
    });

    it('should work with different Claude models', () => {
      const models = ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku', 'claude-3.5-sonnet'];

      models.forEach(model => {
        const runner = new ClaudeRunner({
          runId: 'test-run',
          capabilityToken: 'test-token',
          workingDir: testDir,
          autonomous: false,
          model
        });

        const { args } = runner.buildCommand();
        expect(args).toContain('--model');
        expect(args[args.indexOf('--model') + 1]).toBe(model);
      });
    });
  });
});

describe('Claude Runner - Interactive Mode', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'claude-interactive-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Command Handling', () => {
    it('should handle commands sent via stdin (not as args)', () => {
      const runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false
      });

      // In interactive mode, the command is sent via stdin, not as an argument
      const { args } = runner.buildCommand();
      expect(args).not.toContain('any command');
      expect(args).not.toContain('--print'); // No --print in interactive mode
    });

    it('should keep process alive after initial command (interactive mode)', () => {
      const runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false
      });

      // The interactive mode maintains a persistent process
      // Commands are sent via stdin after the process starts
      const { args } = runner.buildCommand();
      expect(args).toContain('--permission-mode');
      expect(args).toContain('acceptEdits');
      expect(args).toContain('--session-id');
      // No --print flag means interactive mode
      expect(args).not.toContain('--print');
    });
  });

  describe('Stdin Configuration', () => {
    it('should configure stdin for interactive mode', () => {
      const runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false
      });

      // In interactive mode, stdin is piped for sending commands
      // This is handled by the spawn options, not buildCommand
      expect((runner as any).sessionId).toBeDefined();
    });
  });
});

describe('Claude Runner - Edge Cases', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'claude-edge-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Autonomous vs Non-Autonomous Mode', () => {
    it('should use xterm-256color TERM for autonomous mode', () => {
      const runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: true
      });

      const env = (runner as any).buildEnvironment();
      expect(env.TERM).toBe('xterm-256color');
    });

    it('should use dumb TERM for non-autonomous mode', () => {
      const runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false
      });

      const env = (runner as any).buildEnvironment();
      expect(env.TERM).toBe('dumb');
    });
  });

  describe('Model Selection Edge Cases', () => {
    it('should handle model names with special characters', () => {
      const runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        model: 'custom-model-123'
      });

      const { args } = runner.buildCommand();
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('custom-model-123');
    });

    it('should handle model names with colons and dots', () => {
      const runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        model: 'anthropic:claude-3-opus:20240529'
      });

      const { args } = runner.buildCommand();
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('anthropic:claude-3-opus:20240529');
    });
  });

  describe('Session ID Format', () => {
    it('should generate valid UUID v4 format session IDs', () => {
      const runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false
      });

      const sessionId = (runner as any).sessionId;
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(sessionId).toMatch(uuidRegex);
    });

    it('should include session ID in buildCommand args', () => {
      const runner = new ClaudeRunner({
        runId: 'test-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false
      });

      const { args } = runner.buildCommand();
      const sessionId = (runner as any).sessionId;
      expect(args).toContain('--session-id');
      expect(args).toContain(sessionId);
    });
  });
});