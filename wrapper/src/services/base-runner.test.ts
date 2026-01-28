import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config
vi.mock('../config.js', () => ({
  config: {
    projectRoot: '/test/project',
    runsDir: '/test/project/.data/runs',
    claudeCommand: 'claude',
    commandPollInterval: 2000,
    heartbeatInterval: 30000,
    allowlistedCommands: ['npm test', 'cd', 'ls', 'pwd', 'git diff'],
    secretPatterns: [/api[_-]?key[=:]\s*["']?[\w-]+["']?/gi]
  }
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
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

import { redactSecrets } from '../utils/crypto.js';
import { BaseRunner, type RunnerOptions } from './base-runner.js';

// Test implementation of BaseRunner
class TestRunner extends BaseRunner {
  getWorkerType(): string {
    return 'test-worker';
  }

  getCommand(): string {
    return 'test-cmd';
  }

  buildCommand(command?: string, autonomous?: boolean): { args: string[]; fullCommand: string } {
    return {
      args: command ? [command] : [],
      fullCommand: command || 'test-cmd'
    };
  }

  // Expose protected methods for testing
  public exposeDetectBlockingPrompt(text: string): boolean {
    return (this as any).detectBlockingPrompt(text);
  }

  public exposeChangeDirectory(path: string): { success: boolean; message: string; newDir?: string } {
    return (this as any).changeDirectory(path);
  }

  public exposeGetWorkingDirectory(): string {
    return (this as any).getWorkingDirectory();
  }
}

describe('BaseRunner - Prompt Detection', () => {
  let runner: TestRunner;

  beforeEach(() => {
    runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'test-token',
      workingDir: '/test/project',
      autonomous: false
    });
  });

  describe('detectBlockingPrompt', () => {
    it('should detect "Would you like me to" prompts', () => {
      const prompts = [
        'Would you like me to fix this bug?',
        'Would you like me to create a new function?',
        'Would you like me to proceed?'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt)).toBe(true);
      }
    });

    it('should detect "Should I" prompts', () => {
      const prompts = [
        'Should I delete this file?',
        'Should I continue with the refactoring?',
        'Should I run the tests?'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt)).toBe(true);
      }
    });

    it('should detect "Do you want me to" prompts', () => {
      const prompts = [
        'Do you want me to commit these changes?',
        'Do you want me to run the build?'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt)).toBe(true);
      }
    });

    it('should detect [Y/n] prompts', () => {
      const prompts = [
        'Proceed? [Y/n]',
        'Continue with this action? [Y/n]',
        'Are you sure? [Y/n]'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt)).toBe(true);
      }
    });

    it('should detect (y/N) prompts', () => {
      const prompts = [
        'Continue? (y/N)',
        'Delete file? (y/N)'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt)).toBe(true);
      }
    });

    it('should detect question mark at end of line', () => {
      const prompts = [
        'Are you sure you want to continue?',
        'Should I proceed with this change?\n',
        'Do you want to proceed?'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt)).toBe(true);
      }
    });

    it('should detect "Continue?" prompts', () => {
      const prompts = [
        'Continue?',
        'Press Enter to continue?',
        'Continue with operation?'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt)).toBe(true);
      }
    });

    it('should detect "Press Enter to continue" prompts', () => {
      const prompts = [
        'Press Enter to continue',
        'Press ENTER to continue',
        'press enter to continue'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt)).toBe(true);
      }
    });

    it('should detect "Type \'y\' to continue" prompts', () => {
      const prompts = [
        "Type 'y' to continue",
        "Type 'y' to proceed",
        'Type "y" to continue'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt)).toBe(true);
      }
    });

    it('should detect "Are you sure" prompts', () => {
      const prompts = [
        'Are you sure?',
        'Are you sure you want to delete this file?',
        'Are you certain?'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt)).toBe(true);
      }
    });

    it('should detect confirmation prompts', () => {
      const prompts = [
        'Confirm this change?',
        'Allow this operation?',
        'Proceed with this action?',
        'Would you like to proceed?'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt)).toBe(true);
      }
    });

    it('should NOT detect regular output without prompts', () => {
      const nonPrompts = [
        'I am analyzing the code...',
        'Here are the changes I made:',
        'Running tests...',
        'Build succeeded!',
        'Starting the application...',
        'Checking dependencies...'
      ];

      for (const text of nonPrompts) {
        expect(runner.exposeDetectBlockingPrompt(text)).toBe(false);
      }
    });

    it('should handle edge cases', () => {
      expect(runner.exposeDetectBlockingPrompt('')).toBe(false);
      expect(runner.exposeDetectBlockingPrompt('   ')).toBe(false);
      expect(runner.exposeDetectBlockingPrompt('Output without question')).toBe(false);
    });
  });

  describe('Prompt Detection Integration', () => {
    it('should detect prompt in Claude-style output', () => {
      const claudeOutput = `
I've analyzed the code and found a potential issue in the authentication module.

Would you like me to fix this vulnerability? [Y/n]
`;
      expect(runner.exposeDetectBlockingPrompt(claudeOutput)).toBe(true);
    });

    it('should detect prompt in multi-line output', () => {
      const output = `
Making changes to 3 files...
- src/auth.ts
- src/user.ts
- src/session.ts

Are you sure you want to proceed?
`;
      expect(runner.exposeDetectBlockingPrompt(output)).toBe(true);
    });
  });
});

describe('BaseRunner - Sandbox Directory Navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock existsSync to return true for existing directories
    vi.mocked(require('fs').existsSync).mockImplementation((path: string) => {
      const validPaths = [
        '/test/project',
        '/test/project/src',
        '/test/project/src/components',
        '/test/project/tests',
        '/test/project/docs'
      ];
      return validPaths.some(p => path.startsWith(p));
    });

    // Mock statSync to return directory info
    vi.mocked(require('fs').statSync).mockImplementation((path: string) => ({
      isDirectory: () => true,
      isFile: () => false
    }));
  });

  it('should initialize with sandbox root', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    expect((runner as any).sandboxRoot).toBe('/test/project');
  });

  it('should change to subdirectory', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    const result = runner.exposeChangeDirectory('src');
    expect(result.success).toBe(true);
    expect(result.newDir).toBe('/test/project/src');
  });

  it('should change to nested subdirectory', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    const result = runner.exposeChangeDirectory('src/components');
    expect(result.success).toBe(true);
    expect(result.newDir).toBe('/test/project/src/components');
  });

  it('should change to relative path', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project/src',
      autonomous: false
    });

    const result = runner.exposeChangeDirectory('tests');
    expect(result.success).toBe(true);
    expect(result.newDir).toBe('/test/project/tests');
  });

  it('should block cd to parent directory', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    const result = runner.exposeChangeDirectory('..');
    expect(result.success).toBe(false);
    expect(result.message).toContain('outside sandbox');
  });

  it('should block cd to absolute path outside sandbox', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    const result = runner.exposeChangeDirectory('/etc');
    expect(result.success).toBe(false);
    expect(result.message).toContain('outside sandbox');
  });

  it('should block cd to home directory', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    const result = runner.exposeChangeDirectory('~');
    expect(result.success).toBe(false);
    expect(result.message).toContain('cannot change to home');
  });

  it('should block cd to non-existent directory', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    const result = runner.exposeChangeDirectory('nonexistent');
    expect(result.success).toBe(false);
    expect(result.message).toContain('does not exist');
  });

  it('should display working directory relative to sandbox', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    // At root, shows the full path
    let dir = runner.exposeGetWorkingDirectory();
    expect(dir).toBe('/test/project');

    // Change to subdirectory
    runner.exposeChangeDirectory('src');

    // Shows relative path
    dir = runner.exposeGetWorkingDirectory();
    expect(dir).toBe('src');

    // Change to nested subdirectory
    runner.exposeChangeDirectory('components');

    // Shows relative path
    dir = runner.exposeGetWorkingDirectory();
    expect(dir).toBe('src/components');
  });

  it('should allow cd to absolute path within sandbox', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project/src',
      autonomous: false
    });

    const result = runner.exposeChangeDirectory('/test/project/docs');
    expect(result.success).toBe(true);
    expect(result.newDir).toBe('/test/project/docs');
  });

  it('should handle multiple directory changes', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    expect(runner.exposeChangeDirectory('src').success).toBe(true);
    expect(runner.exposeGetWorkingDirectory()).toBe('src');

    expect(runner.exposeChangeDirectory('components').success).toBe(true);
    expect(runner.exposeGetWorkingDirectory()).toBe('src/components');

    expect(runner.exposeChangeDirectory('../tests').success).toBe(true);
    expect(runner.exposeGetWorkingDirectory()).toBe('tests');
  });

  it('should block escaped path traversal', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project/src',
      autonomous: false
    });

    const result = runner.exposeChangeDirectory('../../..');
    expect(result.success).toBe(false);
    expect(result.message).toContain('outside sandbox');
  });
});

describe('BaseRunner - Input Handling', () => {
  it('should send prompt_resolved event when input is sent', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    let promptResolvedEmitted = false;
    let emittedInput = '';
    runner.on('prompt_resolved', (input: string) => {
      promptResolvedEmitted = true;
      emittedInput = input;
    });

    // Simulate input being sent
    runner['sendInput']('yes\n');

    expect(promptResolvedEmitted).toBe(true);
    expect(emittedInput).toBe('yes\n');
  });

  it('should handle input without newline', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    let promptResolvedEmitted = false;
    runner.on('prompt_resolved', () => {
      promptResolvedEmitted = true;
    });

    runner['sendInput']('y');

    expect(promptResolvedEmitted).toBe(true);
  });
});

describe('BaseRunner - State Management', () => {
  it('should include model in state', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false,
      model: 'codellama:13b'
    });

    const state = runner.getState();
    expect(state.model).toBe('codellama:13b');
  });

  it('should include workerType in state', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    const state = runner.getState();
    expect(state.workerType).toBe('test-worker');
  });
});