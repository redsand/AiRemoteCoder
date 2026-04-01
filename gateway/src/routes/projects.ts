import type { FastifyInstance } from 'fastify';
import { db } from '../services/database.js';
import { uiAuth } from '../middleware/auth.js';

export async function projectsRoutes(fastify: FastifyInstance) {
  fastify.get('/api/projects', {
    preHandler: [uiAuth],
    handler: async (_request, _reply) => {
      // Group runs by repo_path (or fall back to event_cwd from events)
      const rows = db.prepare(`
        SELECT
          COALESCE(r.repo_path,
            (SELECT json_extract(e.data, '$.params.thread.cwd')
             FROM events e WHERE e.run_id = r.id AND e.type = 'info' AND e.data LIKE '%thread/started%'
             ORDER BY e.id LIMIT 1)
          ) as path,
          COUNT(*) as total_runs,
          SUM(CASE WHEN r.status = 'running' THEN 1 ELSE 0 END) as running_runs,
          SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) as failed_runs,
          MAX(r.created_at) as last_active
        FROM runs r
        GROUP BY path
        HAVING path IS NOT NULL
        ORDER BY last_active DESC
      `).all() as { path: string; total_runs: number; running_runs: number; failed_runs: number; last_active: number }[];

      const projects = rows.map(r => ({
        path: r.path,
        display: r.path,
        totalRuns: r.total_runs,
        runningRuns: r.running_runs,
        failedRuns: r.failed_runs,
        lastActive: r.last_active,
      }));

      return { projects };
    },
  });
}
