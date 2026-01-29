/**
 * RunDetail Page - Integration Example
 * Shows how to integrate VNC Viewer into the existing RunDetail page
 *
 * This is an example/reference file showing the integration pattern.
 * Apply these changes to the actual RunDetail.tsx file.
 */

import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { VncViewer } from '../components/VncViewer';
import { useVncConnection } from '../hooks/useVncConnection';

interface Run {
  id: string;
  worker_type: string;
  status: string;
  created_at: string;
  // ... other fields
}

/**
 * EXAMPLE: How to add VNC tab and panel to RunDetail
 *
 * 1. Add state for VNC visibility
 * 2. Add VNC tab to tab bar
 * 3. Add conditional VNC panel rendering
 * 4. Add Start VNC button when appropriate
 */

export function RunDetailExample() {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [activeTab, setActiveTab] = useState<'output' | 'files' | 'vnc'>('output');
  const [showVnc, setShowVnc] = useState(false);

  // VNC connection hook
  const {
    vncAvailable,
    vncInfo,
    vncReady,
    vncError,
    isLoading,
    startVnc,
    stopVnc
  } = useVncConnection({
    runId: runId || '',
    pollInterval: 2000,
    autoStart: false
  });

  if (!runId) return <div>Invalid run ID</div>;

  // Check if this is a VNC run
  const isVncRun = run?.worker_type === 'vnc';

  return (
    <div className="run-detail">
      <h1>Run {runId}</h1>

      {/* Tab Bar */}
      <div className="tab-bar">
        <button
          className={`tab ${activeTab === 'output' ? 'active' : ''}`}
          onClick={() => setActiveTab('output')}
        >
          Output
        </button>

        <button
          className={`tab ${activeTab === 'files' ? 'active' : ''}`}
          onClick={() => setActiveTab('files')}
        >
          Files
        </button>

        {/* VNC Tab - Only for VNC runs */}
        {isVncRun && (
          <button
            className={`tab ${activeTab === 'vnc' ? 'active' : ''}`}
            onClick={() => setActiveTab('vnc')}
          >
            VNC
            {vncReady && <span className="tab-indicator" title="VNC Ready">●</span>}
          </button>
        )}
      </div>

      {/* Tab Content */}
      <div className="tab-content">
        {/* Output Tab */}
        {activeTab === 'output' && (
          <div className="output-panel">
            {/* Existing output content */}
          </div>
        )}

        {/* Files Tab */}
        {activeTab === 'files' && (
          <div className="files-panel">
            {/* Existing files content */}
          </div>
        )}

        {/* VNC Tab */}
        {activeTab === 'vnc' && isVncRun && (
          <div className="vnc-panel">
            {/* VNC Control Section */}
            <div className="vnc-controls-section">
              <h2>Remote Desktop</h2>

              {/* Status Section */}
              <div className="vnc-status-card">
                <div className="status-row">
                  <label>Status:</label>
                  <span className={`badge ${vncReady ? 'ready' : 'idle'}`}>
                    {vncReady ? '● Connected' : '○ Not Connected'}
                  </span>
                </div>

                {vncInfo && (
                  <>
                    <div className="status-row">
                      <label>Resolution:</label>
                      <span>1920 x 1080</span>
                    </div>

                    {vncInfo.stats && (
                      <>
                        <div className="status-row">
                          <label>Data Transfer:</label>
                          <span>
                            ↓ {formatBytes(vncInfo.stats.bytesFromClient)}
                            {' '} ↑ {formatBytes(vncInfo.stats.bytesToClient)}
                          </span>
                        </div>

                        <div className="status-row">
                          <label>Connected Since:</label>
                          <span>
                            {vncInfo.stats.clientConnectedAt
                              ? new Date(vncInfo.stats.clientConnectedAt).toLocaleString()
                              : 'Not connected'}
                          </span>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>

              {/* Error Display */}
              {vncError && (
                <div className="error-message">
                  <span className="error-icon">⚠️</span>
                  {vncError}
                </div>
              )}

              {/* Control Buttons */}
              <div className="vnc-action-buttons">
                {!vncReady ? (
                  <button
                    className="btn btn-primary"
                    onClick={startVnc}
                    disabled={isLoading}
                  >
                    {isLoading ? 'Starting VNC...' : 'Start VNC Streaming'}
                  </button>
                ) : (
                  <>
                    <button
                      className="btn btn-secondary"
                      onClick={stopVnc}
                    >
                      Stop VNC Streaming
                    </button>
                    <span className="connection-status">
                      ● Client and viewer connected
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* VNC Viewer Section */}
            {vncReady && (
              <div className="vnc-viewer-section">
                <div className="vnc-viewer-wrapper">
                  <VncViewer
                    runId={runId}
                    onDisconnect={() => {
                      console.log('VNC disconnected');
                    }}
                    onConnect={() => {
                      console.log('VNC connected');
                    }}
                    autoConnect={true}
                  />
                </div>

                {/* Keyboard Shortcuts Help */}
                <div className="vnc-help">
                  <h4>Keyboard Shortcuts</h4>
                  <ul>
                    <li><kbd>Ctrl+Alt+Del</kbd> - Send Ctrl+Alt+Delete</li>
                    <li><kbd>F11</kbd> - Fullscreen mode</li>
                    <li>Click in the viewer area and use mouse/keyboard normally</li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Utility function
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * CSS Classes to Add to RunDetail.css:
 *
 * .vnc-panel { }
 * .vnc-controls-section { }
 * .vnc-status-card { }
 * .vnc-action-buttons { }
 * .vnc-viewer-section { }
 * .vnc-viewer-wrapper { }
 * .vnc-help { }
 * .badge { }
 * .badge.ready { }
 * .badge.idle { }
 * .error-message { }
 * .connection-status { }
 */

export default RunDetailExample;
