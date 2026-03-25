import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../components/ui';
import type { McpActiveSession } from '../features/mcp/types';

interface Props {
  user: { id: string; username: string; role: string } | null;
}

export function Clients(_props: Props) {
  const { addToast } = useToast();
  const [sessions, setSessions] = useState<McpActiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/mcp/sessions');
      if (!res.ok) return;
      const payload = await res.json();
      const list = Array.isArray(payload.sessions) ? payload.sessions : [];
      setSessions(list);
    } catch {
      addToast('error', 'Failed to load MCP runners');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 10000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return sessions;
    return sessions.filter((session) => (
      session.id.toLowerCase().includes(term)
      || (session.provider ?? '').toLowerCase().includes(term)
      || session.user.username.toLowerCase().includes(term)
      || session.user.role.toLowerCase().includes(term)
    ));
  }, [search, sessions]);

  return (
    <div className="clients-page">
      <div className="page-header">
        <div style={{ width: '100%' }}>
          <h2 className="page-title">Connected MCP Runners</h2>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            MCP hosts and the helper runner are the only supported runtime path.
          </div>
          <div style={{ marginTop: '10px', display: 'flex', gap: '12px', fontSize: '13px', color: 'var(--text-secondary)' }}>
            <span style={{ color: 'var(--accent-green)' }}>● {sessions.length} active sessions</span>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '12px' }}>
        <div className="form-row">
          <input
            type="text"
            className="form-input"
            placeholder="Search by provider, user, role, or session id..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn btn-secondary" onClick={() => fetchSessions()}>
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="loading">
          <div className="spinner" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <h2>No MCP runners connected</h2>
          <p>Connect Codex/Claude/Gemini/OpenCode/Zenflow/Rev from the MCP page, then start runs.</p>
        </div>
      ) : (
        <div className="client-list">
          {filtered.map((session) => (
            <div key={session.id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {(session.provider ?? 'unknown').toUpperCase()} runner
                  </div>
                  <div className="text-muted" style={{ fontSize: '12px' }}>
                    session {session.id}
                  </div>
                </div>
                <span className="badge-green">connected</span>
              </div>
              <div style={{ marginTop: '10px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                User: {session.user.username} ({session.user.role})
              </div>
              <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>
                Last seen {new Date(session.lastSeenAt * 1000).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default Clients;
