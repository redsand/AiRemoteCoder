import { config } from '../config.js';

/**
 * Supported worker types
 */
export type WorkerType = 'claude' | 'ollama-launch' | 'codex' | 'gemini' | 'rev' | 'vnc' | 'hands-on';

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
  },
  vnc: {
    type: 'vnc',
    command: 'x11vnc',
    displayName: 'VNC Remote Desktop',
    icon: '',
    defaultModel: undefined,
    supportsModelSelection: false,
    description: 'Full remote desktop access via VNC - fallback when agents fail'
  },
  'hands-on': {
    type: 'hands-on',
    command: 'bash',
    displayName: 'Hands-On Control',
    icon: '',
    defaultModel: undefined,
    supportsModelSelection: false,
    description: 'Interactive shell for manual control and debugging'
  }
};

/**
 * Ollama Launch integrations for user selection
 * Note: ollama launch only works with these specific integrations, not arbitrary models
 */
export const OLLAMA_LAUNCH_INTEGRATIONS: Array<{ value: string; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'codex', label: 'Codex' },
  { value: 'droid', label: 'Droid' }
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
    'ollama-launch': '',
    codex: '',
    gemini: '',
    rev: '',
    vnc: '',
    'hands-on': ''
  };
  return icons[workerType];
}