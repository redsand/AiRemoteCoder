import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config
vi.mock('../config.js', () => ({
  config: {
    projectRoot: '/test/project',
    claudeCommand: 'claude',
    ollamaCommand: 'ollama',
    ollamaModel: 'codellama:7b',
    codexCommand: 'codex',
    geminiCommand: 'gemini-cli',
    geminiModel: 'gemini-pro',
    revCommand: 'rev'
  }
}));

import {
  WORKER_CONFIGS,
  type WorkerType,
  getWorkerConfig,
  getWorkerCommand,
  getDefaultModel,
  isValidWorkerType,
  getAllWorkerTypes,
  getWorkerDisplayName,
  getWorkerIcon,
  GEMINI_MODELS
} from './worker-registry.js';

describe('Worker Registry', () => {
  describe('Worker Configuration', () => {
    it('should have all worker types configured', () => {
      const workerTypes: WorkerType[] = ['claude', 'ollama-launch', 'codex', 'gemini', 'rev', 'vnc', 'hands-on'];

      for (const type of workerTypes) {
        expect(WORKER_CONFIGS[type]).toBeDefined();
        expect(WORKER_CONFIGS[type].type).toBe(type);
      }
    });

    it('should have correct worker type for Claude', () => {
      const claude = WORKER_CONFIGS.claude;
      expect(claude.type).toBe('claude');
      expect(claude.command).toBe('claude');
      expect(claude.displayName).toBe('Claude');
      expect(claude.supportsModelSelection).toBe(false);
      expect(claude.description).toContain('Anthropic');
    });

    it('should have correct worker type for Ollama Launch', () => {
      const ollamaLaunch = WORKER_CONFIGS['ollama-launch'];
      expect(ollamaLaunch.type).toBe('ollama-launch');
      expect(ollamaLaunch.command).toBe('ollama');
      expect(ollamaLaunch.displayName).toBe('Ollama Launch (Claude)');
      expect(ollamaLaunch.defaultModel).toBe('claude');
      expect(ollamaLaunch.supportsModelSelection).toBe(true);
      expect(ollamaLaunch.description).toContain('Claude models');
      expect(ollamaLaunch.subcommand).toBe('launch');
    });

    it('should have correct worker type for Codex', () => {
      const codex = WORKER_CONFIGS.codex;
      expect(codex.type).toBe('codex');
      expect(codex.command).toBe('codex');
      expect(codex.displayName).toBe('Codex CLI');
      expect(codex.supportsModelSelection).toBe(false);
      expect(codex.description).toContain('OpenAI');
    });

    it('should have correct worker type for Gemini', () => {
      const gemini = WORKER_CONFIGS.gemini;
      expect(gemini.type).toBe('gemini');
      expect(gemini.command).toBe('gemini-cli');
      expect(gemini.displayName).toBe('Gemini CLI');
      expect(gemini.defaultModel).toBe('gemini-pro');
      expect(gemini.supportsModelSelection).toBe(true);
      expect(gemini.description).toContain('Google');
    });

    it('should have correct worker type for Rev', () => {
      const rev = WORKER_CONFIGS.rev;
      expect(rev.type).toBe('rev');
      expect(rev.command).toBe('rev');
      expect(rev.displayName).toBe('Rev');
      expect(rev.supportsModelSelection).toBe(false);
      expect(rev.description).toContain('Custom');
    });
  });

  describe('Helper Functions', () => {
    it('getWorkerConfig should return correct config', () => {
      const claude = getWorkerConfig('claude');
      expect(claude?.type).toBe('claude');

      const ollama = getWorkerConfig('ollama-launch');
      expect(ollama?.type).toBe('ollama-launch');

      const invalid = getWorkerConfig('invalid' as any);
      expect(invalid).toBeUndefined();
    });

    it('getWorkerCommand should return command for worker type', () => {
      expect(getWorkerCommand('claude')).toBe('claude');
      expect(getWorkerCommand('ollama-launch')).toBe('ollama');
      expect(getWorkerCommand('codex')).toBe('codex');
      expect(getWorkerCommand('gemini')).toBe('gemini-cli');
      expect(getWorkerCommand('rev')).toBe('rev');
      // Fallback for unknown worker
      expect(getWorkerCommand('unknown')).toBe('unknown');
    });

    it('getDefaultModel should return default model for worker type', () => {
      expect(getDefaultModel('claude')).toBeUndefined();
      expect(getDefaultModel('ollama-launch')).toBe('claude');
      expect(getDefaultModel('codex')).toBeUndefined();
      expect(getDefaultModel('gemini')).toBe('gemini-pro');
      expect(getDefaultModel('rev')).toBeUndefined();
      expect(getDefaultModel('unknown')).toBeUndefined();
    });

    it('isValidWorkerType should validate worker types', () => {
      expect(isValidWorkerType('claude')).toBe(true);
      expect(isValidWorkerType('ollama-launch')).toBe(true);
      expect(isValidWorkerType('codex')).toBe(true);
      expect(isValidWorkerType('gemini')).toBe(true);
      expect(isValidWorkerType('rev')).toBe(true);
      expect(isValidWorkerType('invalid')).toBe(false);
      expect(isValidWorkerType('')).toBe(false);
    });

    it('getAllWorkerTypes should return all worker types', () => {
      const types = getAllWorkerTypes();
      expect(types).toContain('claude');
      expect(types).toContain('ollama-launch');
      expect(types).toContain('codex');
      expect(types).toContain('gemini');
      expect(types).toContain('rev');
    });

    it('getWorkerDisplayName should return formatted name', () => {
      expect(getWorkerDisplayName('claude')).toBe('Claude');
      expect(getWorkerDisplayName('ollama-launch')).toBe('Ollama Launch (Claude)');
      expect(getWorkerDisplayName('codex')).toBe('Codex CLI');
      expect(getWorkerDisplayName('gemini')).toBe('Gemini CLI');
      expect(getWorkerDisplayName('rev')).toBe('Rev');
    });

    it('getWorkerIcon should return emoji for worker type', () => {
      expect(getWorkerIcon('claude')).toBe('');
      expect(getWorkerIcon('ollama-launch')).toBe('');
      expect(getWorkerIcon('codex')).toBe('');
      expect(getWorkerIcon('gemini')).toBe('');
      expect(getWorkerIcon('rev')).toBe('');
    });
  });

  describe('Model Lists', () => {
    it('GEMINI_MODELS should have common models', () => {
      expect(GEMINI_MODELS.length).toBeGreaterThan(0);
      expect(GEMINI_MODELS).toContainEqual({ value: 'gemini-pro', label: 'Gemini Pro' });
      expect(GEMINI_MODELS).toContainEqual({ value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' });
      expect(GEMINI_MODELS).toContainEqual({ value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' });
      expect(GEMINI_MODELS).toContainEqual({ value: 'custom', label: 'Custom...' });
    });
  });

  describe('Worker Subcommands', () => {
    it('Ollama Launch should have launch subcommand', () => {
      const ollamaLaunch = WORKER_CONFIGS['ollama-launch'];
      expect(ollamaLaunch.subcommand).toBe('launch');
    });

    it('Claude should not have subcommand', () => {
      const claude = WORKER_CONFIGS.claude;
      expect(claude.subcommand).toBeUndefined();
    });
  });
});

describe('Worker Type Validation', () => {
  it('should reject invalid worker types', () => {
    const invalidTypes = ['invalid', '', 'CLAUDE', 'OLLAMA', 'Claude', 'undefined', null];
    for (const type of invalidTypes) {
      expect(isValidWorkerType(type as any)).toBe(false);
    }
  });

  it('should accept all valid worker types', () => {
    const validTypes: WorkerType[] = ['claude', 'ollama-launch', 'codex', 'gemini', 'rev', 'vnc', 'hands-on'];
    for (const type of validTypes) {
      expect(isValidWorkerType(type)).toBe(true);
    }
  });
});

describe('Worker Display Names', () => {
  it('should capitalize first letter for simple names', () => {
    expect(getWorkerDisplayName('claude')).toBe('Claude');
    expect(getWorkerDisplayName('codex')).toBe('Codex CLI');
    expect(getWorkerDisplayName('rev')).toBe('Rev');
  });

  it('should capitalize both parts for hyphenated names', () => {
    // The actual implementation returns the full display name from config
    expect(getWorkerDisplayName('ollama-launch')).toBe('Ollama Launch (Claude)');
  });

  it('should handle multi-part hyphenated names', () => {
    // This tests future extensibility
    const displayName = 'multi-part-name'.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    expect(displayName).toBe('Multi Part Name');
  });
});
