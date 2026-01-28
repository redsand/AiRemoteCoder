import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

// Load .env from project root
const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) {
  dotenvConfig({ path: envPath });
}

export const config = {
  // Gateway connection
  gatewayUrl: process.env.GATEWAY_URL || 'https://localhost:3100',
  hmacSecret: process.env.HMAC_SECRET || '',

  // Project paths
  projectRoot,
  dataDir: resolve(projectRoot, '.data'),
  runsDir: resolve(projectRoot, '.data', 'runs'),

  // Worker Commands
  claudeCommand: process.env.CLAUDE_COMMAND || 'claude',
  ollamaCommand: process.env.OLLAMA_COMMAND || 'ollama',
  ollamaModel: process.env.OLLAMA_MODEL || 'codellama:7b',
  codexCommand: process.env.CODEX_COMMAND || 'codex-cli',
  geminiCommand: process.env.GEMINI_COMMAND || 'gemini-cli',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-pro',
  revCommand: process.env.REV_COMMAND || 'rev',

  // Get worker command by type
  getWorkerCommand(workerType: string): string {
    const commands: Record<string, string> = {
      claude: this.claudeCommand,
      'ollama-launch': this.ollamaCommand,
      codex: this.codexCommand,
      gemini: this.geminiCommand,
      rev: this.revCommand
    };
    return commands[workerType] || workerType;
  },

  // Get default model for worker type
  getDefaultModel(workerType: string): string | undefined {
    const models: Record<string, string | undefined> = {
      ollama: this.ollamaModel,
      gemini: this.geminiModel
    };
    return models[workerType];
  },

  // Polling intervals (ms)
  commandPollInterval: parseInt(process.env.COMMAND_POLL_INTERVAL || '2000', 10),
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10),

  // Tmate for assist sessions
  tmateCommand: process.env.TMATE_COMMAND || 'tmate',

  // Security
  allowSelfSignedCerts: process.env.ALLOW_SELF_SIGNED === 'true',

  // Allowlisted commands (must match gateway config)
  allowlistedCommands: [
    // Test commands
    'npm test',
    'npm run test',
    'pnpm test',
    'pnpm run test',
    'yarn test',
    'pytest',
    'pytest -v',
    'go test ./...',
    'cargo test',
    // Git commands
    'git diff',
    'git diff --cached',
    'git status',
    'git log --oneline -10',
    // Directory navigation (handled specially in runner)
    'cd',
    'ls',
    'ls -la',
    'ls -l',
    'ls -a',
    'll',
    'dir',
    'pwd'
  ].concat((process.env.EXTRA_ALLOWED_COMMANDS || '').split(',').filter(Boolean)),

  // Secret patterns to redact before sending
  secretPatterns: [
    // Match various key/password/token formats with = or : separators (handles spaces after separator)
    /(?:api[_-]?key|apiKey|API_KEY|APIKEY|secret|password|PASSWORD|token|TOKEN|auth|AUTH|bearer|Bearer|BEARER|credential)[=:\s]\s*["']?[\w\-\.]+["']?/g,
    // OpenAI keys
    /sk-[a-zA-Z0-9]{20,}/g,
    // GitHub tokens
    /ghp_[a-zA-Z0-9]{36}/g,
    /ghs_[a-zA-Z0-9]{36}/g,
    // NPM tokens
    /npm_[a-zA-Z0-9]{36}/g,
    // PEM certificates
    /-----BEGIN[\s\S]*?-----END[^-]*-----/g
  ]
};

export function validateConfig(): void {
  if (!config.hmacSecret || config.hmacSecret.length < 32) {
    throw new Error('HMAC_SECRET must be set and at least 32 characters');
  }
}
