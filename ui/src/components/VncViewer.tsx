/**
 * VNC Viewer Component
 * Embeds noVNC viewer for in-browser remote desktop access
 */

import React, { useEffect, useRef, useState } from 'react';
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('Initializing...');
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({
    bytesReceived: 0,
    bytesSent: 0,
    latency: 0
  });

  // Establish WebSocket connection
  useEffect(() => {
    if (!autoConnect) return;

    const connectWebSocket = () => {
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/vnc/${runId}`;

        setStatus('Connecting to VNC server...');
        const ws = new WebSocket(wsUrl);

        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          console.log('VNC WebSocket connected');
          setConnected(true);
          setStatus('Connected');
          setError(null);
          onConnect?.();
        };

        ws.onmessage = (event) => {
          if (typeof event.data === 'string') {
            // JSON message (unlikely for VNC, but handle it)
            console.log('VNC message:', event.data);
          } else {
            // Binary RFB data
            handleRFBFrame(event.data as ArrayBuffer);
            stats.bytesReceived += event.data.byteLength;
            setStats({ ...stats });
          }
        };

        ws.onerror = (event) => {
          console.error('VNC WebSocket error:', event);
          setError('WebSocket connection error');
          setStatus('Error');
        };

        ws.onclose = () => {
          console.log('VNC WebSocket closed');
          setConnected(false);
          setStatus('Disconnected');
          onDisconnect?.();

          // Attempt reconnection after delay
          setTimeout(connectWebSocket, 3000);
        };

        wsRef.current = ws;
      } catch (err: any) {
        setError(`Failed to connect: ${err.message}`);
        setStatus('Connection failed');
      }
    };

    connectWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [runId, autoConnect, onDisconnect, onConnect]);

  // Handle incoming RFB frames
  const handleRFBFrame = (data: ArrayBuffer) => {
    if (!canvasRef.current) return;

    // For now, just log the frame
    // In a real implementation, would use noVNC RFB decoder
    console.log('Received RFB frame:', data.byteLength, 'bytes');

    // TODO: Integrate noVNC RFB decoder
    // const ctx = canvasRef.current.getContext('2d');
    // if (ctx) {
    //   // Parse RFB frame and update canvas
    // }
  };

  // Send mouse move event
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!wsRef.current || !canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) * (canvasRef.current.width / rect.width));
    const y = Math.floor((e.clientY - rect.top) * (canvasRef.current.height / rect.height));

    // Send PointerEvent to VNC
    sendPointerEvent(x, y, 0);
  };

  // Send mouse button event
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!wsRef.current || !canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) * (canvasRef.current.width / rect.width));
    const y = Math.floor((e.clientY - rect.top) * (canvasRef.current.height / rect.height));

    const button = e.button; // 0 = left, 1 = middle, 2 = right
    const mask = 1 << button;

    sendPointerEvent(x, y, mask);
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!wsRef.current || !canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) * (canvasRef.current.width / rect.width));
    const y = Math.floor((e.clientY - rect.top) * (canvasRef.current.height / rect.height));

    sendPointerEvent(x, y, 0);
  };

  // Handle keyboard
  const handleKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!wsRef.current) return;

    const keysym = getKeysym(e.key, e.code);
    if (keysym) {
      sendKeyEvent(keysym, true);
      e.preventDefault();
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!wsRef.current) return;

    const keysym = getKeysym(e.key, e.code);
    if (keysym) {
      sendKeyEvent(keysym, false);
      e.preventDefault();
    }
  };

  // Send RFB PointerEvent
  const sendPointerEvent = (x: number, y: number, buttonMask: number) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const buffer = new ArrayBuffer(6);
    const view = new DataView(buffer);

    view.setUint8(0, 5); // PointerEvent type
    view.setUint8(1, buttonMask); // button mask
    view.setUint16(2, x, false); // x coordinate (big-endian)
    view.setUint16(4, y, false); // y coordinate (big-endian)

    wsRef.current.send(buffer);
    stats.bytesSent += buffer.byteLength;
  };

  // Send RFB KeyEvent
  const sendKeyEvent = (keysym: number, down: boolean) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);

    view.setUint8(0, 4); // KeyEvent type
    view.setUint8(1, down ? 1 : 0); // down flag
    view.setUint16(2, 0, false); // padding
    view.setUint32(4, keysym, false); // keysym (big-endian)

    wsRef.current.send(buffer);
    stats.bytesSent += buffer.byteLength;
  };

  // Map JS key to X11 keysym
  const getKeysym = (key: string, _code: string): number | null => {
    const keyMap: { [key: string]: number } = {
      'Escape': 0xFF1B,
      'Tab': 0xFF09,
      'Enter': 0xFF0D,
      'Backspace': 0xFF08,
      'Delete': 0xFFFF,

      'ArrowLeft': 0xFF51,
      'ArrowUp': 0xFF52,
      'ArrowRight': 0xFF53,
      'ArrowDown': 0xFF54,

      'PageUp': 0xFF55,
      'PageDown': 0xFF56,
      'Home': 0xFF50,
      'End': 0xFF57,

      'F1': 0xFFBE,
      'F2': 0xFFBF,
      'F3': 0xFFC0,
      'F4': 0xFFC1,
      'F5': 0xFFC2,
      'F6': 0xFFC3,
      'F7': 0xFFC4,
      'F8': 0xFFC5,
      'F9': 0xFFC6,
      'F10': 0xFFC7,
      'F11': 0xFFC8,
      'F12': 0xFFC9,

      'Shift': 0xFFE1,
      'Control': 0xFFE3,
      'Alt': 0xFFE9,
      'Meta': 0xFFEB,

      ' ': 0x0020,
    };

    if (keyMap[key]) {
      return keyMap[key];
    }

    // For ASCII characters, use the character code
    if (key.length === 1) {
      return key.charCodeAt(0);
    }

    return null;
  };

  const sendCtrlAltDel = () => {
    if (!wsRef.current) return;

    // Send Ctrl
    sendKeyEvent(0xFFE3, true);
    // Send Alt
    sendKeyEvent(0xFFE9, true);
    // Send Delete
    sendKeyEvent(0xFFFF, true);

    setTimeout(() => {
      sendKeyEvent(0xFFFF, false);
      sendKeyEvent(0xFFE9, false);
      sendKeyEvent(0xFFE3, false);
    }, 100);
  };

  const toggleFullscreen = async () => {
    if (canvasRef.current) {
      try {
        if (!document.fullscreenElement) {
          await canvasRef.current.requestFullscreen();
        } else {
          await document.exitFullscreen();
        }
      } catch (err) {
        console.error('Fullscreen error:', err);
      }
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

        <div className="vnc-stats">
          {stats.bytesReceived > 0 && (
            <span title="Bytes received">↓ {formatBytes(stats.bytesReceived)}</span>
          )}
          {stats.bytesSent > 0 && (
            <span title="Bytes sent">↑ {formatBytes(stats.bytesSent)}</span>
          )}
        </div>
      </div>

      {error && (
        <div className="vnc-error">
          {error}
        </div>
      )}

      <div ref={containerRef} className="vnc-canvas-container">
        <canvas
          ref={canvasRef}
          className="vnc-canvas"
          width={1920}
          height={1080}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          tabIndex={0}
        />
      </div>
    </div>
  );
};

// Utility function to format bytes
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

export default VncViewer;
