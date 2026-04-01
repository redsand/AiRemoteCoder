import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

interface ProjectSummary {
  path: string;
  display: string;
  totalRuns: number;
  runningRuns: number;
  failedRuns: number;
  lastActive: number;
}

interface Props {
  user: { id: string; username: string; role: string } | null;
}

function formatRelativeTime(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, '/').replace(/\/$/, '').split('/');
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : parts[parts.length - 1];
}

export function Projects({ user: _user }: Props) {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects ?? []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
    const interval = setInterval(fetchProjects, 15000);
    return () => clearInterval(interval);
  }, [fetchProjects]);

  if (loading) {
    return <div className="loading"><div className="spinner" /></div>;
  }

  if (projects.length === 0) {
    return (
      <div className="page">
        <div className="page-header">
          <h2>Projects</h2>
        </div>
        <div className="empty-state">
          <h2>No projects yet</h2>
          <p>Projects appear here once runs have been created with a working directory.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>Projects</h2>
        <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{projects.length} project{projects.length !== 1 ? 's' : ''}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px' }}>
        {projects.map((proj) => (
          <div
            key={proj.path}
            onClick={() => navigate(`/runs?repo=${encodeURIComponent(proj.path)}`)}
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              padding: '16px',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-blue)'; e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.background = 'var(--bg-secondary)'; }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', marginBottom: '10px' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: '15px', marginBottom: '2px' }}>{shortenPath(proj.path)}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'monospace', wordBreak: 'break-all' }}>{proj.path}</div>
              </div>
              {proj.runningRuns > 0 && (
                <span style={{ padding: '2px 8px', fontSize: '11px', fontWeight: 700, background: 'rgba(59,185,80,0.15)', color: 'var(--accent-green)', borderRadius: '12px', whiteSpace: 'nowrap' }}>
                  ● {proj.runningRuns} running
                </span>
              )}
            </div>

            <div style={{ display: 'flex', gap: '16px', fontSize: '13px' }}>
              <div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '11px', marginBottom: '2px' }}>Total runs</div>
                <div style={{ fontWeight: 600 }}>{proj.totalRuns}</div>
              </div>
              {proj.failedRuns > 0 && (
                <div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '11px', marginBottom: '2px' }}>Failed</div>
                  <div style={{ fontWeight: 600, color: 'var(--accent-red)' }}>{proj.failedRuns}</div>
                </div>
              )}
              <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                <div style={{ color: 'var(--text-secondary)', fontSize: '11px', marginBottom: '2px' }}>Last active</div>
                <div style={{ fontWeight: 600, fontSize: '12px' }}>{formatRelativeTime(proj.lastActive)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default Projects;
