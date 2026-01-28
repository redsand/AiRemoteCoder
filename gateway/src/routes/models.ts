import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

interface ModelOption {
  value: string;
  label: string;
}

interface ModelsResponse {
  provider: string;
  models: ModelOption[];
  available: boolean;
  error?: string;
}


/**
 * Query Claude API for available models
 */
async function getClaudeModels(): Promise<ModelOption[]> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return [];
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`Claude API error: ${response.statusText}`);
      return [];
    }

    const data = (await response.json()) as {
      data?: Array<{ id: string; display_name?: string }>;
    };

    if (!data.data || data.data.length === 0) {
      return [];
    }

    const models = data.data
      .filter((m) => m.id.includes('claude'))
      .map((m) => ({
        value: m.id,
        label: m.display_name || m.id,
      }));

    return models;
  } catch (err) {
    console.warn('Failed to query Claude models:', err);
    return [];
  }
}

/**
 * Query OpenAI API for available models (Codex)
 */
async function getCodexModels(): Promise<ModelOption[]> {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return [];
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch('https://api.openai.com/v1/models', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`OpenAI API error: ${response.statusText}`);
      return [];
    }

    const data = (await response.json()) as {
      data?: Array<{ id: string }>;
    };

    if (!data.data || data.data.length === 0) {
      return [];
    }

    const models = data.data
      .filter((m) => m.id.includes('code') || m.id.includes('davinci'))
      .map((m) => ({
        value: m.id,
        label: m.id,
      }));

    return models;
  } catch (err) {
    console.warn('Failed to query OpenAI models:', err);
    return [];
  }
}

/**
 * Query Google AI API for available models (Gemini)
 */
async function getGeminiModels(): Promise<ModelOption[]> {
  try {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      return [];
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`Google AI API error: ${response.statusText}`);
      return [];
    }

    const data = (await response.json()) as {
      models?: Array<{ name: string; displayName?: string }>;
    };

    if (!data.models || data.models.length === 0) {
      return [];
    }

    const models = data.models
      .filter((m) => m.name.includes('gemini'))
      .map((m) => ({
        value: m.name.replace('models/', ''),
        label: m.displayName || m.name,
      }));

    return models;
  } catch (err) {
    console.warn('Failed to query Gemini models:', err);
    return [];
  }
}

/**
 * Get default/static models for providers
 */
function getDefaultModels(provider: string): ModelOption[] {
  const defaults: Record<string, ModelOption[]> = {
    claude: [
      { value: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
      { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ],
    codex: [
      { value: 'code-davinci-003', label: 'Code Davinci 003' },
      { value: 'code-davinci-002', label: 'Code Davinci 002' },
    ],
    gemini: [
      { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
      { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
    ],
  };

  return defaults[provider] || [];
}

export async function modelsRoutes(fastify: FastifyInstance) {
  /**
   * Get available models for a specific provider
   * GET /api/models/:provider
   */
  fastify.get('/api/models/:provider', async (request, reply) => {
    const { provider } = request.params as { provider: string };

    let models: ModelOption[] = [];
    let available = false;
    let error: string | undefined;

    switch (provider.toLowerCase()) {
      case 'claude':
        models = await getClaudeModels();
        available = models.length > 0;
        if (!available) {
          models = getDefaultModels('claude');
          error = 'ANTHROPIC_API_KEY not set or API unreachable, showing default models';
        }
        break;

      case 'codex':
        models = await getCodexModels();
        available = models.length > 0;
        if (!available) {
          models = getDefaultModels('codex');
          error = 'OPENAI_API_KEY not set or API unreachable, showing default models';
        }
        break;

      case 'gemini':
        models = await getGeminiModels();
        available = models.length > 0;
        if (!available) {
          models = getDefaultModels('gemini');
          error = 'GOOGLE_API_KEY not set or API unreachable, showing default models';
        }
        break;

      default:
        return reply.code(400).send({
          error: `Unknown provider: ${provider}. Supported: ollama, claude, codex, gemini`,
        });
    }

    const response: ModelsResponse = {
      provider,
      models,
      available,
      ...(error && { error }),
    };

    return response;
  });

  /**
   * Get all available models from all providers
   * GET /api/models
   */
  fastify.get('/api/models', async (request, reply) => {
    const providers = ['claude', 'codex', 'gemini'];
    const allModels: Record<string, ModelsResponse> = {};

    for (const provider of providers) {
      let models: ModelOption[] = [];
      let available = false;
      let error: string | undefined;

      switch (provider) {
        case 'claude':
          models = await getClaudeModels();
          available = models.length > 0;
          if (!available) {
            models = getDefaultModels('claude');
            error = 'ANTHROPIC_API_KEY not set or API unreachable';
          }
          break;

        case 'codex':
          models = await getCodexModels();
          available = models.length > 0;
          if (!available) {
            models = getDefaultModels('codex');
            error = 'OPENAI_API_KEY not set or API unreachable';
          }
          break;

        case 'gemini':
          models = await getGeminiModels();
          available = models.length > 0;
          if (!available) {
            models = getDefaultModels('gemini');
            error = 'GOOGLE_API_KEY not set or API unreachable';
          }
          break;
      }

      allModels[provider] = {
        provider,
        models,
        available,
        ...(error && { error }),
      };
    }

    return allModels;
  });
}
