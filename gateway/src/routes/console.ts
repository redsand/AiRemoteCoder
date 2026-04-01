import type { FastifyInstance } from 'fastify';
import { spawn } from 'child_process';
import { db } from '../services/database.js';
import { validateMcpToken, extractBearerToken } from '../mcp/auth.js';
import { uiAuth } from '../middleware/auth.js';
import type { IncomingMessage } from 'http';

function getRunCwd(runId: string): string | null {
  // Try repo_path first, then event cwd
  const run = db.prepare('SELECT repo_path FROM runs WHERE id = ?').get(runId) as { repo_path: string | null } | undefined;
  if (run?.repo_path) return run.repo_path;

  const evt = db.prepare(
    "SELECT json_extract(data, '$.params.thread.cwd') as cwd FROM events WHERE run_id = ? AND type = 'info' AND data LIKE '%thread/started%' ORDER BY id LIMIT 1"
  ).get(runId) as { cwd: string | null } | undefined;
  return evt?.cwd ?? null;
}

export async function consoleRoutes(fastify: FastifyInstance) {
  fastify.get('/ws/console/:runId', {
    websocket: true,
    preHandler: [uiAuth],
  }, (socket, request) => {
    const { runId } = request.params as { runId: string };
    const cwd = getRunCwd(runId) ?? process.cwd();

    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'powershell.exe' : 'bash';
    const args = isWindows ? ['-NoLogo'] : [];

    let proc: ReturnType<typeof spawn> | null = null;

    try {
      proc = spawn(shell, args, {
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
        // PTY would be ideal but requires node-pty which needs native build.
        // Use pipe for now — works for interactive use.
      });
    } catch (err) {
      socket.send(JSON.stringify({ type: 'error', message: `Failed to start shell: ${(err as Error).message}` }));
      socket.close();
      return;
    }

    proc.stdout?.on('data', (data: Buffer) => {
      if (socket.readyState === 1) socket.send(data);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      if (socket.readyState === 1) socket.send(data);
    });

    proc.on('exit', () => {
      if (socket.readyState === 1) socket.close();
    });

    socket.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'input' && typeof msg.data === 'string') {
          proc?.stdin?.write(msg.data);
        }
        // resize: node-pty would handle this, skip for now
      } catch {
        proc?.stdin?.write(raw.toString());
      }
    });

    socket.on('close', () => {
      proc?.kill();
    });
  });
}
