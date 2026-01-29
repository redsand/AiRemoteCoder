import { useNavigate } from 'react-router-dom';
import { StatusPill, ConnectionStatus } from './StatusPill';

export interface Client {
  id: string;
  display_name: string;
  agent_id: string;
  last_seen_at: number;
  created_at?: number;
  version?: string | null;
  capabilities?: string[] | null;
  status: ConnectionStatus;
  operator_enabled: number;
  runCounts?: {
    total: number;
    running: number;
    failed: number;
  };
}

interface ClientCardProps {
  client: Client;
  compact?: boolean;
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

export function ClientCard({ client, compact = false, onClick }: ClientCardProps) {
  const navigate = useNavigate();
  const handleClick = onClick || (() => navigate(`/clients/${client.id}`));

  return (
    <div
      className="client-card"
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
        width: '100%',
        minWidth: 0,
        overflow: 'hidden',
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
      aria-label={`Client ${client.display_name}, status: ${client.status}`}
    >
      {/* Status indicator */}
      <div
        style={{
          width: compact ? '12px' : '48px',
          height: compact ? '12px' : '48px',
          borderRadius: compact ? '50%' : '12px',
          background: client.status === 'online'
            ? 'rgba(59, 185, 80, 0.15)'
            : client.status === 'degraded'
              ? 'rgba(210, 153, 34, 0.15)'
              : 'rgba(248, 81, 73, 0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {!compact && (
          <span style={{ fontSize: '24px' }}>💻</span>
        )}
      </div>

      {/* Main info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: compact ? 0 : '4px' }}>
          <span
            style={{
              fontSize: '15px',
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            {client.display_name}
          </span>
          <StatusPill status={client.status} size="sm" />
        </div>

        {!compact && (
          <>
            <div
              style={{
                fontSize: '12px',
                color: 'var(--text-secondary)',
                fontFamily: 'monospace',
                marginBottom: '8px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={client.agent_id}
            >
              {client.agent_id}
            </div>

            <div
              style={{
                fontSize: '12px',
                color: 'var(--text-secondary)',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '12px',
                alignItems: 'center',
              }}
            >
              <span>Last seen: {formatRelativeTime(client.last_seen_at)}</span>
              {client.version && <span>v{client.version}</span>}
              {!client.operator_enabled && (
                <span style={{ color: 'var(--accent-yellow)' }}>
                  ⚠ Operator disabled
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Run counts */}
      {client.runCounts && (
        <div
          style={{
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          {client.runCounts.running > 0 && (
            <span
              title="Active runs"
              style={{
                padding: '4px 8px',
                fontSize: '12px',
                background: 'rgba(59, 185, 80, 0.15)',
                borderRadius: '4px',
                color: 'var(--accent-green)',
                fontWeight: 500,
              }}
            >
              {client.runCounts.running} running
            </span>
          )}
          {client.runCounts.failed > 0 && (
            <span
              title="Failed runs"
              style={{
                padding: '4px 8px',
                fontSize: '12px',
                background: 'rgba(248, 81, 73, 0.15)',
                borderRadius: '4px',
                color: 'var(--accent-red)',
                fontWeight: 500,
              }}
            >
              {client.runCounts.failed} failed
            </span>
          )}
          {client.runCounts.total > 0 && client.runCounts.running === 0 && client.runCounts.failed === 0 && (
            <span
              style={{
                fontSize: '12px',
                color: 'var(--text-muted)',
              }}
            >
              {client.runCounts.total} runs
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// List variant for tables
export function ClientRow({ client, onClick }: ClientCardProps) {
  const navigate = useNavigate();
  const handleClick = onClick || (() => navigate(`/clients/${client.id}`));

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
        <div style={{ fontWeight: 500 }}>{client.display_name}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
          {client.agent_id}
        </div>
      </td>
      <td style={{ padding: '10px 12px' }}>
        <StatusPill status={client.status} size="sm" />
      </td>
      <td style={{ padding: '10px 12px' }}>
        {client.runCounts?.running || 0} / {client.runCounts?.total || 0}
      </td>
      <td style={{ padding: '10px 12px', fontSize: '12px', color: 'var(--text-secondary)' }}>
        {formatRelativeTime(client.last_seen_at)}
      </td>
    </tr>
  );
}

export default ClientCard;
