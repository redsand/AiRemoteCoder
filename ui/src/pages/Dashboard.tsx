import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { StatusPill, RunCard, type Run } from '../components/ui';

interface NeedsAttention {
  waitingApproval: Run[];
  failedRuns: Run[];
  disconnectedWithRuns: {
    id: string;
    display_name: string;
    last_seen_at: number;
    status: string;
    active_runs: number;
  }[];
  unacknowledgedAlerts: {
    id: string;
    type: string;
    severity: string;
    title: string;
    message: string | null;
    created_at: number;
  }[];
  counts: {
    waitingApproval: number;
    failedRuns: number;
    disconnectedWithRuns: number;
    unacknowledgedAlerts: number;
  };
}

interface ActivityItem {
  type: 'run_event' | 'command' | 'artifact';
  id: string;
  timestamp: number;
  data: any;
}

interface DashboardStats {
  runs: {
    total: number;
    running: number;
    pending: number;
    done: number;
    failed: number;
  };
  clients: {
    total: number;
    online: number;
    offline: number;
  };
  alerts: {
    unacknowledged: number;
  };
  todayEvents: number;
}

interface Props {
  user: { id: string; username: string; role: string } | null;
}

function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function Dashboard({ user: _user }: Props) {
  const navigate = useNavigate();
  const [needsAttention, setNeedsAttention] = useState<NeedsAttention | null>(null);
  const [activeRuns, setActiveRuns] = useState<Run[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, 10000);
    return () => clearInterval(interval);
  }, []);

  async function fetchDashboardData() {
    try {
      const [attentionRes, runsRes, activityRes, statsRes] = await Promise.all([
        fetch('/api/dashboard/needs-attention'),
        fetch('/api/dashboard/active-runs?limit=8'),
        fetch('/api/dashboard/activity?limit=20'),
        fetch('/api/dashboard/stats'),
      ]);

      if (attentionRes.ok) {
        setNeedsAttention(await attentionRes.json());
      }
      if (runsRes.ok) {
        setActiveRuns(await runsRes.json());
      }
      if (activityRes.ok) {
        setActivity(await activityRes.json());
      }
      if (statsRes.ok) {
        setStats(await statsRes.json());
      }
    } catch (err) {
      console.error('Failed to fetch dashboard data:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
      </div>
    );
  }

  const totalAttention = needsAttention
    ? needsAttention.counts.waitingApproval +
      needsAttention.counts.failedRuns +
      needsAttention.counts.disconnectedWithRuns
    : 0;

  return (
    <div className="dashboard">
      {/* Stats row */}
      {stats && (
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-value">{stats.runs.running}</div>
            <div className="stat-label">Running</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.clients.online}</div>
            <div className="stat-label">Clients Online</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: totalAttention > 0 ? 'var(--accent-red)' : undefined }}>
              {totalAttention}
            </div>
            <div className="stat-label">Need Attention</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.todayEvents}</div>
            <div className="stat-label">Events Today</div>
          </div>
        </div>
      )}

      {/* Needs Attention Section */}
      {totalAttention > 0 && (
        <section className="dashboard-section">
          <h2 className="section-title">
            <span style={{ color: 'var(--accent-red)' }}>\u26A0</span> Needs Attention
          </h2>

          {/* Waiting Approval */}
          {needsAttention && needsAttention.waitingApproval.length > 0 && (
            <div className="attention-group">
              <h3 className="attention-title">
                <span className="attention-badge" style={{ background: 'var(--accent-purple)' }}>
                  {needsAttention.waitingApproval.length}
                </span>
                Waiting Approval
              </h3>
              <div className="attention-items">
                {needsAttention.waitingApproval.slice(0, 3).map((run) => (
                  <RunCard key={run.id} run={run as Run} compact />
                ))}
                {needsAttention.waitingApproval.length > 3 && (
                  <button
                    className="btn btn-sm"
                    onClick={() => navigate('/runs?waitingApproval=true')}
                  >
                    View all {needsAttention.waitingApproval.length} waiting
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Failed Runs */}
          {needsAttention && needsAttention.failedRuns.length > 0 && (
            <div className="attention-group">
              <h3 className="attention-title">
                <span className="attention-badge" style={{ background: 'var(--accent-red)' }}>
                  {needsAttention.failedRuns.length}
                </span>
                Failed Runs (24h)
              </h3>
              <div className="attention-items">
                {needsAttention.failedRuns.slice(0, 3).map((run) => (
                  <RunCard key={run.id} run={run as Run} compact />
                ))}
                {needsAttention.failedRuns.length > 3 && (
                  <button
                    className="btn btn-sm"
                    onClick={() => navigate('/runs?status=failed')}
                  >
                    View all {needsAttention.failedRuns.length} failed
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Disconnected Clients */}
          {needsAttention && needsAttention.disconnectedWithRuns.length > 0 && (
            <div className="attention-group">
              <h3 className="attention-title">
                <span className="attention-badge" style={{ background: 'var(--accent-yellow)' }}>
                  {needsAttention.disconnectedWithRuns.length}
                </span>
                Clients Offline with Active Runs
              </h3>
              <div className="attention-items">
                {needsAttention.disconnectedWithRuns.map((client) => (
                  <div
                    key={client.id}
                    className="attention-item"
                    onClick={() => navigate(`/clients/${client.id}`)}
                    style={{ cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <StatusPill status="offline" size="sm" />
                      <span>{client.display_name}</span>
                    </div>
                    <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                      {client.active_runs} active runs
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Active Runs Section */}
      <section className="dashboard-section">
        <div className="section-header">
          <h2 className="section-title">Active Runs</h2>
          <button className="btn btn-sm" onClick={() => navigate('/runs')}>
            View All
          </button>
        </div>

        {activeRuns.length === 0 ? (
          <div className="empty-state-small">
            No active runs at the moment.
          </div>
        ) : (
          <div className="run-list">
            {activeRuns.map((run) => (
              <RunCard key={run.id} run={run as Run} />
            ))}
          </div>
        )}
      </section>

      {/* Recent Activity Section */}
      <section className="dashboard-section">
        <div className="section-header">
          <h2 className="section-title">Recent Activity</h2>
        </div>

        {activity.length === 0 ? (
          <div className="empty-state-small">
            No recent activity.
          </div>
        ) : (
          <div className="activity-list">
            {activity.map((item) => (
              <ActivityListItem key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ActivityListItem({ item }: { item: ActivityItem }) {
  const navigate = useNavigate();

  const getActivityContent = () => {
    switch (item.type) {
      case 'run_event':
        try {
          const eventData = JSON.parse(item.data.eventData || '{}');
          const eventName = eventData.event?.toUpperCase() || 'EVENT';
          return {
            icon: eventName === 'STARTED' ? '\u25B6' : eventName === 'FINISHED' ? '\u2713' : '\u2022',
            text: `Run ${eventName.toLowerCase()}`,
            subtext: item.data.runLabel || item.data.runId,
            color: eventName === 'FINISHED' && eventData.exitCode === 0
              ? 'var(--accent-green)'
              : eventName === 'FINISHED'
                ? 'var(--accent-red)'
                : 'var(--accent-blue)',
            onClick: () => navigate(`/runs/${item.data.runId}`),
          };
        } catch {
          return {
            icon: '\u2022',
            text: 'Run event',
            subtext: item.data.runId,
            color: 'var(--text-secondary)',
            onClick: () => navigate(`/runs/${item.data.runId}`),
          };
        }

      case 'command':
        return {
          icon: '\u2318',
          text: item.data.status === 'completed' ? 'Command completed' : 'Command queued',
          subtext: item.data.command,
          color: item.data.status === 'completed' ? 'var(--accent-green)' : 'var(--accent-yellow)',
          onClick: () => navigate(`/runs/${item.data.runId}`),
        };

      case 'artifact':
        return {
          icon: '\uD83D\uDCCE',
          text: 'Artifact uploaded',
          subtext: item.data.name,
          color: 'var(--accent-blue)',
          onClick: () => navigate(`/runs/${item.data.runId}`),
        };

      default:
        return {
          icon: '\u2022',
          text: 'Activity',
          subtext: '',
          color: 'var(--text-secondary)',
          onClick: () => {},
        };
    }
  };

  const content = getActivityContent();

  return (
    <div
      className="activity-item"
      onClick={content.onClick}
      style={{ cursor: 'pointer' }}
    >
      <span
        style={{
          width: '24px',
          textAlign: 'center',
          color: content.color,
          flexShrink: 0,
        }}
      >
        {content.icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '13px' }}>{content.text}</div>
        <div
          style={{
            fontSize: '12px',
            color: 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {content.subtext}
        </div>
      </div>
      <span style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>
        {formatRelativeTime(item.timestamp)}
      </span>
    </div>
  );
}

export default Dashboard;
