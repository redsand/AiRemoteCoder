/**
 * VNC Tunnel Manager - Handles binary WebSocket tunneling for VNC connections
 *
 * This service manages bidirectional WebSocket tunnels between:
 * - Client (Python VNC runner): Captures desktop and sends RFB frames
 * - Web UI (noVNC viewer): Displays remote desktop and sends input events
 *
 * Each run can have one active tunnel, which maintains two WebSocket connections
 * and routes binary frames bidirectionally between them.
 */

import { WebSocket } from 'ws';
import { logger } from '../index.js';

export interface VncTunnel {
  runId: string;
  clientWs: WebSocket | null;
  viewerWs: WebSocket | null;
  clientBuffer: Buffer[];
  viewerBuffer: Buffer[];
  createdAt: Date;
  clientConnectedAt?: Date;
  viewerConnectedAt?: Date;
  bytesFromClient: number;
  bytesToClient: number;
  bytesFromViewer: number;
  bytesToViewer: number;
}

export class VncTunnelManager {
  private tunnels = new Map<string, VncTunnel>();
  private pendingTunnels = new Map<string, VncTunnel>();

  /**
   * Create a new VNC tunnel for a run
   */
  createTunnel(runId: string): VncTunnel {
    const tunnel: VncTunnel = {
      runId,
      clientWs: null,
      viewerWs: null,
      clientBuffer: [],
      viewerBuffer: [],
      createdAt: new Date(),
      bytesFromClient: 0,
      bytesToClient: 0,
      bytesFromViewer: 0,
      bytesToViewer: 0
    };

    this.pendingTunnels.set(runId, tunnel);
    logger.info(`Created VNC tunnel for run ${runId}`);

    return tunnel;
  }

  /**
   * Get an existing tunnel
   */
  getTunnel(runId: string): VncTunnel | undefined {
    return this.tunnels.get(runId) || this.pendingTunnels.get(runId);
  }

  /**
   * Register client (Python VNC runner) WebSocket connection
   */
  setClientConnection(runId: string, ws: WebSocket): VncTunnel {
    let tunnel = this.getTunnel(runId);

    if (!tunnel) {
      tunnel = this.createTunnel(runId);
    }

    tunnel.clientWs = ws;
    tunnel.clientConnectedAt = new Date();

    // If both connections are ready, activate the tunnel
    if (tunnel.clientWs && tunnel.viewerWs) {
      this._activateTunnel(runId);
      this._flushViewerBuffer(runId);
    }

    logger.info(`Client connected to tunnel ${runId}`);

    // Setup handlers for client connection
    this._setupClientHandlers(runId, ws);

    return tunnel;
  }

  /**
   * Register viewer (Web UI noVNC) WebSocket connection
   */
  setViewerConnection(runId: string, ws: WebSocket): VncTunnel {
    let tunnel = this.getTunnel(runId);

    if (!tunnel) {
      tunnel = this.createTunnel(runId);
    }

    tunnel.viewerWs = ws;
    tunnel.viewerConnectedAt = new Date();

    // If both connections are ready, activate the tunnel
    if (tunnel.clientWs && tunnel.viewerWs) {
      this._activateTunnel(runId);
      this._flushClientBuffer(runId);
    }

    logger.info(`Viewer connected to tunnel ${runId}`);

    // Setup handlers for viewer connection
    this._setupViewerHandlers(runId, ws);

    return tunnel;
  }

  /**
   * Activate tunnel - both connections are ready
   */
  private _activateTunnel(runId: string): void {
    const tunnel = this.getTunnel(runId);
    if (!tunnel) return;

    // Move from pending to active
    if (this.pendingTunnels.has(runId)) {
      this.pendingTunnels.delete(runId);
      this.tunnels.set(runId, tunnel);
    }

    logger.info(`VNC tunnel activated for run ${runId}`);
  }

  /**
   * Setup handlers for client (Python VNC) connection
   */
  private _setupClientHandlers(runId: string, ws: WebSocket): void {
    ws.on('message', (data: Buffer) => {
      const tunnel = this.getTunnel(runId);
      if (!tunnel) return;

      try {
        tunnel.bytesFromClient += data.length;
        if (!tunnel.viewerWs || tunnel.viewerWs.readyState !== ws.OPEN) {
          tunnel.clientBuffer.push(data);
          return;
        }
        // Forward RFB frames from client to viewer
        tunnel.viewerWs.send(data);
        tunnel.bytesToViewer += data.length;
      } catch (err) {
        logger.error(`Error forwarding client message: ${err}`);
      }
    });

    ws.on('error', (err) => {
      logger.error(`Client WebSocket error on run ${runId}: ${err}`);
      this._closeTunnel(runId);
    });

    ws.on('close', () => {
      logger.info(`Client WebSocket closed for run ${runId}`);
      this._closeTunnel(runId);
    });

    ws.on('ping', () => {
      try {
        ws.pong();
      } catch (err) {
        logger.error(`Error sending pong: ${err}`);
      }
    });
  }

  /**
   * Setup handlers for viewer (Web UI) connection
   */
  private _setupViewerHandlers(runId: string, ws: WebSocket): void {
    ws.on('message', (data: Buffer) => {
      const tunnel = this.getTunnel(runId);
      if (!tunnel) return;

      try {
        tunnel.bytesFromViewer += data.length;
        if (!tunnel.clientWs || tunnel.clientWs.readyState !== ws.OPEN) {
          tunnel.viewerBuffer.push(data);
          return;
        }
        // Forward input events from viewer to client
        tunnel.clientWs.send(data);
        tunnel.bytesToClient += data.length;
      } catch (err) {
        logger.error(`Error forwarding viewer message: ${err}`);
      }
    });

    ws.on('error', (err) => {
      logger.error(`Viewer WebSocket error on run ${runId}: ${err}`);
      this._closeTunnel(runId);
    });

    ws.on('close', () => {
      logger.info(`Viewer WebSocket closed for run ${runId}`);
      this._closeTunnel(runId);
    });

    ws.on('ping', () => {
      try {
        ws.pong();
      } catch (err) {
        logger.error(`Error sending pong: ${err}`);
      }
    });
  }

  /**
   * Close a tunnel and both connections
   */
  closeTunnel(runId: string): void {
    this._closeTunnel(runId);
  }

  /**
   * Internal close implementation
   */
  private _closeTunnel(runId: string): void {
    const tunnel = this.getTunnel(runId);
    if (!tunnel) return;

    logger.info(`Closing tunnel for run ${runId}`);

    // Close both connections
    if (tunnel.clientWs && tunnel.clientWs.readyState !== WebSocket.CLOSED) {
      try {
        tunnel.clientWs.close();
      } catch (err) {
        logger.error(`Error closing client connection: ${err}`);
      }
    }

    if (tunnel.viewerWs && tunnel.viewerWs.readyState !== WebSocket.CLOSED) {
      try {
        tunnel.viewerWs.close();
      } catch (err) {
        logger.error(`Error closing viewer connection: ${err}`);
      }
    }

    // Remove tunnel
    this.tunnels.delete(runId);
    this.pendingTunnels.delete(runId);

    logger.info(`Tunnel closed for run ${runId}`);
  }

  private _flushClientBuffer(runId: string): void {
    const tunnel = this.getTunnel(runId);
    if (!tunnel || !tunnel.viewerWs || tunnel.viewerWs.readyState !== WebSocket.OPEN) return;

    while (tunnel.clientBuffer.length > 0) {
      const chunk = tunnel.clientBuffer.shift();
      if (!chunk) break;
      try {
        tunnel.viewerWs.send(chunk);
        tunnel.bytesToViewer += chunk.length;
      } catch (err) {
        logger.error(`Error flushing client buffer: ${err}`);
        break;
      }
    }
  }

  private _flushViewerBuffer(runId: string): void {
    const tunnel = this.getTunnel(runId);
    if (!tunnel || !tunnel.clientWs || tunnel.clientWs.readyState !== WebSocket.OPEN) return;

    while (tunnel.viewerBuffer.length > 0) {
      const chunk = tunnel.viewerBuffer.shift();
      if (!chunk) break;
      try {
        tunnel.clientWs.send(chunk);
        tunnel.bytesToClient += chunk.length;
      } catch (err) {
        logger.error(`Error flushing viewer buffer: ${err}`);
        break;
      }
    }
  }

  /**
   * Get tunnel statistics
   */
  getTunnelStats(runId: string): any {
    const tunnel = this.getTunnel(runId);
    if (!tunnel) return null;

    return {
      runId,
      status: this.tunnels.has(runId) ? 'active' : 'pending',
      clientConnected: tunnel.clientWs?.readyState === WebSocket.OPEN,
      viewerConnected: tunnel.viewerWs?.readyState === WebSocket.OPEN,
      createdAt: tunnel.createdAt,
      clientConnectedAt: tunnel.clientConnectedAt,
      viewerConnectedAt: tunnel.viewerConnectedAt,
      bytesFromClient: tunnel.bytesFromClient,
      bytesToClient: tunnel.bytesToClient,
      bytesFromViewer: tunnel.bytesFromViewer,
      bytesToViewer: tunnel.bytesToViewer,
      totalBytes: tunnel.bytesFromClient + tunnel.bytesToClient + tunnel.bytesFromViewer + tunnel.bytesToViewer
    };
  }

  /**
   * Get all tunnel statistics
   */
  getAllTunnelStats(): any[] {
    const stats = [];
    for (const tunnel of this.tunnels.values()) {
      stats.push(this.getTunnelStats(tunnel.runId));
    }
    for (const tunnel of this.pendingTunnels.values()) {
      stats.push(this.getTunnelStats(tunnel.runId));
    }
    return stats;
  }

  /**
   * Get count of active tunnels
   */
  getActiveTunnelCount(): number {
    return this.tunnels.size;
  }

  /**
   * Get count of pending tunnels
   */
  getPendingTunnelCount(): number {
    return this.pendingTunnels.size;
  }
}

// Export singleton instance
export const vncTunnelManager = new VncTunnelManager();
