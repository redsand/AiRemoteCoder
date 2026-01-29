import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { db } from './database.js';
import { vncTunnelManager } from './vnc-tunnel.js';

interface WSClient {
  socket: WebSocket;
  runId?: string;
  userId?: string;
  isAlive: boolean;
}

const clients = new Map<WebSocket, WSClient>();
const runSubscriptions = new Map<string, Set<WebSocket>>();

/**
 * Broadcast message to all subscribers of a run
 */
export function broadcastToRun(runId: string, message: object): void {
  const subs = runSubscriptions.get(runId);
  if (!subs) return;

  const payload = JSON.stringify(message);
  for (const socket of subs) {
    if (socket.readyState === 1) { // OPEN
      socket.send(payload);
    }
  }
}

/**
 * Broadcast to all connected clients
 */
export function broadcastAll(message: object): void {
  const payload = JSON.stringify(message);
  for (const [socket, client] of clients) {
    if (socket.readyState === 1) {
      socket.send(payload);
    }
  }
}

/**
 * Setup WebSocket handler
 */
export function setupWebSocket(fastify: FastifyInstance): void {
  fastify.get('/ws', { websocket: true }, (connection, request) => {
    const socket = connection;

    const client: WSClient = {
      socket,
      isAlive: true
    };
    clients.set(socket, client);

    // Handle incoming messages
    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case 'subscribe':
            if (msg.runId) {
              // Verify run exists
              const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(msg.runId);
              if (run) {
                client.runId = msg.runId;
                if (!runSubscriptions.has(msg.runId)) {
                  runSubscriptions.set(msg.runId, new Set());
                }
                runSubscriptions.get(msg.runId)!.add(socket);
                socket.send(JSON.stringify({ type: 'subscribed', runId: msg.runId }));
              } else {
                socket.send(JSON.stringify({ type: 'error', message: 'Run not found' }));
              }
            }
            break;

          case 'unsubscribe':
            if (client.runId) {
              const subs = runSubscriptions.get(client.runId);
              if (subs) {
                subs.delete(socket);
                if (subs.size === 0) {
                  runSubscriptions.delete(client.runId);
                }
              }
              client.runId = undefined;
              socket.send(JSON.stringify({ type: 'unsubscribed' }));
            }
            break;

          case 'ping':
            client.isAlive = true;
            socket.send(JSON.stringify({ type: 'pong' }));
            break;
        }
      } catch (err) {
        // Ignore parse errors
      }
    });

    // Handle pong for keep-alive
    socket.on('pong', () => {
      client.isAlive = true;
    });

    // Cleanup on close
    socket.on('close', () => {
      if (client.runId) {
        const subs = runSubscriptions.get(client.runId);
        if (subs) {
          subs.delete(socket);
          if (subs.size === 0) {
            runSubscriptions.delete(client.runId);
          }
        }
      }
      clients.delete(socket);
    });

    // Send welcome message
    socket.send(JSON.stringify({
      type: 'connected',
      message: 'WebSocket connected. Send { "type": "subscribe", "runId": "<id>" } to subscribe to run events.'
    }));
  });

  /**
   * VNC WebSocket endpoint - binary tunnel for RFB protocol frames
   * /ws/vnc/:runId - bidirectional binary tunnel between Python VNC client and noVNC viewer
   */
  fastify.get<{ Params: { runId: string } }>(
    '/ws/vnc/:runId',
    { websocket: true },
    (connection, request) => {
      const { runId } = request.params;
      const socket = connection;

      // Verify run exists and is VNC type
      const run = db.prepare('SELECT id, worker_type FROM runs WHERE id = ?').get(runId) as { id: string; worker_type: string } | undefined;
      if (!run || run.worker_type !== 'vnc') {
        socket.close(1008, 'Invalid run or not VNC type');
        return;
      }

      // Determine if this is client (Python VNC) or viewer (Web UI)
      const headers = request.headers;
      const userAgent = headers['user-agent'] || '';

      // Python VNC runner identifies itself
      const isClient = userAgent.includes('python') || headers['x-vnc-client'] === 'true';

      if (isClient) {
        // Python VNC client connection
        vncTunnelManager.setClientConnection(runId, socket);
      } else {
        // Web UI viewer connection
        vncTunnelManager.setViewerConnection(runId, socket);
      }

      // Note: Handlers are setup in vnc-tunnel.ts
      // Messages are forwarded bidirectionally between client and viewer
    }
  );

  // Keep-alive interval
  const pingInterval = setInterval(() => {
    for (const [socket, client] of clients) {
      if (!client.isAlive) {
        socket.terminate();
        clients.delete(socket);
        continue;
      }
      client.isAlive = false;
      socket.ping();
    }
  }, 30000);

  // Cleanup on server close
  fastify.addHook('onClose', () => {
    clearInterval(pingInterval);
    for (const socket of clients.keys()) {
      socket.close();
    }
    clients.clear();
    runSubscriptions.clear();
  });
}

/**
 * Get connection stats
 */
export function getConnectionStats(): { clients: number; subscriptions: number } {
  return {
    clients: clients.size,
    subscriptions: runSubscriptions.size
  };
}
