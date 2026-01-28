interface ConnectionIndicatorProps {
  connected: boolean;
  reconnecting?: boolean;
}

export function ConnectionIndicator({ connected, reconnecting }: ConnectionIndicatorProps) {
  const status = connected ? 'connected' : reconnecting ? 'reconnecting' : 'disconnected';

  const config = {
    connected: { color: 'var(--accent-green)', icon: '\u25CF', text: 'Live' },
    reconnecting: { color: 'var(--accent-yellow)', icon: '\u25CB', text: 'Reconnecting...' },
    disconnected: { color: 'var(--accent-red)', icon: '\u25CB', text: 'Disconnected' },
  };

  const c = config[status];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '12px',
        color: c.color,
      }}
      aria-label={`Connection status: ${c.text}`}
    >
      <span style={{ fontSize: '10px' }}>{c.icon}</span>
      {c.text}
    </span>
  );
}

export default ConnectionIndicator;
