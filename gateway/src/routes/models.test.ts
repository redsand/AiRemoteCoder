import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { modelsRoutes } from './models.js';

describe('routes/models', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(modelsRoutes);
    await app.ready();
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-test');
    vi.stubEnv('OPENAI_API_KEY', 'openai-test');
    vi.stubEnv('GOOGLE_API_KEY', 'google-test');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await app.close();
  });

  it('returns provider-specific models', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('anthropic')) {
        return {
          ok: true,
          json: async () => ({ data: [{ id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' }] }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    }));

    const res = await app.inject({ method: 'GET', url: '/api/models/claude' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      provider: 'claude',
      available: true,
    });
  });

  it('falls back to defaults when provider APIs are unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, statusText: 'unavailable', json: async () => ({}) } as any)));

    const res = await app.inject({ method: 'GET', url: '/api/models/codex' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { available: boolean; models: Array<{ value: string }> };
    expect(body.available).toBe(false);
    expect(body.models.length).toBeGreaterThan(0);
  });

  it('returns all providers and rejects unknown providers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, statusText: 'unavailable', json: async () => ({}) } as any)));

    const allRes = await app.inject({ method: 'GET', url: '/api/models' });
    expect(allRes.statusCode).toBe(200);
    expect(Object.keys(allRes.json() as object)).toEqual(expect.arrayContaining(['claude', 'codex', 'gemini']));

    const badRes = await app.inject({ method: 'GET', url: '/api/models/unknown' });
    expect(badRes.statusCode).toBe(400);
  });
});
