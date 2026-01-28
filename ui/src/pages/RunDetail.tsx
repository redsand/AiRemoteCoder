import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  StatusPill,
  ConnectionIndicator,
  LiveLogViewer,
  ActionBar,
  ActionButton,
  Modal,
  ConfirmModal,
  useToast,
  type LogEvent,
} from '../components/ui';

interface Run {
  id: string;
  status: string;
  label: string | null;
  command: string | null;
  repo_path: string | null;
  repo_name: string | null;
  client_id: string | null;
  client_name: string | null;
  client_status: string | null;
  waiting_approval: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  error_message: string | null;
  artifacts: Artifact[];
  commands: Command[];
  assistUrl: string | null;
  duration: number | null;
}

interface Artifact {
  id: string;
  name: string;
  type: string;
  size: number;
  created_at: number;
}

interface Command {
  id: string;
  command: string;
  status: string;
  created_at: number;
  acked_at: number | null;
  result: string | null;
  error: string | null;
}

interface Props {
  user: { id: string; username: string; role: string } | null;
}

const ALLOWED_COMMANDS = [
  'npm test',
  'npm run build',
  'npm run lint',
  'git diff',
  'git status',
  'git log --oneline -10',
  // Directory navigation
  'cd',
  'ls',
  'ls -la',
  'ls -l',
  'ls -a',
  'll',
  'dir',
  'pwd',
];

type Tab = 'log' | 'timeline' | 'artifacts' | 'commands';

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

export function RunDetail({ user }: Props) {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { addToast } = useToast();

  // State
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('log');

  // Prompt waiting state
  const [promptWaiting, setPromptWaiting] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [keyboardInput, setKeyboardInput] = useState('');
  const [keyboardHistory, setKeyboardHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [sendLoading, setSendLoading] = useState(false);

  // Modals
  const [showCommandModal, setShowCommandModal] = useState(false);
  const [selectedCommand, setSelectedCommand] = useState('');
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [commandLoading, setCommandLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const lastEventId = useRef(0);
  const reconnectTimeout = useRef<NodeJS.Timeout>();
  const keyboardInputRef = useRef<HTMLInputElement>(null);

  const canOperate = user?.role === 'admin' || user?.role === 'operator';
  const canDelete = user?.role === 'admin';
  const isActive = run?.status === 'running';

  // Fetch run details
  const fetchRun = useCallback(async () => {
    try {
      const res = await fetch(`/api/runs/${runId}`);
      if (res.ok) {
        const data = await res.json();
        setRun(data);
      } else if (res.status === 404) {
        navigate('/runs', { replace: true });
        addToast('error', 'Run not found');
      }
    } catch (err) {
      console.error('Failed to fetch run:', err);
    } finally {
      setLoading(false);
    }
  }, [runId, navigate, addToast]);

  // Fetch events
  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch(`/api/runs/${runId}/events?after=${lastEventId.current}&limit=500`);
      if (res.ok) {
        const newEvents = await res.json();
        if (newEvents.length > 0) {
          setEvents(prev => [...prev, ...newEvents]);
          lastEventId.current = newEvents[newEvents.length - 1].id;
        }
      }
    } catch (err) {
      console.error('Failed to fetch events:', err);
    }
  }, [runId]);

  // Connect WebSocket
  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      setConnected(true);
      setReconnecting(false);
      ws.send(JSON.stringify({ type: 'subscribe', runId }));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        switch (data.type) {
          case 'event':
            setEvents(prev => [
              ...prev,
              {
                id: data.eventId,
                type: data.eventType,
                data: data.data,
                timestamp: data.timestamp,
              },
            ]);
            lastEventId.current = data.eventId;

            // Handle prompt events
            if (data.eventType === 'prompt_waiting') {
              setPromptWaiting(true);
              setPromptText(data.data);
              // Focus keyboard input
              setTimeout(() => keyboardInputRef.current?.focus(), 100);
            } else if (data.eventType === 'prompt_resolved') {
              setPromptWaiting(false);
              setPromptText('');
            }
            break;

          case 'command_completed':
          case 'artifact_uploaded':
            fetchRun();
            break;
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setReconnecting(true);
      // Reconnect with backoff
      reconnectTimeout.current = setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
      setConnected(false);
    };

    wsRef.current = ws;
  }, [runId, fetchRun]);

  // Initial fetch and WebSocket setup
  useEffect(() => {
    fetchRun();
    fetchEvents();
    connectWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
    };
  }, [runId]);

  // Send command
  const sendCommand = async () => {
    if (!selectedCommand) return;

    setCommandLoading(true);
    try {
      const res = await fetch(`/api/runs/${runId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: selectedCommand }),
      });
      if (res.ok) {
        addToast('success', 'Command queued');
        setShowCommandModal(false);
        setSelectedCommand('');
        fetchRun();
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to send command');
      }
    } catch (err) {
      addToast('error', 'Failed to send command');
    } finally {
      setCommandLoading(false);
    }
  };

  // Stop run
  const stopRun = async () => {
    try {
      const res = await fetch(`/api/runs/${runId}/stop`, { method: 'POST' });
      if (res.ok) {
        addToast('success', 'Stop requested');
        setShowStopConfirm(false);
        fetchRun();
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to stop run');
      }
    } catch (err) {
      addToast('error', 'Failed to stop run');
    }
  };

  // Delete run
  const deleteRun = async () => {
    setDeleteLoading(true);
    try {
      const res = await fetch(`/api/runs/${runId}`, { method: 'DELETE' });
      if (res.ok) {
        addToast('success', 'Run deleted successfully');
        setShowDeleteConfirm(false);
        navigate('/runs', { replace: true });
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to delete run');
      }
    } catch (err) {
      addToast('error', 'Failed to delete run');
    } finally {
      setDeleteLoading(false);
    }
  };

  // Send keyboard input
  const sendKeyboardInput = async () => {
    if (!keyboardInput.trim()) return;

    setSendLoading(true);
    const input = keyboardInput + '\n'; // Always append newline

    try {
      const res = await fetch(`/api/runs/${runId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, escape: false }),
      });
      if (res.ok) {
        // Add to history
        setKeyboardHistory(prev => [...prev, keyboardInput].slice(-50));
        setHistoryIndex(-1);
        setKeyboardInput('');
        addToast('success', 'Input sent');
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to send input');
      }
    } catch (err) {
      addToast('error', 'Failed to send input');
    } finally {
      setSendLoading(false);
      keyboardInputRef.current?.focus();
    }
  };

  // Handle keyboard history (up/down arrows)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const newIndex = Math.min(historyIndex + 1, keyboardHistory.length - 1);
      if (newIndex >= 0 && keyboardHistory[keyboardHistory.length - 1 - newIndex]) {
        setHistoryIndex(newIndex);
        setKeyboardInput(keyboardHistory[keyboardHistory.length - 1 - newIndex]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const newIndex = Math.max(historyIndex - 1, -1);
      setHistoryIndex(newIndex);
      if (newIndex === -1) {
        setKeyboardInput('');
      } else if (keyboardHistory[keyboardHistory.length - 1 - newIndex]) {
        setKeyboardInput(keyboardHistory[keyboardHistory.length - 1 - newIndex]);
      }
    }
  };

  // Quick response shortcuts
  const sendQuickResponse = async (response: 'y' | 'n' | 'yes' | 'no' | 'enter') => {
    const input = response === 'enter' ? '\n' : response + '\n';
    try {
      const res = await fetch(`/api/runs/${runId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, escape: false }),
      });
      if (res.ok) {
        addToast('success', `Sent: ${response}`);
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to send input');
      }
    } catch (err) {
      addToast('error', 'Failed to send input');
    }
    keyboardInputRef.current?.focus();
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="empty-state">
        <h2>Run not found</h2>
        <Link to="/runs" className="btn">
          Back to runs
        </Link>
      </div>
    );
  }

  const displayTitle = run.label || run.command?.slice(0, 60) || `Run ${run.id}`;

  return (
    <div className="run-detail">
      {/* Header */}
      <div className="run-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
          <Link to="/runs" className="btn btn-sm">
            ← Back
          </Link>
          <StatusPill status={run.status as any} />
          <ConnectionIndicator connected={connected} reconnecting={reconnecting} />
        </div>

        <h1 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>
          {displayTitle}
        </h1>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '16px',
            fontSize: '13px',
            color: 'var(--text-secondary)',
          }}
        >
          <span>
            <strong>ID:</strong> <code>{run.id}</code>
          </span>
          {run.client_name && (
            <span>
              <strong>Client:</strong>{' '}
              <Link to={`/clients/${run.client_id}`}>{run.client_name}</Link>
            </span>
          )}
          {run.repo_name && (
            <span>
              <strong>Repo:</strong> {run.repo_name}
            </span>
          )}
          {run.duration && (
            <span>
              <strong>Duration:</strong> {formatDuration(run.duration)}
            </span>
          )}
        </div>
      </div>

      {/* Assist Session Banner */}
      {run.assistUrl && (
        <div
          style={{
            padding: '12px 16px',
            background: 'rgba(59, 185, 80, 0.1)',
            border: '1px solid var(--accent-green)',
            borderRadius: '8px',
            marginBottom: '16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span style={{ fontSize: '16px' }}>🔗</span>
            <strong style={{ color: 'var(--accent-green)' }}>Assist Session Active</strong>
          </div>
          <a
            href={run.assistUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontFamily: 'monospace',
              fontSize: '13px',
              color: 'var(--accent-blue)',
              wordBreak: 'break-all',
            }}
          >
            {run.assistUrl}
          </a>
        </div>
      )}

      {/* Prompt Waiting Banner */}
      {promptWaiting && (
        <div
          style={{
            padding: '12px 16px',
            background: 'rgba(163, 113, 247, 0.15)',
            border: '1px solid var(--accent-purple)',
            borderRadius: '8px',
            marginBottom: '16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <span style={{ fontSize: '16px' }}>🔔</span>
            <strong style={{ color: 'var(--accent-purple)' }}>Waiting for your input</strong>
          </div>

          {/* Quick response buttons */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <button
              className="btn btn-sm"
              onClick={() => sendQuickResponse('y')}
              style={{ background: 'var(--accent-green)', color: 'white' }}
            >
              Yes (y)
            </button>
            <button
              className="btn btn-sm"
              onClick={() => sendQuickResponse('n')}
              style={{ background: 'var(--accent-red)', color: 'white' }}
            >
              No (n)
            </button>
            <button
              className="btn btn-sm"
              onClick={() => sendQuickResponse('yes')}
            >
              Yes (full)
            </button>
            <button
              className="btn btn-sm"
              onClick={() => sendQuickResponse('no')}
            >
              No (full)
            </button>
            <button
              className="btn btn-sm"
              onClick={() => sendQuickResponse('enter')}
            >
              Enter
            </button>
          </div>

          {/* Keyboard input */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              ref={keyboardInputRef}
              type="text"
              value={keyboardInput}
              onChange={(e) => setKeyboardInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your response and press Enter..."
              className="form-input"
              style={{ flex: 1 }}
              disabled={sendLoading}
            />
            <button
              className="btn btn-primary"
              onClick={sendKeyboardInput}
              disabled={sendLoading || !keyboardInput.trim()}
            >
              {sendLoading ? 'Sending...' : 'Send'}
            </button>
          </div>

          {/* Show recent prompt text if available */}
          {promptText && (
            <div
              style={{
                marginTop: '8px',
                padding: '8px',
                background: 'var(--bg-tertiary)',
                borderRadius: '4px',
                fontSize: '12px',
                fontFamily: 'monospace',
                color: 'var(--text-secondary)',
              }}
            >
              {promptText.slice(-200)}
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="tabs">
        <button
          className={`tab ${activeTab === 'log' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('log')}
        >
          Live Log
        </button>
        <button
          className={`tab ${activeTab === 'timeline' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('timeline')}
        >
          Timeline
        </button>
        <button
          className={`tab ${activeTab === 'artifacts' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('artifacts')}
        >
          Artifacts
          {run.artifacts.length > 0 && (
            <span className="tab-badge">{run.artifacts.length}</span>
          )}
        </button>
        <button
          className={`tab ${activeTab === 'commands' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('commands')}
        >
          Commands
          {run.commands.length > 0 && (
            <span className="tab-badge">{run.commands.length}</span>
          )}
        </button>
      </div>

      {/* Tab content */}
      <div className="tab-content">
        {activeTab === 'log' && (
          <LiveLogViewer events={events} maxHeight="calc(100vh - 400px)" />
        )}

        {activeTab === 'timeline' && (
          <TimelineView events={events} />
        )}

        {activeTab === 'artifacts' && (
          <ArtifactsList artifacts={run.artifacts} />
        )}

        {activeTab === 'commands' && (
          <CommandsList commands={run.commands} />
        )}
      </div>

      {/* Action Bar (mobile sticky) */}
      {canOperate && (
        <ActionBar visible={isActive || canDelete}>
          {isActive && (
            <>
              <ActionButton
                onClick={() => setShowStopConfirm(true)}
                variant="danger"
                icon="⏹"
              >
                Stop
              </ActionButton>
              <ActionButton
                onClick={() => setShowCommandModal(true)}
                variant="primary"
                icon="▶"
              >
                Run Command
              </ActionButton>
            </>
          )}
          {canDelete && (
            <ActionButton
              onClick={() => setShowDeleteConfirm(true)}
              variant="danger"
              icon="🗑"
            >
              Delete Run
            </ActionButton>
          )}
        </ActionBar>
      )}

      {/* Command Modal */}
      <Modal
        open={showCommandModal}
        onClose={() => setShowCommandModal(false)}
        title="Run Command"
        footer={
          <>
            <button className="btn" onClick={() => setShowCommandModal(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={sendCommand}
              disabled={!selectedCommand || commandLoading}
            >
              {commandLoading ? 'Sending...' : 'Run Command'}
            </button>
          </>
        }
      >
        <div style={{ marginBottom: '16px' }}>
          <label className="form-label">Select Command</label>
          <select
            value={selectedCommand}
            onChange={(e) => setSelectedCommand(e.target.value)}
            className="form-input"
            style={{ cursor: 'pointer' }}
          >
            <option value="">Choose a command...</option>
            {ALLOWED_COMMANDS.map((cmd) => (
              <option key={cmd} value={cmd}>
                {cmd}
              </option>
            ))}
          </select>
        </div>
        {selectedCommand && (
          <div
            style={{
              padding: '12px',
              background: 'var(--bg-tertiary)',
              borderRadius: '6px',
              fontFamily: 'monospace',
              fontSize: '13px',
            }}
          >
            <code>{selectedCommand}</code>
          </div>
        )}
      </Modal>

      {/* Stop Confirmation */}
      <ConfirmModal
        open={showStopConfirm}
        onClose={() => setShowStopConfirm(false)}
        onConfirm={stopRun}
        title="Stop Run"
        message="Are you sure you want to stop this run? This will send a stop signal to the running process."
        confirmText="Stop Run"
        danger
      />

      {/* Delete Confirmation */}
      <ConfirmModal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={deleteRun}
        title="Delete Run"
        message="Are you sure you want to delete this run? This action cannot be undone. All logs, artifacts, and data associated with this run will be permanently deleted."
        confirmText={deleteLoading ? 'Deleting...' : 'Delete Run'}
        danger
      />
    </div>
  );
}

// Timeline View
function TimelineView({ events }: { events: LogEvent[] }) {
  // Group events by step_id or time buckets
  const groupedEvents: { [key: string]: LogEvent[] } = {};

  events.forEach((event) => {
    const key = event.step_id || `time-${Math.floor(event.timestamp / 60)}`;
    if (!groupedEvents[key]) {
      groupedEvents[key] = [];
    }
    groupedEvents[key].push(event);
  });

  const groups = Object.entries(groupedEvents).sort((a, b) => {
    const aTime = a[1][0]?.timestamp || 0;
    const bTime = b[1][0]?.timestamp || 0;
    return aTime - bTime;
  });

  if (groups.length === 0) {
    return (
      <div className="empty-state-small">
        No timeline events yet.
      </div>
    );
  }

  return (
    <div className="timeline">
      {groups.map(([key, groupEvents]) => {
        const firstEvent = groupEvents[0];
        const lastEvent = groupEvents[groupEvents.length - 1];
        const hasErrors = groupEvents.some(e => e.type === 'stderr' || e.type === 'error');

        return (
          <TimelineGroup
            key={key}
            stepId={key}
            events={groupEvents}
            startTime={firstEvent.timestamp}
            endTime={lastEvent.timestamp}
            hasErrors={hasErrors}
          />
        );
      })}
    </div>
  );
}

function TimelineGroup({
  stepId: _stepId,
  events,
  startTime,
  endTime: _endTime,
  hasErrors,
}: {
  stepId: string;
  events: LogEvent[];
  startTime: number;
  endTime: number;
  hasErrors: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="timeline-group"
      style={{
        borderLeft: `3px solid ${hasErrors ? 'var(--accent-red)' : 'var(--border-color)'}`,
        paddingLeft: '16px',
        marginBottom: '12px',
      }}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          cursor: 'pointer',
          padding: '8px 0',
        }}
      >
        <span style={{ fontSize: '12px' }}>{expanded ? '▼' : '▶'}</span>
        <span style={{ fontSize: '13px', fontWeight: 500 }}>
          {formatTime(startTime)}
        </span>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {events.length} events
        </span>
        {hasErrors && (
          <span
            style={{
              padding: '2px 6px',
              fontSize: '10px',
              background: 'rgba(248, 81, 73, 0.15)',
              color: 'var(--accent-red)',
              borderRadius: '4px',
            }}
          >
            errors
          </span>
        )}
      </div>

      {expanded && (
        <div style={{ marginTop: '8px' }}>
          {events.slice(0, 20).map((event) => (
            <div
              key={event.id}
              style={{
                padding: '4px 8px',
                fontSize: '12px',
                fontFamily: 'monospace',
                color:
                  event.type === 'stderr'
                    ? 'var(--accent-red)'
                    : event.type === 'marker'
                    ? 'var(--accent-purple)'
                    : 'var(--text-secondary)',
              }}
            >
              {event.data.slice(0, 100)}
              {event.data.length > 100 && '...'}
            </div>
          ))}
          {events.length > 20 && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '4px 8px' }}>
              +{events.length - 20} more events
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Artifacts List
function ArtifactsList({ artifacts }: { artifacts: Artifact[] }) {
  if (artifacts.length === 0) {
    return (
      <div className="empty-state-small">
        No artifacts uploaded yet.
      </div>
    );
  }

  return (
    <ul className="artifact-list">
      {artifacts.map((artifact) => (
        <li key={artifact.id} className="artifact-item">
          <div>
            <span className="artifact-name">{artifact.name}</span>
            <span className="artifact-meta">
              {artifact.type} • {formatBytes(artifact.size)} •{' '}
              {formatTime(artifact.created_at)}
            </span>
          </div>
          <a
            href={`/api/artifacts/${artifact.id}`}
            className="btn btn-sm"
            download
          >
            Download
          </a>
        </li>
      ))}
    </ul>
  );
}

// Commands List
function CommandsList({ commands }: { commands: Command[] }) {
  if (commands.length === 0) {
    return (
      <div className="empty-state-small">
        No commands sent yet.
      </div>
    );
  }

  return (
    <div className="commands-list">
      {commands.map((cmd) => (
        <div key={cmd.id} className="command-item">
          <div className="command-header">
            <code className="command-text">{cmd.command}</code>
            <StatusPill
              status={cmd.status === 'completed' ? 'done' : 'pending'}
              size="sm"
            >
              {cmd.status}
            </StatusPill>
          </div>
          <div className="command-meta">
            Queued: {formatTime(cmd.created_at)}
            {cmd.acked_at && ` • Completed: ${formatTime(cmd.acked_at)}`}
          </div>
          {cmd.result && (
            <pre className="command-result">{cmd.result}</pre>
          )}
          {cmd.error && (
            <pre className="command-error">{cmd.error}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

export default RunDetail;
