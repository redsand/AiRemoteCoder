import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { healthRoutes } from './health.js';

vi.mock('../services/websocket.js', () => ({
  getConnectionStats: vi.fn(() => ({
    websocketConnections: 2,
    vncConnections: 1,
  })),
}));

describe('routes/health', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(healthRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the current health payload', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      connections: {
        websocketConnections: 2,
        vncConnections: 1,
      },
    });
    expect(new Date(res.json().timestamp).toISOString()).toBe(res.json().timestamp);
  });
});
