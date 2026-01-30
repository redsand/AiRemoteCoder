import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

// Load .env from project root
const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) {
  dotenvConfig({ path: envPath });
}

export const config = {
  // Server
  port: parseInt(process.env.GATEWAY_PORT || '3100', 10),
  host: process.env.GATEWAY_HOST || '0.0.0.0',

  // Paths (all under project root)
  projectRoot,
  dataDir: resolve(projectRoot, '.data'),
  dbPath: resolve(projectRoot, '.data', 'db.sqlite'),
  artifactsDir: resolve(projectRoot, '.data', 'artifacts'),
  runsDir: resolve(projectRoot, '.data', 'runs'),
  certsDir: resolve(projectRoot, '.data', 'certs'),

  // Security
  hmacSecret: process.env.HMAC_SECRET || '',
  authSecret: process.env.AUTH_SECRET || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  totpSecret: process.env.TOTP_SECRET || '',

  // Cloudflare Access (optional)
  cfAccessTeam: process.env.CF_ACCESS_TEAM || '',
  cfAccessAud: process.env.CF_ACCESS_AUD || '',

  // TLS
  tlsEnabled: process.env.TLS_ENABLED !== 'false',
  tlsCert: resolve(projectRoot, '.data', 'certs', 'server.crt'),
  tlsKey: resolve(projectRoot, '.data', 'certs', 'server.key'),

  // Limits
  maxBodySize: 10 * 1024 * 1024, // 10MB
  maxArtifactSize: 50 * 1024 * 1024, // 50MB
  claimLeaseSeconds: parseInt(process.env.GATEWAY_CLAIM_LEASE_SECONDS || '60', 10),
  rateLimit: {
    max: 100,
    timeWindow: '1 minute'
  },
  clockSkewSeconds: 300, // 5 minutes
  nonceExpirySeconds: 600, // 10 minutes

  // Retention
  runRetentionDays: parseInt(process.env.RUN_RETENTION_DAYS || '30', 10),

  // Allowlisted commands (can be extended via env)
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
    // Directory navigation (handled specially in wrapper)
    'cd',
    'ls',
    'ls -la',
    'ls -l',
    'ls -a',
    'll',
    'dir',
    'pwd'
  ].concat((process.env.EXTRA_ALLOWED_COMMANDS || '').split(',').filter(Boolean)),

  // Secret patterns to redact
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

// Validate critical config
export function validateConfig(): void {
  if (!config.hmacSecret || config.hmacSecret.length < 32) {
    console.warn('WARNING: HMAC_SECRET not set or too short. Generating random secret for this session.');
    config.hmacSecret = randomBytes(32).toString('hex');
  }

  if (!config.authSecret || config.authSecret.length < 32) {
    console.warn('WARNING: AUTH_SECRET not set or too short. Generating random secret for this session.');
    config.authSecret = randomBytes(32).toString('hex');
  }
}
