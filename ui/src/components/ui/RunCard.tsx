import { useNavigate } from 'react-router-dom';
import { StatusPill, Status } from './StatusPill';

export interface Run {
  id: string;
  status: Status;
  label?: string | null;
  command?: string | null;
  repo_name?: string | null;
  repo_path?: string | null;
  client_id?: string | null;
  client_name?: string | null;
  client_status?: string | null;
  created_at: number;
  started_at?: number | null;
  finished_at?: number | null;
  waiting_approval?: number;
  artifact_count?: number;
  hasAssist?: boolean;
  duration?: number | null;
  worker_type?: string | null;
  metadata?: {
    model?: string;
    workerType?: string;
  } | null;
}

interface RunCardProps {
  run: Run;
  compact?: boolean;
  showClient?: boolean;
  onClick?: () => void;
}

function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function getWorkerIcon(workerType: string | null): string {
  const icons: Record<string, string> = {
    claude: '',
    ollama: '',
    'ollama-launch': '',
    codex: '',
    gemini: '',
    rev: '',
    vnc: '',
    'hands-on': ''
  };
  return icons[workerType || 'claude'] || '';
}

function getWorkerColor(workerType: string | null): string {
  const colors: Record<string, string> = {
    claude: '#D97706', // amber
    ollama: '#059669', // emerald
    'ollama-launch': '#9333EA', // purple
    codex: '#0891B2', // cyan
    gemini: '#7C3AED', // violet
    rev: '#DC2626', // red
    vnc: '#0891B2', // cyan (same as codex - remote desktop)
    'hands-on': '#F59E0B' // amber (manual control)
  };
  return colors[workerType || 'claude'] || '#6B7280';
}

export function RunCard({ run, compact = false, showClient = true, onClick }: RunCardProps) {
  const navigate = useNavigate();
  const handleClick = onClick || (() => navigate(`/runs/${run.id}`));

  const displayTitle = run.label || run.command?.slice(0, 60) || `Run ${run.id}`;
  const needsApproval = run.waiting_approval === 1;
  const workerType = run.worker_type || run.metadata?.workerType || 'claude';
  const workerIcon = getWorkerIcon(workerType);
  const workerColor = getWorkerColor(workerType);
  // Format worker display name: capitalize first letter, handle hyphens
  const workerDisplayName = workerType
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return (
    <div
      className="run-card"
      onClick={handleClick}
      style={{
        display: 'flex',
        flexDirection: compact ? 'row' : 'column',
        alignItems: compact ? 'center' : 'flex-start',
        gap: compact ? '12px' : '8px',
        padding: compact ? '10px 12px' : '14px 16px',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: '8px',
        cursor: 'pointer',
        transition: 'all 0.15s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--accent-blue)';
        e.currentTarget.style.background = 'var(--bg-tertiary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-color)';
        e.currentTarget.style.background = 'var(--bg-secondary)';
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      aria-label={`Run ${run.id}, status: ${run.status}`}
    >
      {/* Main info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: compact ? 0 : '4px' }}>
          <span
            style={{
              fontFamily: 'monospace',
              fontSize: '14px',
              fontWeight: 600,
              color: 'var(--accent-blue)',
            }}
          >
            {run.id}
          </span>
          <StatusPill status={run.status} size="sm" />
          <span
            style={{
              padding: '2px 6px',
              fontSize: '11px',
              fontWeight: 600,
              background: `${workerColor}20`,
              color: workerColor,
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            {workerIcon}
            {workerDisplayName}
          </span>
          {needsApproval && (
            <span
              style={{
                padding: '2px 6px',
                fontSize: '10px',
                fontWeight: 600,
                background: 'var(--accent-purple)',
                color: 'white',
                borderRadius: '4px',
              }}
            >
              NEEDS APPROVAL
            </span>
          )}
        </div>

        {!compact && (
          <>
            <div
              style={{
                fontSize: '14px',
                color: 'var(--text-primary)',
                marginBottom: '6px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {displayTitle}
            </div>

            <div
              style={{
                fontSize: '12px',
                color: 'var(--text-secondary)',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px',
                alignItems: 'center',
              }}
            >
              {showClient && run.client_name && (
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '10px' }}>\uD83D\uDCBB</span>
                  {run.client_name}
                </span>
              )}
              {run.repo_name && (
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '10px' }}>\uD83D\uDCC1</span>
                  {run.repo_name}
                </span>
              )}
              <span>{formatRelativeTime(run.created_at)}</span>
              {run.duration && run.status === 'running' && (
                <span style={{ color: 'var(--accent-green)' }}>
                  {formatDuration(run.duration)}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Badges */}
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
        {run.artifact_count && run.artifact_count > 0 && (
          <span
            title={`${run.artifact_count} artifacts`}
            style={{
              padding: '2px 6px',
              fontSize: '11px',
              background: 'var(--bg-tertiary)',
              borderRadius: '4px',
              color: 'var(--text-secondary)',
            }}
          >
            \uD83D\uDCCE {run.artifact_count}
          </span>
        )}
        {run.hasAssist && (
          <span
            title="Assist session available"
            style={{
              padding: '2px 6px',
              fontSize: '11px',
              background: 'rgba(59, 185, 80, 0.15)',
              borderRadius: '4px',
              color: 'var(--accent-green)',
            }}
          >
            \uD83D\uDD17 Assist
          </span>
        )}
      </div>
    </div>
  );
}

// List variant for tables
export function RunRow({ run, showClient = true, onClick }: RunCardProps) {
  const navigate = useNavigate();
  const handleClick = onClick || (() => navigate(`/runs/${run.id}`));

  return (
    <tr
      onClick={handleClick}
      style={{ cursor: 'pointer' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-tertiary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = '';
      }}
    >
      <td style={{ padding: '10px 12px' }}>
        <span style={{ fontFamily: 'monospace', color: 'var(--accent-blue)' }}>{run.id}</span>
      </td>
      <td style={{ padding: '10px 12px' }}>
        <StatusPill status={run.status} size="sm" />
      </td>
      <td style={{ padding: '10px 12px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {run.label || run.command?.slice(0, 40) || '-'}
      </td>
      {showClient && (
        <td style={{ padding: '10px 12px' }}>{run.client_name || '-'}</td>
      )}
      <td style={{ padding: '10px 12px', fontSize: '12px', color: 'var(--text-secondary)' }}>
        {formatRelativeTime(run.created_at)}
      </td>
    </tr>
  );
}

export default RunCard;
