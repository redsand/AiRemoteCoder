import { BaseRunner, RunnerOptions, WorkerCommandResult } from './base-runner.js';
import { getWorkerCommand, getWorkerConfig, type WorkerType } from './worker-registry.js';
import { config } from '../config.js';

/**
 * Options specific to GenericRunner
 */
export interface GenericRunnerOptions extends RunnerOptions {
  workerType: WorkerType;
  // Optional: override the command to execute (for worker-specific command structures)
  commandPrefix?: string[];
  // Optional: custom command building function
  buildCommandFn?: (command?: string, autonomous?: boolean, model?: string) => WorkerCommandResult;
}

/**
 * Generic CLI worker that works with any CLI tool
 * Supports various AI coding tools through a configurable interface
 */
export class GenericRunner extends BaseRunner {
  private workerType: WorkerType;
  private commandPrefix?: string[];
  private buildCommandFn?: (command?: string, autonomous?: boolean, model?: string) => WorkerCommandResult;

  constructor(options: GenericRunnerOptions) {
    super(options);
    this.workerType = options.workerType;
    this.commandPrefix = options.commandPrefix;
    this.buildCommandFn = options.buildCommandFn;
  }

  /**
   * Get the worker type identifier
   */
  getWorkerType(): string {
    return this.workerType;
  }

  /**
   * Get the CLI command for this worker
   */
  getCommand(): string {
    if (this.commandPrefix && this.commandPrefix.length > 0) {
      return this.commandPrefix[0];
    }
    return config.getWorkerCommand(this.workerType);
  }

  /**
   * Build command arguments based on worker type
   */
  buildCommand(command?: string, autonomous?: boolean): WorkerCommandResult {
    // Use custom command builder if provided
    if (this.buildCommandFn) {
      return this.buildCommandFn(command, autonomous, this.model);
    }

    // Get the worker config to check for subcommand
    const workerConfig = getWorkerConfig(this.workerType);
    const subcommand = workerConfig?.subcommand || (this.workerType === 'ollama' ? 'run' : undefined);

    // Otherwise, use worker-specific command building
    switch (this.workerType) {
      case 'ollama':
      case 'ollama-launch':
        return this.buildOllamaCommand(command, autonomous, subcommand);
      case 'codex':
        return this.buildCodexCommand(command, autonomous);
      case 'gemini':
        return this.buildGeminiCommand(command, autonomous);
      case 'rev':
        return this.buildRevCommand(command, autonomous);
      default:
        // Fallback: treat command as direct argument
        return {
          args: command ? [command] : [],
          fullCommand: command || this.getCommand()
        };
    }
  }

  /**
   * Build Ollama command
   * Usage: ollama run <model> [prompt] or ollama launch <model> [prompt]
   */
  private buildOllamaCommand(command?: string, autonomous?: boolean, subcommand: string = 'run'): WorkerCommandResult {
    const model = this.model || config.ollamaModel;
    const args = [subcommand, model];

    if (command) {
      args.push(command);
    }

    // For launch mode, add --config flag if in autonomous mode for full permissions
    if (subcommand === 'launch' && autonomous) {
      args.push('--config');
    }

    const fullCommand = `${this.getCommand()} ${args.join(' ')}`;
    return { args, fullCommand };
  }

  /**
   * Build Codex CLI command
   * Usage: codex-cli <prompt>
   */
  private buildCodexCommand(command?: string, autonomous?: boolean): WorkerCommandResult {
    const args = command ? [command] : [];

    if (!command && autonomous) {
      // For autonomous mode, Codex CLI may need specific flags
      // This depends on the actual Codex CLI implementation
    }

    const fullCommand = command
      ? `${this.getCommand()} ${command}`
      : this.getCommand();

    return { args, fullCommand };
  }

  /**
   * Build Gemini CLI command
   * Usage: gemini-cli --model <model> [prompt]
   */
  private buildGeminiCommand(command?: string, autonomous?: boolean): WorkerCommandResult {
    const model = this.model || config.geminiModel;
    const args = ['--model', model];

    if (command) {
      args.push(command);
    }

    const fullCommand = `${this.getCommand()} ${args.join(' ')}`;
    return { args, fullCommand };
  }

  /**
   * Build Rev command
   * Usage: rev <prompt>
   */
  private buildRevCommand(command?: string, autonomous?: boolean): WorkerCommandResult {
    const args = command ? [command] : [];

    const fullCommand = command
      ? `${this.getCommand()} ${command}`
      : this.getCommand();

    return { args, fullCommand };
  }

  /**
   * Build environment variables (can be overridden for worker-specific needs)
   */
  protected buildEnvironment(): NodeJS.ProcessEnv {
    const baseEnv = super.buildEnvironment();

    // Worker-specific environment variables
    switch (this.workerType) {
      case 'ollama':
        // Ollama-specific env vars
        return {
          ...baseEnv,
          OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://localhost:11434'
        };

      case 'codex':
        // Codex-specific env vars (API keys, etc.)
        return {
          ...baseEnv,
          OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
          CODEX_API_KEY: process.env.CODEX_API_KEY || ''
        };

      case 'gemini':
        // Gemini-specific env vars
        return {
          ...baseEnv,
          GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || '',
          GEMINI_API_KEY: process.env.GEMINI_API_KEY || ''
        };

      case 'rev':
        // Rev-specific env vars
        return {
          ...baseEnv,
          REV_API_KEY: process.env.REV_API_KEY || ''
        };

      default:
        return baseEnv;
    }
  }
}

/**
 * Factory function to create a GenericRunner for a specific worker type
 */
export function createGenericRunner(workerType: WorkerType, options: Omit<RunnerOptions, 'runId' | 'capabilityToken'> & {
  runId: string;
  capabilityToken: string;
}): GenericRunner {
  return new GenericRunner({
    ...options,
    workerType
  });
}