import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  public exposeDetectBlockingPrompt(text: string): { isPrompt: boolean; type?: 'yes' | 'confirm' } {
    return (this as any).detectBlockingPrompt(text);
  }

  public exposeBuildStartMarker(command: string): Record<string, any> {
    return (this as any).buildStartMarker(command);
  }

  public exposeBuildEnvironment(): NodeJS.ProcessEnv {
    return (this as any).buildEnvironment();
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
        expect(runner.exposeDetectBlockingPrompt(prompt).isPrompt).toBe(true);
      }
    });

    it('should detect "Should I" prompts', () => {
      const prompts = [
        'Should I delete this file?',
        'Should I continue with the refactoring?',
        'Should I run the tests?'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt).isPrompt).toBe(true);
      }
    });

    it('should detect "Do you want me to" prompts', () => {
      const prompts = [
        'Do you want me to commit these changes?',
        'Do you want me to run the build?'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt).isPrompt).toBe(true);
      }
    });

    it('should detect [Y/n] prompts', () => {
      const prompts = [
        'Proceed? [Y/n]',
        'Continue with this action? [Y/n]',
        'Are you sure? [Y/n]'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt).isPrompt).toBe(true);
      }
    });

    it('should detect (y/N) prompts', () => {
      const prompts = [
        'Continue? (y/N)',
        'Delete file? (y/N)'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt).isPrompt).toBe(true);
      }
    });

    it('should detect question mark at end of line', () => {
      const prompts = [
        'Are you sure you want to continue?',
        'Should I proceed with this change?\n',
        'Do you want to proceed?'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt).isPrompt).toBe(true);
      }
    });

    it('should detect "Continue?" prompts', () => {
      const prompts = [
        'Continue?',
        'Press Enter to continue?',
        'Continue with operation?'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt).isPrompt).toBe(true);
      }
    });

    it('should detect "Press Enter to continue" prompts', () => {
      const prompts = [
        'Press Enter to continue',
        'Press ENTER to continue',
        'press enter to continue'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt).isPrompt).toBe(true);
      }
    });

    it('should detect "Type \'y\' to continue" prompts', () => {
      const prompts = [
        "Type 'y' to continue",
        "Type 'y' to proceed",
        'Type "y" to continue'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt).isPrompt).toBe(true);
      }
    });

    it('should detect "Type \'yes\' to continue" prompts', () => {
      const prompts = [
        "Type 'yes' to continue",
        "Type 'yes' to proceed"
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt).isPrompt).toBe(true);
      }
    });

    it('should detect "Enter to proceed" prompts', () => {
      const prompts = [
        'Enter to proceed',
        'press ENTER to proceed'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt).isPrompt).toBe(true);
      }
    });

    it('should detect "Are you sure" prompts', () => {
      const prompts = [
        'Are you sure?',
        'Are you sure you want to delete this file?',
        'Are you certain?'
      ];

      for (const prompt of prompts) {
        expect(runner.exposeDetectBlockingPrompt(prompt).isPrompt).toBe(true);
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
        expect(runner.exposeDetectBlockingPrompt(prompt).isPrompt).toBe(true);
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
        expect(runner.exposeDetectBlockingPrompt(text).isPrompt).toBe(false);
      }
    });

    it('should handle edge cases', () => {
      expect(runner.exposeDetectBlockingPrompt('').isPrompt).toBe(false);
      expect(runner.exposeDetectBlockingPrompt('   ').isPrompt).toBe(false);
      expect(runner.exposeDetectBlockingPrompt('Output without question').isPrompt).toBe(false);
    });
  });

  describe('Prompt Detection Integration', () => {
    it('should detect prompt in Claude-style output', () => {
      const claudeOutput = `
I've analyzed the code and found a potential issue in the authentication module.

Would you like me to fix this vulnerability? [Y/n]
`;
      expect(runner.exposeDetectBlockingPrompt(claudeOutput).isPrompt).toBe(true);
    });

    it('should detect prompt in multi-line output', () => {
      const output = `
Making changes to 3 files...
- src/auth.ts
- src/user.ts
- src/session.ts

Are you sure you want to proceed?
`;
      expect(runner.exposeDetectBlockingPrompt(output).isPrompt).toBe(true);
    });
  });
});

describe('BaseRunner - Start Marker', () => {
  it('should include workerType in start marker', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'test-token',
      workingDir: '/test/project',
      autonomous: false,
      model: 'test-model'
    });

    const marker = runner.exposeBuildStartMarker('test command');

    expect(marker.event).toBe('started');
    expect(marker.workerType).toBe('test-worker');
    expect(marker.model).toBe('test-model');
    expect(marker.autonomous).toBe(false);
  });
});

describe('BaseRunner - Environment Building', () => {
  it('should set TERM based on autonomous mode', () => {
    const autonomousRunner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: true
    });

    const interactiveRunner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    const autonomousEnv = autonomousRunner.exposeBuildEnvironment();
    const interactiveEnv = interactiveRunner.exposeBuildEnvironment();

    expect(autonomousEnv.TERM).toBe('xterm-256color');
    expect(interactiveEnv.TERM).toBe('dumb');
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

  it('should track stop requested state', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    const state = runner.getState();
    expect(state.stopRequested).toBe(false);
    expect(state.haltRequested).toBeUndefined();
  });
});

describe('BaseRunner - Command Building', () => {
  it('should build command without prompt', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    const result = runner.buildCommand();
    expect(result.args).toEqual([]);
    expect(result.fullCommand).toBe('test-cmd');
  });

  it('should build command with prompt', () => {
    const runner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: false
    });

    const result = runner.buildCommand('test prompt');
    expect(result.args).toEqual(['test prompt']);
    expect(result.fullCommand).toBe('test prompt');
  });

  it('should include autonomous mode in start marker', () => {
    const autonomousRunner = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/test/project',
      autonomous: true
    });

    const marker = autonomousRunner.exposeBuildStartMarker('autonomous test');
    expect(marker.autonomous).toBe(true);
    expect(marker.event).toBe('started');
  });
});

describe('BaseRunner - Working Directory', () => {
  it('should use provided working directory', () => {
    const runner1 = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      workingDir: '/custom/path',
      autonomous: false
    });

    const runner2 = new TestRunner({
      runId: 'test-run',
      capabilityToken: 'token',
      // No workingDir specified - should use default
      autonomous: false
    });

    expect(runner1.getState().workingDir).toBe('/custom/path');
    expect(runner2.getState().workingDir).toBe(process.cwd());
  });
});

describe('BaseRunner - Input Handling', () => {
  it('should emit prompt_resolved event when input is sent', () => {
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

    // Mock the process stdin
    const mockStdin = { write: vi.fn(() => true) };
    (runner as any).process = { stdin: mockStdin };

    runner['sendInput']('yes\n');

    expect(promptResolvedEmitted).toBe(true);
    expect(emittedInput).toBe('yes\n');
    expect(mockStdin.write).toHaveBeenCalledWith('yes\n');
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

    const mockStdin = { write: vi.fn(() => true) };
    (runner as any).process = { stdin: mockStdin };

    runner['sendInput']('y');

    expect(promptResolvedEmitted).toBe(true);
    expect(mockStdin.write).toHaveBeenCalledWith('y');
  });
});