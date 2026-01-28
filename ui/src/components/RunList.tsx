import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface Run {
  id: string;
  status: string;
  command: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
}

interface Props {
  user: { id: string; username: string; role: string } | null;
}

function RunList({ user }: Props) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchRuns();
    const interval = setInterval(fetchRuns, 5000);
    return () => clearInterval(interval);
  }, []);

  async function fetchRuns() {
    try {
      const res = await fetch('/api/runs');
      if (res.ok) {
        const data = await res.json();
        setRuns(data);
      }
    } catch (err) {
      console.error('Failed to fetch runs:', err);
    } finally {
      setLoading(false);
    }
  }

  async function createRun() {
    const command = prompt('Enter Claude command (optional):');
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command || undefined })
      });
      if (res.ok) {
        const data = await res.json();
        // Show the command to run
        alert(
          `Run created!\n\n` +
          `Run ID: ${data.id}\n` +
          `Token: ${data.capabilityToken}\n\n` +
          `Start the wrapper with:\n` +
          `./wrapper/claude-runner start --run-id ${data.id} --token ${data.capabilityToken}` +
          (command ? ` --cmd "${command}"` : '')
        );
        fetchRuns();
      }
    } catch (err) {
      console.error('Failed to create run:', err);
      alert('Failed to create run');
    }
  }

  function formatTime(timestamp: number | null) {
    if (!timestamp) return '-';
    return new Date(timestamp * 1000).toLocaleString();
  }

  function getStatusClass(status: string) {
    switch (status) {
      case 'running': return 'status-running';
      case 'pending': return 'status-pending';
      case 'done': return 'status-done';
      case 'failed': return 'status-failed';
      default: return '';
    }
  }

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
      </div>
    );
  }

  const canOperate = user?.role === 'admin' || user?.role === 'operator';

  return (
    <div>
      <div className="card-header" style={{ marginBottom: '16px' }}>
        <h2 className="card-title">Runs</h2>
        {canOperate && (
          <button className="btn btn-primary" onClick={createRun}>
            New Run
          </button>
        )}
      </div>

      {runs.length === 0 ? (
        <div className="empty-state">
          <h2>No runs yet</h2>
          <p>Create a new run to get started.</p>
        </div>
      ) : (
        <ul className="run-list">
          {runs.map((run) => (
            <li
              key={run.id}
              className="run-item"
              onClick={() => navigate(`/runs/${run.id}`)}
            >
              <div className="run-info">
                <div className="run-id">{run.id}</div>
                <div className="run-meta">
                  <span>{formatTime(run.created_at)}</span>
                  {run.command && (
                    <span style={{ fontFamily: 'monospace' }}>
                      {run.command.slice(0, 50)}
                      {run.command.length > 50 ? '...' : ''}
                    </span>
                  )}
                </div>
              </div>
              <span className={`status ${getStatusClass(run.status)}`}>
                <span className="status-dot" />
                {run.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default RunList;
