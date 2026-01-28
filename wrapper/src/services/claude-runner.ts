import { BaseRunner, RunnerOptions, WorkerCommandResult } from './base-runner.js';
import { config } from '../config.js';
import { join, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';

export interface ClaudeRunnerOptions extends RunnerOptions {
  // No Claude-specific options needed currently
}

/**
 * Claude Code runner implementation
 * Extends BaseRunner with Claude-specific command building
 */
export class ClaudeRunner extends BaseRunner {
  constructor(options: ClaudeRunnerOptions) {
    super(options);

    // Override log path to maintain backward compatibility
    const runDir = join(config.runsDir, options.runId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    (this as any).logPath = join(runDir, 'claude.log');
    (this as any).stateFile = join(runDir, 'state.json');
  }

  /**
   * Get the worker type identifier
   */
  getWorkerType(): string {
    return 'claude';
  }

  /**
   * Get the CLI command for Claude
   */
  getCommand(): string {
    return config.claudeCommand;
  }

  /**
   * Build Claude command arguments based on mode
   */
  buildCommand(command?: string, autonomous?: boolean): WorkerCommandResult {
    let claudeArgs: string[] = [];
    let fullCommand: string;

    if (autonomous) {
      // Autonomous mode: no prompt, just start Claude in interactive mode
      // Use --dangerously-skip-permissions if available for full autonomy
      claudeArgs = ['--dangerously-skip-permissions'];
      fullCommand = `${this.getCommand()} (autonomous mode)`;
    } else if (command) {
      claudeArgs = [command];
      fullCommand = `${this.getCommand()} ${claudeArgs.join(' ')}`.trim();
    } else {
      // Interactive mode without prompt
      fullCommand = this.getCommand();
    }

    return { args: claudeArgs, fullCommand };
  }

  /**
   * Build the start marker with Claude-specific data
   */
  protected buildStartMarker(command: string): Record<string, any> {
    return {
      ...super.buildStartMarker(command),
      workerType: 'claude'
    };
  }

  /**
   * Get current run state (backward compatible method)
   */
  getState(): {
    runId: string;
    isRunning: boolean;
    sequence: number;
    workingDir: string;
    autonomous: boolean;
    stopRequested: boolean;
  } {
    const state = super.getState();
    return {
      runId: state.runId,
      isRunning: state.isRunning,
      sequence: state.sequence,
      workingDir: state.workingDir,
      autonomous: state.autonomous,
      stopRequested: state.stopRequested
    };
  }

  /**
   * Save state to disk (backward compatible)
   */
  protected saveState(): void {
    const state = {
      runId: this.auth.runId,
      sequence: this.sequence,
      workingDir: this.workingDir,
      autonomous: this.autonomous,
      savedAt: Date.now()
    };
    try {
      writeFileSync((this as any).stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('Failed to save state:', err);
    }
  }

  /**
   * Load state from disk (backward compatible)
   */
  protected loadState(): boolean {
    try {
      if (existsSync((this as any).stateFile)) {
        const data = readFileSync((this as any).stateFile, 'utf8');
        const state = JSON.parse(data);
        this.sequence = state.sequence || 0;
        return true;
      }
    } catch (err) {
      console.error('Failed to load state:', err);
    }
    return false;
  }
}
