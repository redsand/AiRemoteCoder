/**
 * VNC Viewer Component
 * Embeds noVNC viewer for in-browser remote desktop access
 */

import React, { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc/lib/rfb.js';
import './VncViewer.css';

interface VncViewerProps {
  runId: string;
  onDisconnect?: () => void;
  onConnect?: () => void;
  autoConnect?: boolean;
}

export const VncViewer: React.FC<VncViewerProps> = ({
  runId,
  onDisconnect,
  onConnect,
  autoConnect = true
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<any>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);

  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('Initializing...');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onConnectRef.current = onConnect;
    onDisconnectRef.current = onDisconnect;
  }, [onConnect, onDisconnect]);

  // Establish RFB connection via noVNC
  useEffect(() => {
    if (!autoConnect) return;
    if (!containerRef.current) return;

    const connectRfb = () => {
      try {
        if (rfbRef.current) {
          return;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/vnc/${runId}`;

        setStatus('Connecting to VNC server...');
        const rfb = new RFB(containerRef.current as HTMLElement, wsUrl, {
          shared: true
        });

        rfb.scaleViewport = true;
        rfb.resizeSession = true;
        rfb.viewOnly = false;

        rfb.addEventListener('connect', () => {
          setConnected(true);
          setStatus('Connected');
          setError(null);
          onConnectRef.current?.();
        });

        rfb.addEventListener('disconnect', () => {
          setConnected(false);
          setStatus('Disconnected');
          onDisconnectRef.current?.();

          if (autoConnect && reconnectTimeoutRef.current === null) {
            reconnectTimeoutRef.current = window.setTimeout(() => {
              reconnectTimeoutRef.current = null;
              rfbRef.current = null;
              connectRfb();
            }, 3000);
          }
        });

        rfbRef.current = rfb;
      } catch (err: any) {
        setError(`Failed to connect: ${err.message}`);
        setStatus('Connection failed');
      }
    };

    connectRfb();

    return () => {
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (rfbRef.current) {
        rfbRef.current.disconnect();
        rfbRef.current = null;
      }
    };
  }, [runId, autoConnect]);

  const sendCtrlAltDel = () => {
    if (!rfbRef.current) return;
    rfbRef.current.sendCtrlAltDel();
  };

  const toggleFullscreen = async () => {
    const container = containerRef.current;
    if (!container) return;
    try {
      if (!document.fullscreenElement) {
        await container.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.error('Fullscreen error:', err);
    }
  };

  return (
    <div className="vnc-viewer-container">
      <div className="vnc-toolbar">
        <div className="vnc-status">
          <span className={`status-indicator ${connected ? 'connected' : 'disconnected'}`} />
          {status}
        </div>

        <div className="vnc-controls">
          <button
            onClick={sendCtrlAltDel}
            title="Send Ctrl+Alt+Delete"
            disabled={!connected}
          >
            Ctrl+Alt+Del
          </button>

          <button
            onClick={toggleFullscreen}
            title="Fullscreen"
            disabled={!connected}
          >
            ⛶
          </button>
        </div>

        <div className="vnc-stats" />
      </div>

      {error && (
        <div className="vnc-error">
          {error}
        </div>
      )}

      <div ref={containerRef} className="vnc-canvas-container" />
    </div>
  );
};

export default VncViewer;
