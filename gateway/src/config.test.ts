import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { config, loadConfig, resolvePath } from './config.js';

describe('Configuration Module', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Store original environment
    originalEnv = { ...process.env };
    
    // Clear all env vars that might affect config
    const configVars = [
      'GATEWAY_PORT',
      'GATEWAY_HOST',
      'DATABASE_PATH',
      'DATABASE_TYPE',
      'HMAC_SECRET',
      'JWT_SECRET',
      'SESSION_SECRET',
      'CORS_ORIGIN',
      'RATE_LIMIT_MAX',
      'RATE_LIMIT_WINDOW',
      'LOG_LEVEL',
      'NODE_ENV',
      'MAX_FILE_SIZE',
      'UPLOAD_DIR',
      'API_KEY',
      'ENABLE_METRICS',
      'METRICS_PORT'
    ];
    
    configVars.forEach(varName => {
      delete process.env[varName];
    });
    
    // Reset config to defaults
    loadConfig();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('Default Values', () => {
    it('should have default port 3000', () => {
      expect(config.port).toBe(3000);
    });

    it('should have default host localhost', () => {
      expect(config.host).toBe('localhost');
    });

    it('should have default database path ./data/gateway.db', () => {
      expect(config.database.path).toBe('./data/gateway.db');
    });

    it('should have default database type sqlite', () => {
      expect(config.database.type).toBe('sqlite');
    });

    it('should have default log level info', () => {
      expect(config.logLevel).toBe('info');
    });

    it('should have default CORS origin *', () => {
      expect(config.cors.origin).toBe('*');
    });

    it('should have default rate limit settings', () => {
      expect(config.rateLimit.max).toBe(100);
      expect(config.rateLimit.windowMs).toBe(60000); // 1 minute
    });

    it('should have default max file size 10MB', () => {
      expect(config.upload.maxFileSize).toBe(10 * 1024 * 1024);
    });

    it('should have default upload directory ./uploads', () => {
      expect(config.upload.directory).toBe('./uploads');
    });

    it('should have default environment development', () => {
      expect(config.env).toBe('development');
    });

    it('should have metrics disabled by default', () => {
      expect(config.metrics.enabled).toBe(false);
    });

    it('should have default metrics port 9090', () => {
      expect(config.metrics.port).toBe(9090);
    });
  });

  describe('Environment Variable Loading - Port', () => {
    it('should load GATEWAY_PORT from environment', () => {
      process.env.GATEWAY_PORT = '8080';
      loadConfig();
      expect(config.port).toBe(8080);
    });

    it('should parse port as integer', () => {
      process.env.GATEWAY_PORT = '9000';
      loadConfig();
      expect(typeof config.port).toBe('number');
      expect(config.port).toBe(9000);
    });

    it('should use default port for invalid port number', () => {
      process.env.GATEWAY_PORT = 'invalid';
      loadConfig();
      expect(config.port).toBe(3000);
    });

    it('should use default port for negative port number', () => {
      process.env.GATEWAY_PORT = '-1';
      loadConfig();
      expect(config.port).toBe(3000);
    });

    it('should use default port for port > 65535', () => {
      process.env.GATEWAY_PORT = '70000';
      loadConfig();
      expect(config.port).toBe(3000);
    });

    it('should accept port 0 (ephemeral port)', () => {
      process.env.GATEWAY_PORT = '0';
      loadConfig();
      expect(config.port).toBe(0);
    });
  });

  describe('Environment Variable Loading - Host', () => {
    it('should load GATEWAY_HOST from environment', () => {
      process.env.GATEWAY_HOST = '0.0.0.0';
      loadConfig();
      expect(config.host).toBe('0.0.0.0');
    });

    it('should load GATEWAY_HOST with IPv6 address', () => {
      process.env.GATEWAY_HOST = '::1';
      loadConfig();
      expect(config.host).toBe('::1');
    });

    it('should load GATEWAY_HOST with domain', () => {
      process.env.GATEWAY_HOST = 'api.example.com';
      loadConfig();
      expect(config.host).toBe('api.example.com');
    });

    it('should use default host for empty string', () => {
      process.env.GATEWAY_HOST = '';
      loadConfig();
      expect(config.host).toBe('localhost');
    });
  });

  describe('Environment Variable Loading - Database', () => {
    it('should load DATABASE_PATH from environment', () => {
      process.env.DATABASE_PATH = '/custom/path/database.db';
      loadConfig();
      expect(config.database.path).toBe('/custom/path/database.db');
    });

    it('should load DATABASE_TYPE from environment', () => {
      process.env.DATABASE_TYPE = 'postgres';
      loadConfig();
      expect(config.database.type).toBe('postgres');
    });

    it('should use default database type for invalid type', () => {
      process.env.DATABASE_TYPE = 'invalid';
      loadConfig();
      expect(config.database.type).toBe('sqlite');
    });

    it('should support sqlite database type', () => {
      process.env.DATABASE_TYPE = 'sqlite';
      loadConfig();
      expect(config.database.type).toBe('sqlite');
    });

    it('should support postgres database type', () => {
      process.env.DATABASE_TYPE = 'postgres';
      loadConfig();
      expect(config.database.type).toBe('postgres');
    });
  });

  describe('Environment Variable Loading - Secrets', () => {
    it('should load HMAC_SECRET from environment', () => {
      process.env.HMAC_SECRET = 'test-hmac-secret';
      loadConfig();
      expect(config.secrets.hmac).toBe('test-hmac-secret');
    });

    it('should load JWT_SECRET from environment', () => {
      process.env.JWT_SECRET = 'test-jwt-secret';
      loadConfig();
      expect(config.secrets.jwt).toBe('test-jwt-secret');
    });

    it('should load SESSION_SECRET from environment', () => {
      process.env.SESSION_SECRET = 'test-session-secret';
      loadConfig();
      expect(config.secrets.session).toBe('test-session-secret');
    });

    it('should generate random secret when HMAC_SECRET not provided', () => {
      delete process.env.HMAC_SECRET;
      loadConfig();
      expect(config.secrets.hmac).toBeTruthy();
      expect(typeof config.secrets.hmac).toBe('string');
      expect(config.secrets.hmac.length).toBeGreaterThan(0);
    });

    it('should generate random secret when JWT_SECRET not provided', () => {
      delete process.env.JWT_SECRET;
      loadConfig();
      expect(config.secrets.jwt).toBeTruthy();
      expect(typeof config.secrets.jwt).toBe('string');
      expect(config.secrets.jwt.length).toBeGreaterThan(0);
    });

    it('should generate random secret when SESSION_SECRET not provided', () => {
      delete process.env.SESSION_SECRET;
      loadConfig();
      expect(config.secrets.session).toBeTruthy();
      expect(typeof config.secrets.session).toBe('string');
      expect(config.secrets.session.length).toBeGreaterThan(0);
    });
  });

  describe('Environment Variable Loading - CORS', () => {
    it('should load CORS_ORIGIN from environment', () => {
      process.env.CORS_ORIGIN = 'https://example.com';
      loadConfig();
      expect(config.cors.origin).toBe('https://example.com');
    });

    it('should parse multiple CORS origins', () => {
      process.env.CORS_ORIGIN = 'https://example.com,https://app.example.com';
      loadConfig();
      expect(Array.isArray(config.cors.origin)).toBe(true);
      expect(config.cors.origin).toContain('https://example.com');
      expect(config.cors.origin).toContain('https://app.example.com');
    });

    it('should use wildcard for empty CORS origin', () => {
      process.env.CORS_ORIGIN = '';
      loadConfig();
      expect(config.cors.origin).toBe('*');
    });
  });

  describe('Environment Variable Loading - Rate Limit', () => {
    it('should load RATE_LIMIT_MAX from environment', () => {
      process.env.RATE_LIMIT_MAX = '200';
      loadConfig();
      expect(config.rateLimit.max).toBe(200);
    });

    it('should load RATE_LIMIT_WINDOW from environment', () => {
      process.env.RATE_LIMIT_WINDOW = '120000';
      loadConfig();
      expect(config.rateLimit.windowMs).toBe(120000);
    });

    it('should parse RATE_LIMIT_MAX as integer', () => {
      process.env.RATE_LIMIT_MAX = '500';
      loadConfig();
      expect(typeof config.rateLimit.max).toBe('number');
      expect(config.rateLimit.max).toBe(500);
    });

    it('should use default max for invalid rate limit', () => {
      process.env.RATE_LIMIT_MAX = 'invalid';
      loadConfig();
      expect(config.rateLimit.max).toBe(100);
    });

    it('should use default window for invalid rate limit window', () => {
      process.env.RATE_LIMIT_WINDOW = 'invalid';
      loadConfig();
      expect(config.rateLimit.windowMs).toBe(60000);
    });
  });

  describe('Environment Variable Loading - Log Level', () => {
    it('should load LOG_LEVEL from environment', () => {
      process.env.LOG_LEVEL = 'debug';
      loadConfig();
      expect(config.logLevel).toBe('debug');
    });

    it('should support error log level', () => {
      process.env.LOG_LEVEL = 'error';
      loadConfig();
      expect(config.logLevel).toBe('error');
    });

    it('should support warn log level', () => {
      process.env.LOG_LEVEL = 'warn';
      loadConfig();
      expect(config.logLevel).toBe('warn');
    });

    it('should support info log level', () => {
      process.env.LOG_LEVEL = 'info';
      loadConfig();
      expect(config.logLevel).toBe('info');
    });

    it('should use default info for invalid log level', () => {
      process.env.LOG_LEVEL = 'invalid';
      loadConfig();
      expect(config.logLevel).toBe('info');
    });

    it('should be case insensitive for log level', () => {
      process.env.LOG_LEVEL = 'DEBUG';
      loadConfig();
      expect(config.logLevel).toBe('debug');
    });
  });

  describe('Environment Variable Loading - Upload Settings', () => {
    it('should load MAX_FILE_SIZE from environment', () => {
      process.env.MAX_FILE_SIZE = '52428800'; // 50MB
      loadConfig();
      expect(config.upload.maxFileSize).toBe(52428800);
    });

    it('should load UPLOAD_DIR from environment', () => {
      process.env.UPLOAD_DIR = '/tmp/uploads';
      loadConfig();
      expect(config.upload.directory).toBe('/tmp/uploads');
    });

    it('should parse MAX_FILE_SIZE as bytes', () => {
      process.env.MAX_FILE_SIZE = '1048576'; // 1MB
      loadConfig();
      expect(config.upload.maxFileSize).toBe(1048576);
    });

    it('should use default max file size for invalid value', () => {
      process.env.MAX_FILE_SIZE = 'invalid';
      loadConfig();
      expect(config.upload.maxFileSize).toBe(10 * 1024 * 1024);
    });

    it('should use default upload directory for empty path', () => {
      process.env.UPLOAD_DIR = '';
      loadConfig();
      expect(config.upload.directory).toBe('./uploads');
    });
  });

  describe('Environment Variable Loading - Environment', () => {
    it('should load NODE_ENV from environment', () => {
      process.env.NODE_ENV = 'production';
      loadConfig();
      expect(config.env).toBe('production');
    });

    it('should load NODE_ENV as test', () => {
      process.env.NODE_ENV = 'test';
      loadConfig();
      expect(config.env).toBe('test');
    });

    it('should use default development for invalid environment', () => {
      process.env.NODE_ENV = 'invalid';
      loadConfig();
      expect(config.env).toBe('development');
    });

    it('should be case insensitive for NODE_ENV', () => {
      process.env.NODE_ENV = 'PRODUCTION';
      loadConfig();
      expect(config.env).toBe('production');
    });
  });

  describe('Environment Variable Loading - API Key', () => {
    it('should load API_KEY from environment', () => {
      process.env.API_KEY = 'test-api-key-123';
      loadConfig();
      expect(config.apiKey).toBe('test-api-key-123');
    });

    it('should be undefined when API_KEY not set', () => {
      delete process.env.API_KEY;
      loadConfig();
      expect(config.apiKey).toBeUndefined();
    });

    it('should be empty string when API_KEY is empty', () => {
      process.env.API_KEY = '';
      loadConfig();
      expect(config.apiKey).toBe('');
    });
  });

  describe('Environment Variable Loading - Metrics', () => {
    it('should load ENABLE_METRICS from environment', () => {
      process.env.ENABLE_METRICS = 'true';
      loadConfig();
      expect(config.metrics.enabled).toBe(true);
    });

    it('should load ENABLE_METRICS as false', () => {
      process.env.ENABLE_METRICS = 'false';
      loadConfig();
      expect(config.metrics.enabled).toBe(false);
    });

    it('should parse ENABLE_METRICS boolean', () => {
      process.env.ENABLE_METRICS = '1';
      loadConfig();
      expect(config.metrics.enabled).toBe(true);
    });

    it('should load METRICS_PORT from environment', () => {
      process.env.METRICS_PORT = '9091';
      loadConfig();
      expect(config.metrics.port).toBe(9091);
    });

    it('should use default enabled for invalid ENABLE_METRICS', () => {
      process.env.ENABLE_METRICS = 'invalid';
      loadConfig();
      expect(config.metrics.enabled).toBe(false);
    });
  });

  describe('Validation', () => {
    it('should validate port is number', () => {
      process.env.GATEWAY_PORT = '3000';
      loadConfig();
      expect(typeof config.port).toBe('number');
      expect(Number.isInteger(config.port)).toBe(true);
    });

    it('should validate port is within valid range', () => {
      process.env.GATEWAY_PORT = '8080';
      loadConfig();
      expect(config.port).toBeGreaterThanOrEqual(0);
      expect(config.port).toBeLessThanOrEqual(65535);
    });

    it('should validate database type is supported', () => {
      const supportedTypes = ['sqlite', 'postgres'];
      process.env.DATABASE_TYPE = 'postgres';
      loadConfig();
      expect(supportedTypes).toContain(config.database.type);
    });

    it('should validate log level is valid', () => {
      const validLevels = ['error', 'warn', 'info', 'debug'];
      process.env.LOG_LEVEL = 'warn';
      loadConfig();
      expect(validLevels).toContain(config.logLevel);
    });

    it('should validate environment is valid', () => {
      const validEnvs = ['development', 'production', 'test'];
      process.env.NODE_ENV = 'production';
      loadConfig();
      expect(validEnvs).toContain(config.env);
    });

    it('should validate max file size is positive', () => {
      loadConfig();
      expect(config.upload.maxFileSize).toBeGreaterThan(0);
    });

    it('should validate rate limit max is positive', () => {
      loadConfig();
      expect(config.rateLimit.max).toBeGreaterThan(0);
    });

    it('should validate rate limit window is positive', () => {
      loadConfig();
      expect(config.rateLimit.windowMs).toBeGreaterThan(0);
    });

    it('should validate metrics port is number', () => {
      loadConfig();
      expect(typeof config.metrics.port).toBe('number');
    });

    it('should validate metrics port is within valid range', () => {
      loadConfig();
      expect(config.metrics.port).toBeGreaterThanOrEqual(0);
      expect(config.metrics.port).toBeLessThanOrEqual(65535);
    });
  });

  describe('Config Reload', () => {
    it('should reload config when loadConfig is called', () => {
      process.env.GATEWAY_PORT = '4000';
      expect(config.port).toBe(3000); // Still default
      loadConfig();
      expect(config.port).toBe(4000); // Updated
    });

    it('should persist changes across multiple loads', () => {
      process.env.GATEWAY_PORT = '5000';
      loadConfig();
      expect(config.port).toBe(5000);
      
      process.env.GATEWAY_PORT = '6000';
      loadConfig();
      expect(config.port).toBe(6000);
    });

    it('should reset to defaults when env vars are cleared', () => {
      process.env.GATEWAY_PORT = '7000';
      loadConfig();
      expect(config.port).toBe(7000);
      
      delete process.env.GATEWAY_PORT;
      loadConfig();
      expect(config.port).toBe(3000);
    });
  });

  describe('Path Resolution', () => {
    it('should resolve relative paths', () => {
      const resolved = resolvePath('./data/test.db');
      expect(resolved).toContain('/data/test.db');
    });

    it('should resolve absolute paths', () => {
      const absolutePath = '/tmp/test.db';
      const resolved = resolvePath(absolutePath);
      expect(resolved).toBe(absolutePath);
    });

    it('should handle paths with ..', () => {
      const resolved = resolvePath('../config/test.json');
      expect(resolved).toBeTruthy();
      expect(typeof resolved).toBe('string');
    });

    it('should handle paths with ~ expansion', () => {
      const resolved = resolvePath('~/config/test.json');
      expect(resolved).toBeTruthy();
      expect(resolved).not.toContain('~');
    });

    it('should normalize path separators', () => {
      const resolved = resolvePath('data//test.db');
      expect(resolved).not.toContain('//');
    });
  });

  describe('Production Mode', () => {
    it('should set production mode from NODE_ENV', () => {
      process.env.NODE_ENV = 'production';
      loadConfig();
      expect(config.env).toBe('production');
      expect(config.isProduction).toBe(true);
    });

    it('should set development mode by default', () => {
      delete process.env.NODE_ENV;
      loadConfig();
      expect(config.env).toBe('development');
      expect(config.isProduction).toBe(false);
    });

    it('should set test mode', () => {
      process.env.NODE_ENV = 'test';
      loadConfig();
      expect(config.env).toBe('test');
      expect(config.isProduction).toBe(false);
    });

    it('should not be production in development', () => {
      process.env.NODE_ENV = 'development';
      loadConfig();
      expect(config.isProduction).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle whitespace in environment variables', () => {
      process.env.GATEWAY_HOST = '  localhost  ';
      loadConfig();
      expect(config.host).toBe('localhost');
    });

    it('should handle null environment values', () => {
      process.env.GATEWAY_PORT = null as any;
      loadConfig();
      expect(config.port).toBe(3000);
    });

    it('should handle undefined environment values', () => {
      process.env.GATEWAY_PORT = undefined as any;
      loadConfig();
      expect(config.port).toBe(3000);
    });

    it('should handle extremely large port numbers', () => {
      process.env.GATEWAY_PORT = '999999999';
      loadConfig();
      expect(config.port).toBe(3000); // Falls back to default
    });

    it('should handle zero as valid port', () => {
      process.env.GATEWAY_PORT = '0';
      loadConfig();
      expect(config.port).toBe(0);
    });

    it('should handle zero as valid rate limit', () => {
      process.env.RATE_LIMIT_MAX = '0';
      loadConfig();
      expect(config.rateLimit.max).toBe(0);
    });

    it('should handle CORS origin with spaces', () => {
      process.env.CORS_ORIGIN = 'https://example.com , https://app.example.com';
      loadConfig();
      expect(Array.isArray(config.cors.origin)).toBe(true);
    });
  });

  describe('Configuration Object Structure', () => {
    it('should have all expected top-level properties', () => {
      expect(config).toHaveProperty('port');
      expect(config).toHaveProperty('host');
      expect(config).toHaveProperty('database');
      expect(config).toHaveProperty('secrets');
      expect(config).toHaveProperty('cors');
      expect(config).toHaveProperty('rateLimit');
      expect(config).toHaveProperty('upload');
      expect(config).toHaveProperty('metrics');
      expect(config).toHaveProperty('logLevel');
      expect(config).toHaveProperty('env');
      expect(config).toHaveProperty('isProduction');
    });

    it('should have nested database properties', () => {
      expect(config.database).toHaveProperty('path');
      expect(config.database).toHaveProperty('type');
    });

    it('should have nested secrets properties', () => {
      expect(config.secrets).toHaveProperty('hmac');
      expect(config.secrets).toHaveProperty('jwt');
      expect(config.secrets).toHaveProperty('session');
    });

    it('should have nested cors properties', () => {
      expect(config.cors).toHaveProperty('origin');
    });

    it('should have nested rateLimit properties', () => {
      expect(config.rateLimit).toHaveProperty('max');
      expect(config.rateLimit).toHaveProperty('windowMs');
    });

    it('should have nested upload properties', () => {
      expect(config.upload).toHaveProperty('maxFileSize');
      expect(config.upload).toHaveProperty('directory');
    });

    it('should have nested metrics properties', () => {
      expect(config.metrics).toHaveProperty('enabled');
      expect(config.metrics).toHaveProperty('port');
    });
  });

  describe('Integration Tests', () => {
    it('should load complete configuration from environment', () => {
      process.env.GATEWAY_PORT = '4000';
      process.env.GATEWAY_HOST = '0.0.0.0';
      process.env.DATABASE_PATH = '/data/app.db';
      process.env.DATABASE_TYPE = 'postgres';
      process.env.HMAC_SECRET = 'hmac-secret';
      process.env.JWT_SECRET = 'jwt-secret';
      process.env.SESSION_SECRET = 'session-secret';
      process.env.CORS_ORIGIN = 'https://app.example.com';
      process.env.RATE_LIMIT_MAX = '200';
      process.env.RATE_LIMIT_WINDOW = '120000';
      process.env.LOG_LEVEL = 'debug';
      process.env.NODE_ENV = 'production';
      process.env.MAX_FILE_SIZE = '52428800';
      process.env.UPLOAD_DIR = '/uploads';
      process.env.API_KEY = 'api-key-123';
      process.env.ENABLE_METRICS = 'true';
      process.env.METRICS_PORT = '9091';

      loadConfig();

      expect(config.port).toBe(4000);
      expect(config.host).toBe('0.0.0.0');
      expect(config.database.path).toBe('/data/app.db');
      expect(config.database.type).toBe('postgres');
      expect(config.secrets.hmac).toBe('hmac-secret');
      expect(config.secrets.jwt).toBe('jwt-secret');
      expect(config.secrets.session).toBe('session-secret');
      expect(config.cors.origin).toBe('https://app.example.com');
      expect(config.rateLimit.max).toBe(200);
      expect(config.rateLimit.windowMs).toBe(120000);
      expect(config.logLevel).toBe('debug');
      expect(config.env).toBe('production');
      expect(config.upload.maxFileSize).toBe(52428800);
      expect(config.upload.directory).toBe('/uploads');
      expect(config.apiKey).toBe('api-key-123');
      expect(config.metrics.enabled).toBe(true);
      expect(config.metrics.port).toBe(9091);
    });

    it('should use defaults when no environment variables are set', () => {
      // All env vars cleared in beforeEach
      loadConfig();

      expect(config.port).toBe(3000);
      expect(config.host).toBe('localhost');
      expect(config.database.path).toBe('./data/gateway.db');
      expect(config.database.type).toBe('sqlite');
      expect(config.logLevel).toBe('info');
      expect(config.cors.origin).toBe('*');
      expect(config.rateLimit.max).toBe(100);
      expect(config.rateLimit.windowMs).toBe(60000);
      expect(config.env).toBe('development');
      expect(config.upload.maxFileSize).toBe(10 * 1024 * 1024);
      expect(config.upload.directory).toBe('./uploads');
      expect(config.metrics.enabled).toBe(false);
      expect(config.metrics.port).toBe(9090);
    });

    it('should handle partial environment configuration', () => {
      process.env.GATEWAY_PORT = '5000';
      process.env.LOG_LEVEL = 'error';
      // Others use defaults

      loadConfig();

      expect(config.port).toBe(5000);
      expect(config.logLevel).toBe('error');
      expect(config.host).toBe('localhost');
      expect(config.database.type).toBe('sqlite');
      expect(config.env).toBe('development');
    });
  });
});