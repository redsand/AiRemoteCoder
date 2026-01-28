import { ReactNode } from 'react';

export type Status = 'running' | 'pending' | 'done' | 'failed' | 'stopped' | 'waiting';
export type ConnectionStatus = 'online' | 'offline' | 'degraded';

interface StatusPillProps {
  status: Status | ConnectionStatus;
  size?: 'sm' | 'md' | 'lg';
  showDot?: boolean;
  children?: ReactNode;
}

const statusConfig: Record<string, { bg: string; color: string; label: string }> = {
  running: { bg: 'rgba(59, 185, 80, 0.15)', color: 'var(--accent-green)', label: 'Running' },
  pending: { bg: 'rgba(210, 153, 34, 0.15)', color: 'var(--accent-yellow)', label: 'Pending' },
  done: { bg: 'rgba(88, 166, 255, 0.15)', color: 'var(--accent-blue)', label: 'Done' },
  failed: { bg: 'rgba(248, 81, 73, 0.15)', color: 'var(--accent-red)', label: 'Failed' },
  stopped: { bg: 'rgba(139, 148, 158, 0.15)', color: 'var(--text-secondary)', label: 'Stopped' },
  waiting: { bg: 'rgba(163, 113, 247, 0.15)', color: 'var(--accent-purple)', label: 'Waiting' },
  online: { bg: 'rgba(59, 185, 80, 0.15)', color: 'var(--accent-green)', label: 'Online' },
  offline: { bg: 'rgba(248, 81, 73, 0.15)', color: 'var(--accent-red)', label: 'Offline' },
  degraded: { bg: 'rgba(210, 153, 34, 0.15)', color: 'var(--accent-yellow)', label: 'Degraded' },
};

const sizeConfig = {
  sm: { padding: '2px 8px', fontSize: '11px', dotSize: '6px' },
  md: { padding: '4px 10px', fontSize: '12px', dotSize: '8px' },
  lg: { padding: '6px 14px', fontSize: '14px', dotSize: '10px' },
};

export function StatusPill({ status, size = 'md', showDot = true, children }: StatusPillProps) {
  const config = statusConfig[status] || statusConfig.pending;
  const sizeStyle = sizeConfig[size];
  const isAnimated = status === 'running';

  return (
    <span
      className="status-pill"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: sizeStyle.padding,
        fontSize: sizeStyle.fontSize,
        fontWeight: 500,
        borderRadius: '12px',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        background: config.bg,
        color: config.color,
        whiteSpace: 'nowrap',
      }}
    >
      {showDot && (
        <span
          className={isAnimated ? 'status-dot-pulse' : ''}
          style={{
            width: sizeStyle.dotSize,
            height: sizeStyle.dotSize,
            borderRadius: '50%',
            background: 'currentColor',
            flexShrink: 0,
          }}
        />
      )}
      {children || config.label}
    </span>
  );
}

export default StatusPill;
