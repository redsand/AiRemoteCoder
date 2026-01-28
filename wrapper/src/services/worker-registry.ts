import { config } from '../config.js';

/**
 * Supported worker types
 */
export type WorkerType = 'claude' | 'ollama' | 'ollama-launch' | 'codex' | 'gemini' | 'rev';

/**
 * Worker configuration
 */
export interface WorkerConfig {
  type: WorkerType;
  command: string;
  displayName: string;
  icon: string;
  defaultModel?: string;
  supportsModelSelection: boolean;
  description: string;
  subcommand?: string; // For workers that use a subcommand (e.g., "launch", "run")
}

/**
 * Registry of all worker configurations
 */
export const WORKER_CONFIGS: Record<WorkerType, WorkerConfig> = {
  claude: {
    type: 'claude',
    command: config.claudeCommand,
    displayName: 'Claude',
    icon: '',
    defaultModel: undefined,
    supportsModelSelection: false,
    description: 'Anthropic Claude Code - Interactive AI coding assistant'
  },
  ollama: {
    type: 'ollama',
    command: config.ollamaCommand,
    displayName: 'Ollama',
    icon: '',
    defaultModel: config.ollamaModel,
    supportsModelSelection: true,
    description: 'Local LLM runner for models like CodeLlama, Llama, etc.',
    subcommand: 'run'
  },
  'ollama-launch': {
    type: 'ollama-launch',
    command: config.ollamaCommand,
    displayName: 'Ollama Launch (Claude)',
    icon: '',
    defaultModel: 'claude',
    supportsModelSelection: true,
    description: 'Ollama launch mode for Claude models with enhanced capabilities',
    subcommand: 'launch'
  },
  codex: {
    type: 'codex',
    command: config.codexCommand,
    displayName: 'Codex CLI',
    icon: '',
    defaultModel: undefined,
    supportsModelSelection: false,
    description: 'OpenAI Codex CLI for code generation'
  },
  gemini: {
    type: 'gemini',
    command: config.geminiCommand,
    displayName: 'Gemini CLI',
    icon: '',
    defaultModel: config.geminiModel,
    supportsModelSelection: true,
    description: 'Google Gemini CLI for AI assistance'
  },
  rev: {
    type: 'rev',
    command: config.revCommand,
    displayName: 'Rev',
    icon: '',
    defaultModel: undefined,
    supportsModelSelection: false,
    description: 'Custom AI coding tool'
  }
};

/**
 * Common Ollama models for user selection
 */
export const OLLAMA_MODELS: Array<{ value: string; label: string }> = [
  { value: 'qwen2.5-coder:7b', label: 'Qwen 2.5 Coder 7B' },
  { value: 'codellama:7b', label: 'CodeLlama 7B' },
  { value: 'codellama:13b', label: 'CodeLlama 13B' },
  { value: 'codellama:34b', label: 'CodeLlama 34B' },
  { value: 'codellama:instruct', label: 'CodeLlama Instruct' },
  { value: 'llama2:7b', label: 'Llama 2 7B' },
  { value: 'llama2:13b', label: 'Llama 2 13B' },
  { value: 'deepseek-coder:6.7b', label: 'DeepSeek Coder 6.7B' },
  { value: 'mistral:7b', label: 'Mistral 7B' },
  { value: 'phi:2.7b', label: 'Phi 2.7B' },
  { value: 'custom', label: 'Custom...' }
];

/**
 * Common Gemini models for user selection
 */
export const GEMINI_MODELS: Array<{ value: string; label: string }> = [
  { value: 'gemini-pro', label: 'Gemini Pro' },
  { value: 'gemini-pro-vision', label: 'Gemini Pro Vision' },
  { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
  { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
  { value: 'custom', label: 'Custom...' }
];

/**
 * Get worker configuration by type
 */
export function getWorkerConfig(workerType: WorkerType): WorkerConfig | undefined {
  return WORKER_CONFIGS[workerType];
}

/**
 * Get CLI command for a worker type
 */
export function getWorkerCommand(workerType: string | WorkerType): string {
  const workerConfig = WORKER_CONFIGS[workerType as WorkerType];
  return workerConfig?.command || workerType;
}

/**
 * Get default model for a worker type (if supported)
 */
export function getDefaultModel(workerType: string | WorkerType): string | undefined {
  const config = WORKER_CONFIGS[workerType as WorkerType];
  return config?.defaultModel;
}

/**
 * Check if worker type is valid
 */
export function isValidWorkerType(type: string): type is WorkerType {
  return type in WORKER_CONFIGS;
}

/**
 * Query Ollama API for available models
 * Connects to local Ollama instance (default: http://localhost:11434)
 */
export async function getAvailableOllamaModels(ollamaUrl: string = 'http://localhost:11434'): Promise<{ value: string; label: string }[]> {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`);
    if (!response.ok) {
      console.warn(`Failed to fetch Ollama models: ${response.statusText}`);
      return OLLAMA_MODELS; // Return defaults if API call fails
    }

    const data = await response.json() as { models?: Array<{ name: string; digest: string; size: number; modified_at: string }> };

    if (!data.models || data.models.length === 0) {
      return OLLAMA_MODELS; // Return defaults if no models found
    }

    // Convert Ollama model names to our format (remove :latest suffix if present)
    const models = data.models.map(m => ({
      value: m.name,
      label: m.name.replace(':latest', '')
    }));

    // Add custom option at the end
    models.push({ value: 'custom', label: 'Custom...' });

    return models;
  } catch (err) {
    console.warn('Could not connect to Ollama API, using default models:', err);
    return OLLAMA_MODELS; // Return defaults if connection fails
  }
}

/**
 * Get all worker types
 */
export function getAllWorkerTypes(): WorkerType[] {
  return Object.keys(WORKER_CONFIGS) as WorkerType[];
}

/**
 * Get worker display name
 */
export function getWorkerDisplayName(workerType: WorkerType): string {
  return WORKER_CONFIGS[workerType]?.displayName || workerType;
}

/**
 * Get worker icon (emoji)
 */
export function getWorkerIcon(workerType: string): string | undefined {
  const icons: Record<string, string> = {
    claude: '',
    ollama: '',
    codex: '',
    gemini: '',
    rev: ''
  };
  return icons[workerType];
}