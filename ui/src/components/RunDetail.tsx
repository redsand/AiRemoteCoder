import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';

interface Run {
  id: string;
  status: string;
  command: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  error_message: string | null;
  artifacts: Artifact[];
}

interface Event {
  id: number;
  type: string;
  data: string;
  timestamp: number;
}

interface Artifact {
  id: string;
  name: string;
  type: string;
  size: number;
}

interface Props {
  user: { id: string; username: string; role: string } | null;
}

const ALLOWED_COMMANDS = [
  'npm test',
  'git diff',
  'git status',
  'git log --oneline -10',
  'ls -la'
];

function RunDetail({ user }: Props) {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [assistUrl, setAssistUrl] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastEventId = useRef(0);

  useEffect(() => {
    fetchRun();
    fetchEvents();
    connectWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [runId]);

  useEffect(() => {
    // Auto-scroll to bottom when new events arrive
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events]);

  async function fetchRun() {
    try {
      const res = await fetch(`/api/runs/${runId}`);
      if (res.ok) {
        const data = await res.json();
        setRun(data);
      }
    } catch (err) {
      console.error('Failed to fetch run:', err);
    } finally {
      setLoading(false);
    }
  }

  async function fetchEvents() {
    try {
      const res = await fetch(`/api/runs/${runId}/events?after=${lastEventId.current}`);
      if (res.ok) {
        const newEvents = await res.json();
        if (newEvents.length > 0) {
          setEvents((prev) => [...prev, ...newEvents]);
          lastEventId.current = newEvents[newEvents.length - 1].id;

          // Check for assist events
          for (const event of newEvents) {
            if (event.type === 'assist') {
              try {
                const data = JSON.parse(event.data);
                setAssistUrl(data.url);
              } catch {}
            }
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch events:', err);
    }
  }

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: 'subscribe', runId }));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === 'event') {
          setEvents((prev) => [
            ...prev,
            {
              id: data.eventId,
              type: data.eventType,
              data: data.data,
              timestamp: data.timestamp
            }
          ]);
          lastEventId.current = data.eventId;

          // Check for assist events
          if (data.eventType === 'assist') {
            try {
              const parsed = JSON.parse(data.data);
              setAssistUrl(parsed.url);
            } catch {}
          }
        } else if (data.type === 'command_completed') {
          // Refresh run status
          fetchRun();
        }
      } catch {}
    };

    ws.onclose = () => {
      setConnected(false);
      // Reconnect after delay
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
      setConnected(false);
    };

    wsRef.current = ws;
  }

  async function sendCommand(command: string) {
    try {
      const res = await fetch(`/api/runs/${runId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
      });
      if (!res.ok) {
        const error = await res.json();
        alert(`Failed: ${error.error}`);
      }
    } catch (err) {
      alert('Failed to send command');
    }
  }

  async function requestStop() {
    if (!confirm('Stop this run?')) return;
    try {
      await fetch(`/api/runs/${runId}/stop`, { method: 'POST' });
    } catch (err) {
      alert('Failed to request stop');
    }
  }

  function getEventClass(type: string) {
    switch (type) {
      case 'stdout': return 'log-line-stdout';
      case 'stderr': return 'log-line-stderr';
      case 'info': return 'log-line-info';
      case 'marker': return 'log-line-marker';
      case 'assist': return 'log-line-assist';
      default: return '';
    }
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

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
        <Link to="/" className="btn">Back to runs</Link>
      </div>
    );
  }

  const canOperate = user?.role === 'admin' || user?.role === 'operator';
  const isActive = run.status === 'running';

  return (
    <div>
      <div style={{ marginBottom: '16px' }}>
        <Link to="/" className="btn btn-sm" style={{ marginRight: '12px' }}>
          ← Back
        </Link>
        <span className={`status status-${run.status}`}>
          <span className="status-dot" />
          {run.status}
        </span>
        <span className={`connection-status ${connected ? 'connected' : 'disconnected'}`} style={{ marginLeft: '12px' }}>
          {connected ? '● Live' : '○ Reconnecting...'}
        </span>
      </div>

      {/* Run info */}
      <div className="card">
        <div style={{ display: 'grid', gap: '8px', fontSize: '14px' }}>
          <div>
            <strong>Run ID:</strong> <code>{run.id}</code>
          </div>
          {run.command && (
            <div>
              <strong>Command:</strong> <code>{run.command}</code>
            </div>
          )}
          <div>
            <strong>Created:</strong> {new Date(run.created_at * 1000).toLocaleString()}
          </div>
          {run.started_at && (
            <div>
              <strong>Started:</strong> {new Date(run.started_at * 1000).toLocaleString()}
            </div>
          )}
          {run.finished_at && (
            <div>
              <strong>Finished:</strong> {new Date(run.finished_at * 1000).toLocaleString()}
            </div>
          )}
          {run.exit_code !== null && (
            <div>
              <strong>Exit code:</strong> <code>{run.exit_code}</code>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      {canOperate && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Actions</span>
          </div>
          <div className="btn-group" style={{ flexWrap: 'wrap' }}>
            {isActive && (
              <button className="btn btn-danger" onClick={requestStop}>
                Stop
              </button>
            )}
            {ALLOWED_COMMANDS.map((cmd) => (
              <button
                key={cmd}
                className="btn"
                onClick={() => sendCommand(cmd)}
                disabled={!isActive}
              >
                {cmd}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Assist session */}
      {assistUrl && (
        <div className="card" style={{ borderColor: 'var(--accent-green)' }}>
          <div className="card-header">
            <span className="card-title" style={{ color: 'var(--accent-green)' }}>
              Assist Session Active
            </span>
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: '14px', wordBreak: 'break-all' }}>
            {assistUrl.startsWith('http') ? (
              <a href={assistUrl} target="_blank" rel="noopener" style={{ color: 'var(--accent-blue)' }}>
                {assistUrl}
              </a>
            ) : (
              <code>{assistUrl}</code>
            )}
          </div>
        </div>
      )}

      {/* Log viewer */}
      <div className="log-container">
        <div className="log-header">
          <span>Log Output</span>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            {events.length} events
          </span>
        </div>
        <div className="log-content" ref={logRef}>
          {events.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Waiting for output...
            </div>
          ) : (
            events.map((event) => (
              <div key={event.id} className={`log-line ${getEventClass(event.type)}`}>
                {event.type === 'marker' ? (
                  `▶ ${JSON.parse(event.data).event?.toUpperCase() || event.data}`
                ) : event.type === 'assist' ? (
                  `🔗 Assist: ${JSON.parse(event.data).url || event.data}`
                ) : (
                  event.data
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Artifacts */}
      {run.artifacts && run.artifacts.length > 0 && (
        <div className="card" style={{ marginTop: '16px' }}>
          <div className="card-header">
            <span className="card-title">Artifacts</span>
          </div>
          <ul className="artifact-list">
            {run.artifacts.map((artifact) => (
              <li key={artifact.id} className="artifact-item">
                <div>
                  <span className="artifact-name">{artifact.name}</span>
                  <span className="artifact-size" style={{ marginLeft: '8px' }}>
                    ({formatBytes(artifact.size)})
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
        </div>
      )}
    </div>
  );
}

export default RunDetail;
