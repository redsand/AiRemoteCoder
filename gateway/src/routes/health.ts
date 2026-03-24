import type { FastifyInstance } from 'fastify';
import { getConnectionStats } from '../services/websocket.js';

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/api/health', async () => {
    const stats = getConnectionStats();
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      connections: stats,
    };
  });
}
