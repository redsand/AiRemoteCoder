import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname, isAbsolute, sep } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

// Load .env from project root when present.
const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) {
  dotenvConfig({ path: envPath });
}

type DatabaseType = 'sqlite' | 'postgres';
type LogLevel = 'error' | 'warn' | 'info' | 'debug';
type NodeEnv = 'development' | 'production' | 'test';
type CorsOrigin = '*' | string | string[];

export interface AppConfig {
  port: number;
  host: string;
  projectRoot: string;
  dataDir: string;
  dbPath: string;
  artifactsDir: string;
  runsDir: string;
  certsDir: string;
  database: {
    path: string;
    type: DatabaseType;
  };
  secrets: {
    hmac: string;
    jwt: string;
    session: string;
  };
  cfAccessTeam: string;
  cfAccessAud: string;
  hmacSecret: string;
  authSecret: string;
  cors: {
    origin: CorsOrigin;
  };
  rateLimit: {
    max: number;
    windowMs: number;
    timeWindow: string;
  };
  upload: {
    maxFileSize: number;
    directory: string;
  };
  metrics: {
    enabled: boolean;
    port: number;
  };
  logLevel: LogLevel;
  env: NodeEnv;
  isProduction: boolean;
  apiKey?: string;
  tlsEnabled: boolean;
  tlsCert: string;
  tlsKey: string;
  maxBodySize: number;
  maxArtifactSize: number;
  claimLeaseSeconds: number;
  clockSkewSeconds: number;
  nonceExpirySeconds: number;
  runRetentionDays: number;
  mcpEnabled: boolean;
  mcpPath: string;
  mcpTokenExpirySeconds: number;
  mcpRateLimit: {
    max: number;
    timeWindow: string;
  };
  providers: {
    claude: boolean;
    codex: boolean;
    gemini: boolean;
    opencode: boolean;
    rev: boolean;
    legacyWrapper: boolean;
  };
  approvalTimeoutSeconds: number;
  allowlistedCommands: string[];
  secretPatterns: RegExp[];
}

function trimOrEmpty(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function parseIntWithFallback(value: string | null | undefined, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePort(value: string | null | undefined, fallback: number): number {
  const parsed = parseIntWithFallback(value, fallback);
  if (parsed === 0) return 0;
  if (parsed < 0 || parsed > 65535) return fallback;
  return parsed;
}

function parseBoolean(value: string | null | undefined, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseEnv(value: string | null | undefined): NodeEnv {
  const normalized = trimOrEmpty(value).toLowerCase();
  if (normalized === 'production' || normalized === 'test' || normalized === 'development') {
    return normalized;
  }
  return 'development';
}

function parseDatabaseType(value: string | null | undefined): DatabaseType {
  const normalized = trimOrEmpty(value).toLowerCase();
  return normalized === 'postgres' ? 'postgres' : 'sqlite';
}

function parseCorsOrigin(value: string | null | undefined): CorsOrigin {
  const normalized = trimOrEmpty(value);
  if (!normalized) return '*';
  if (!normalized.includes(',')) return normalized;
  const list = normalized.split(',').map((item) => item.trim()).filter(Boolean);
  return list.length > 0 ? list : '*';
}

function formatWindowMs(windowMs: number): string {
  if (windowMs % 60000 === 0) return `${windowMs / 60000} minute${windowMs === 60000 ? '' : 's'}`;
  if (windowMs % 1000 === 0) return `${windowMs / 1000} second${windowMs === 1000 ? '' : 's'}`;
  return `${windowMs} ms`;
}

export function resolvePath(inputPath: string): string {
  const expanded = inputPath.startsWith('~')
    ? resolve(projectRoot, inputPath.replace(/^~[\\/]/, ''))
    : isAbsolute(inputPath)
      ? inputPath
      : resolve(projectRoot, inputPath);

  return expanded.split(sep).join('/');
}

function buildConfig(): AppConfig {
  const port = parsePort(process.env.GATEWAY_PORT, 3000);
  const host = trimOrEmpty(process.env.GATEWAY_HOST) || 'localhost';
  const databaseType = parseDatabaseType(process.env.DATABASE_TYPE);
  const databasePath = trimOrEmpty(process.env.DATABASE_PATH) || './data/gateway.db';
  const dbPath = resolvePath(databasePath);
  const dataDir = resolvePath('./data');
  const artifactsDir = resolvePath('./data/artifacts');
  const runsDir = resolvePath('./data/runs');
  const certsDir = resolvePath('./data/certs');
  const env = parseEnv(process.env.NODE_ENV);
  const hmacSecret = trimOrEmpty(process.env.HMAC_SECRET) || randomBytes(32).toString('hex');
  const jwtSecret = trimOrEmpty(process.env.JWT_SECRET) || randomBytes(32).toString('hex');
  const sessionSecret = trimOrEmpty(process.env.SESSION_SECRET || process.env.AUTH_SECRET) || randomBytes(32).toString('hex');
  const corsOrigin = parseCorsOrigin(process.env.CORS_ORIGIN);
  const rateLimitMax = parseIntWithFallback(process.env.RATE_LIMIT_MAX, 100);
  const rateLimitWindowMs = parseIntWithFallback(process.env.RATE_LIMIT_WINDOW, 60000);
  const maxFileSize = parseIntWithFallback(process.env.MAX_FILE_SIZE, 10 * 1024 * 1024);
  const uploadDirectory = trimOrEmpty(process.env.UPLOAD_DIR) || './uploads';
  const metricsEnabled = parseBoolean(process.env.ENABLE_METRICS, false);
  const metricsPort = parsePort(process.env.METRICS_PORT, 9090);
  const cfAccessTeam = trimOrEmpty(process.env.CF_ACCESS_TEAM);
  const cfAccessAud = trimOrEmpty(process.env.CF_ACCESS_AUD);
  const logLevelRaw = trimOrEmpty(process.env.LOG_LEVEL).toLowerCase();
  const logLevel: LogLevel = ['error', 'warn', 'info', 'debug'].includes(logLevelRaw as LogLevel)
    ? (logLevelRaw as LogLevel)
    : 'info';
  const apiKey = process.env.API_KEY;
  const claimLeaseSeconds = parseIntWithFallback(process.env.GATEWAY_CLAIM_LEASE_SECONDS, 60);
  const runRetentionDays = parseIntWithFallback(process.env.RUN_RETENTION_DAYS, 30);
  const mcpEnabled = process.env.AIRC_MCP_ENABLED !== 'false';
  const mcpPath = process.env.AIRC_MCP_PATH || '/mcp';
  const mcpTokenExpirySeconds = parseIntWithFallback(process.env.AIRC_MCP_TOKEN_EXPIRY, 0);
  const mcpRateLimitMax = parseIntWithFallback(process.env.AIRC_MCP_RATE_LIMIT_MAX, 300);
  const mcpRateLimitWindow = process.env.AIRC_MCP_RATE_LIMIT_WINDOW || '1 minute';
  const approvalTimeoutSeconds = parseIntWithFallback(process.env.AIRC_APPROVAL_TIMEOUT, 300);
  const allowlistedCommands = [
    'npm test',
    'npm run test',
    'pnpm test',
    'pnpm run test',
    'yarn test',
    'pytest',
    'pytest -v',
    'go test ./...',
    'cargo test',
    'git diff',
    'git diff --cached',
    'git status',
    'git log --oneline -10',
    'cd',
    'ls',
    'ls -la',
    'ls -l',
    'ls -a',
    'll',
    'dir',
    'pwd',
  ].concat((process.env.EXTRA_ALLOWED_COMMANDS || '').split(',').map((entry) => entry.trim()).filter(Boolean));

  return {
    port,
    host,
    projectRoot,
    dataDir,
    dbPath,
    artifactsDir,
    runsDir,
    certsDir,
    database: {
      path: databasePath,
      type: databaseType,
    },
    secrets: {
      hmac: hmacSecret,
      jwt: jwtSecret,
      session: sessionSecret,
    },
    cfAccessTeam,
    cfAccessAud,
    hmacSecret,
    authSecret: sessionSecret,
    cors: {
      origin: corsOrigin,
    },
    rateLimit: {
      max: rateLimitMax,
      windowMs: rateLimitWindowMs,
      timeWindow: formatWindowMs(rateLimitWindowMs),
    },
    upload: {
      maxFileSize,
      directory: uploadDirectory,
    },
    metrics: {
      enabled: metricsEnabled,
      port: metricsPort,
    },
    logLevel,
    env,
    isProduction: env === 'production',
    apiKey,
    tlsEnabled: process.env.TLS_ENABLED !== 'false',
    tlsCert: resolvePath('./data/certs/server.crt'),
    tlsKey: resolvePath('./data/certs/server.key'),
    maxBodySize: 10 * 1024 * 1024,
    maxArtifactSize: 50 * 1024 * 1024,
    claimLeaseSeconds,
    clockSkewSeconds: 300,
    nonceExpirySeconds: 600,
    runRetentionDays,
    mcpEnabled,
    mcpPath,
    mcpTokenExpirySeconds,
    mcpRateLimit: {
      max: mcpRateLimitMax,
      timeWindow: mcpRateLimitWindow,
    },
    providers: {
      claude: process.env.AIRC_PROVIDER_CLAUDE !== 'false',
      codex: process.env.AIRC_PROVIDER_CODEX !== 'false',
      gemini: process.env.AIRC_PROVIDER_GEMINI !== 'false',
      opencode: process.env.AIRC_PROVIDER_OPENCODE !== 'false',
      rev: process.env.AIRC_PROVIDER_REV !== 'false',
      legacyWrapper: process.env.AIRC_LEGACY_WRAPPERS_ENABLED !== 'false',
    },
    approvalTimeoutSeconds,
    allowlistedCommands,
    secretPatterns: [
      /(?:api[_-]?key|apiKey|API_KEY|APIKEY|secret|password|PASSWORD|token|TOKEN|auth|AUTH|bearer|Bearer|BEARER|credential)[=:\s]\s*["']?[\w\-\.]+["']?/g,
      /sk-[a-zA-Z0-9]{20,}/g,
      /ghp_[a-zA-Z0-9]{36}/g,
      /ghs_[a-zA-Z0-9]{36}/g,
      /npm_[a-zA-Z0-9]{36}/g,
      /-----BEGIN[\s\S]*?-----END[^-]*-----/g,
    ],
  };
}

export let config: AppConfig = buildConfig();

export function loadConfig(): AppConfig {
  config = buildConfig();
  return config;
}

export function validateConfig(): void {
  loadConfig();
  if (!config.hmacSecret || config.hmacSecret.length < 32) {
    config.hmacSecret = randomBytes(32).toString('hex');
    config.secrets.hmac = config.hmacSecret;
  }
  if (!config.authSecret || config.authSecret.length < 32) {
    config.authSecret = randomBytes(32).toString('hex');
    config.secrets.session = config.authSecret;
  }
}

export { projectRoot };
