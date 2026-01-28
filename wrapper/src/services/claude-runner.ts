import { BaseRunner, RunnerOptions, WorkerCommandResult } from './base-runner.js';
import { config } from '../config.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve as pathResolve, relative as pathRelative, normalize as pathNormalize } from 'path';

// Re-export RunnerOptions for convenience
export type { RunnerOptions };

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
  getState() {
    return super.getState();
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

/**
 * Parse a cd command and extract the target directory
 * Returns null if not a cd command, empty string for bare 'cd', or the trimmed path
 */
export function parseCdCommand(command: string): string | null {
  if (!command.startsWith('cd')) {
    return null;
  }
  // Check if it's exactly 'cd' (bare cd)
  if (command === 'cd') {
    return '';
  }
  // Must have space after 'cd'
  if (!command.startsWith('cd ')) {
    return null;
  }
  return command.substring(3).trim();
}

/**
 * Validate that a path stays within the sandbox root
 * Prevents directory traversal attacks
 */
export function isPathSafe(path: string, sandboxRoot: string): boolean {
  try {
    // Normalize paths first to handle both POSIX and Windows formats
    const normalizedRoot = pathNormalize(sandboxRoot);
    const normalizedPath = pathNormalize(path);

    // Resolve the path relative to the sandbox root
    const resolved = pathResolve(normalizedRoot, normalizedPath);
    const normalizedResolved = pathNormalize(resolved);

    // Normalize the root as well
    const normalizedRootResolved = pathNormalize(pathResolve(normalizedRoot));

    // Convert both to forward slashes for consistent comparison
    const resolvedForComparison = normalizedResolved.replace(/\\/g, '/').toLowerCase();
    const rootForComparison = normalizedRootResolved.replace(/\\/g, '/').toLowerCase();

    // Check if resolved path is within the sandbox
    // This works even if paths have different drive letters or are POSIX vs Windows
    return (
      resolvedForComparison === rootForComparison ||
      resolvedForComparison.startsWith(rootForComparison + '/')
    );
  } catch {
    return false;
  }
}

/**
 * Get the relative path from root, or return root if at root
 */
export function getRelativePath(current: string, root: string): string {
  try {
    // Normalize both paths for comparison
    const normalizedRoot = pathNormalize(root);
    const normalizedCurrent = pathNormalize(current);

    const rel = pathRelative(normalizedRoot, normalizedCurrent);

    // If relative path is empty or '.', we're at the root - return original root path
    if (!rel || rel === '.') {
      return root;
    }
    // Convert backslashes to forward slashes for consistency
    return rel.replace(/\\/g, '/');
  } catch {
    return '';
  }
}
