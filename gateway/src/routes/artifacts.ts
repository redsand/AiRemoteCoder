import type { FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, createReadStream } from 'fs';
import { db } from '../services/database.js';
import { config } from '../config.js';
import { uiAuth, type AuthenticatedRequest } from '../middleware/auth.js';

export async function artifactRoutes(fastify: FastifyInstance) {
  // Ensure artifacts directory exists
  if (!existsSync(config.artifactsDir)) {
    mkdirSync(config.artifactsDir, { recursive: true });
  }

  // List artifacts for a run
  fastify.get('/api/runs/:runId/artifacts', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const { runId } = request.params as { runId: string };

    const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(runId);
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    const artifacts = db.prepare(`
      SELECT id, name, type, size, created_at
      FROM artifacts WHERE run_id = ?
      ORDER BY created_at DESC
    `).all(runId);

    return artifacts;
  });

  // Download artifact
  fastify.get('/api/artifacts/:artifactId', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const { artifactId } = request.params as { artifactId: string };

    const artifact = db.prepare(`
      SELECT id, name, type, size, path
      FROM artifacts WHERE id = ?
    `).get(artifactId) as any;

    if (!artifact) {
      return reply.code(404).send({ error: 'Artifact not found' });
    }

    if (!existsSync(artifact.path)) {
      return reply.code(404).send({ error: 'Artifact file not found' });
    }

    // Set appropriate headers
    const mimeTypes: Record<string, string> = {
      log: 'text/plain',
      text: 'text/plain',
      json: 'application/json',
      diff: 'text/x-diff',
      patch: 'text/x-diff',
      markdown: 'text/markdown',
      file: 'application/octet-stream'
    };

    reply.header('Content-Type', mimeTypes[artifact.type] || 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${artifact.name}"`);
    reply.header('Content-Length', artifact.size);

    return reply.send(createReadStream(artifact.path));
  });

  // Delete artifact
  fastify.delete('/api/artifacts/:artifactId', {
    preHandler: [uiAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const { artifactId } = request.params as { artifactId: string };

    const artifact = db.prepare('SELECT id, path FROM artifacts WHERE id = ?').get(artifactId) as any;
    if (!artifact) {
      return reply.code(404).send({ error: 'Artifact not found' });
    }

    // Delete file if exists
    if (existsSync(artifact.path)) {
      const { unlink } = await import('fs/promises');
      await unlink(artifact.path);
    }

    // Delete from database
    db.prepare('DELETE FROM artifacts WHERE id = ?').run(artifactId);

    return { ok: true };
  });
}
