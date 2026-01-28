import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { createWriteStream, existsSync, mkdirSync, statSync, createReadStream } from 'fs';
import { join, basename } from 'path';
import { pipeline } from 'stream/promises';
import { db } from '../services/database.js';
import { config } from '../config.js';
import { wrapperAuth, uiAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { broadcastToRun } from '../services/websocket.js';

export async function artifactRoutes(fastify: FastifyInstance) {
  // Ensure artifacts directory exists
  if (!existsSync(config.artifactsDir)) {
    mkdirSync(config.artifactsDir, { recursive: true });
  }

  // Wrapper: upload artifact
  fastify.post('/api/ingest/artifact', {
    preHandler: [wrapperAuth]
  }, async (request: AuthenticatedRequest, reply) => {
    const runId = request.runAuth?.runId;
    if (!runId) {
      return reply.code(400).send({ error: 'Run ID required' });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: 'No file uploaded' });
    }

    // Validate file size
    const contentLength = parseInt(request.headers['content-length'] || '0', 10);
    if (contentLength > config.maxArtifactSize) {
      return reply.code(413).send({ error: 'File too large' });
    }

    // Create run artifact directory
    const runArtifactDir = join(config.artifactsDir, runId);
    if (!existsSync(runArtifactDir)) {
      mkdirSync(runArtifactDir, { recursive: true });
    }

    // Generate safe filename
    const id = nanoid(12);
    const safeName = basename(data.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `${id}_${safeName}`;
    const filePath = join(runArtifactDir, fileName);

    // Stream file to disk
    const writeStream = createWriteStream(filePath);
    let size = 0;

    try {
      for await (const chunk of data.file) {
        size += chunk.length;
        if (size > config.maxArtifactSize) {
          writeStream.destroy();
          throw new Error('File size exceeded limit during upload');
        }
        writeStream.write(chunk);
      }
      writeStream.end();
    } catch (err) {
      return reply.code(413).send({ error: 'File too large' });
    }

    // Determine artifact type from filename
    const ext = safeName.split('.').pop()?.toLowerCase() || 'unknown';
    const typeMap: Record<string, string> = {
      log: 'log',
      txt: 'text',
      json: 'json',
      diff: 'diff',
      patch: 'patch',
      md: 'markdown'
    };
    const type = typeMap[ext] || 'file';

    // Record in database
    db.prepare(`
      INSERT INTO artifacts (id, run_id, name, type, size, path)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, runId, safeName, type, size, filePath);

    // Broadcast artifact event
    broadcastToRun(runId, {
      type: 'artifact_uploaded',
      artifactId: id,
      name: safeName,
      artifactType: type,
      size
    });

    return { ok: true, artifactId: id, name: safeName, size };
  });

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
