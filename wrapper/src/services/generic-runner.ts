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
  // Optional: integration for ollama-launch (claude, codex, opencode, droid)
  integration?: string;
  // Optional: provider for rev (ollama, claude, etc.)
  provider?: string;
}

/**
 * Generic CLI worker that works with any CLI tool
 * Supports various AI coding tools through a configurable interface
 */
export class GenericRunner extends BaseRunner {
  private workerType: WorkerType;
  private commandPrefix?: string[];
  private buildCommandFn?: (command?: string, autonomous?: boolean, model?: string) => WorkerCommandResult;
  private initialCommand?: string; // Store initial command for stdin-based execution

  constructor(options: GenericRunnerOptions) {
    super(options);
    this.workerType = options.workerType;
    this.commandPrefix = options.commandPrefix;
    this.buildCommandFn = options.buildCommandFn;
    // Set integration from options, with fallback to base runner's integration
    if (options.integration) {
      this.integration = options.integration;
    }
    // Set provider from options, with fallback to base runner's provider
    if (options.provider) {
      this.provider = options.provider;
    }
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
   * Override start to handle sending initial command via stdin for ollama-launch
   */
  async start(command?: string): Promise<void> {
    // Store the initial command for ollama-launch to send via stdin
    if (this.workerType === 'ollama-launch' && command) {
      this.initialCommand = command;
    }

    // Call parent start method
    await super.start(command);

    // For ollama-launch, send the initial command via stdin after process starts
    if (this.workerType === 'ollama-launch' && this.initialCommand) {
      // Delay to ensure ollama launch process is fully initialized
      // ollama launch can take a moment to set up the integration
      await new Promise(resolve => setTimeout(resolve, 2000));

      if (this.sendInput(this.initialCommand + '\n')) {
        console.log('Sent initial command to ollama launch process via stdin');
      } else {
        console.log('Failed to send initial command to ollama launch - process may not have stdin available yet');
      }
    }
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
    const subcommand = workerConfig?.subcommand;

    // Otherwise, use worker-specific command building
    switch (this.workerType) {
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
   * Usage: ollama run <model> [prompt] or ollama launch <integration> --model <model>
   * Note: For 'launch' mode, the initial command is sent via stdin, not as CLI args
   * Integrations: claude, opencode, codex, droid
   */
  private buildOllamaCommand(command?: string, autonomous?: boolean, subcommand: string = 'run'): WorkerCommandResult {
    const args = [subcommand];

    if (subcommand === 'run') {
      // For 'run' mode: ollama run <model> [prompt]
      const model = this.model || config.ollamaModel;
      args.push(model);

      if (command) {
        args.push(command);
      }
    } else if (subcommand === 'launch') {
      // For 'launch' mode: ollama launch <integration> --model <model>
      // integration: claude, opencode, codex, droid
      const integration = this.integration || 'claude';
      args.push(integration);

      // Add --model flag with the specific model
      if (this.model) {
        args.push('--model', this.model);
      }
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
   * Usage: rev [--provider <provider>] [--model <model>] <prompt>
   * Providers: ollama, claude, etc.
   */
  private buildRevCommand(command?: string, autonomous?: boolean): WorkerCommandResult {
    const args = [];

    // Add provider if specified
    if (this.provider) {
      args.push('--provider', this.provider);
    }

    // Add model if specified
    if (this.model) {
      args.push('--model', this.model);
    }

    // Add command/prompt if provided
    if (command) {
      args.push(command);
    }

    const fullCommand = args.length > 0
      ? `${this.getCommand()} ${args.join(' ')}`
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
      case 'ollama-launch':
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
        const revEnv: NodeJS.ProcessEnv = {
          ...baseEnv,
          REV_API_KEY: process.env.REV_API_KEY || ''
        };

        // Add provider-specific env vars
        if (this.provider === 'ollama') {
          revEnv.OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
        }

        return revEnv;

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