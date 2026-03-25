import { buildRunnerCommandSnippet } from '../../features/mcp/runner-command';
import { supportsRunnerProvider } from '../../features/mcp/providers';

interface PendingRunnerPanelProps {
  workerType?: string | null;
  runnerId?: string | null;
  gatewayUrl?: string;
}

export function PendingRunnerPanel({
  workerType,
  runnerId,
  gatewayUrl,
}: PendingRunnerPanelProps) {
  const provider = String(workerType ?? '').toLowerCase();
  const trimmedRunnerId = runnerId?.trim() ?? '';

  if (!trimmedRunnerId || !supportsRunnerProvider(provider)) {
    return null;
  }

  const snippet = buildRunnerCommandSnippet(provider, trimmedRunnerId, gatewayUrl);

  return (
    <div
      style={{
        padding: '14px 16px',
        background: 'rgba(47, 129, 247, 0.08)',
        border: '1px solid var(--accent-blue)',
        borderRadius: '8px',
        marginBottom: '16px',
      }}
    >
      <div style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--accent-blue)' }}>
        Runner Setup
      </div>
      <div style={{ fontSize: '16px', fontWeight: 600, marginTop: '4px' }}>
        Launch or restart the {provider.toUpperCase()} helper
      </div>
      <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px', marginBottom: '12px' }}>
        Keep these commands with the run. If the host reboots, the helper stops, or you need to reconnect later, run one of these commands on the target machine with the same runner identity.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' }}>
        <div>
          <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px' }}>PowerShell</div>
          <pre
            style={{
              margin: 0,
              padding: '12px',
              borderRadius: '6px',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              overflowX: 'auto',
              fontSize: '12px',
              lineHeight: '1.5',
            }}
          >
            {snippet.powershell}
          </pre>
        </div>

        <div>
          <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px' }}>Bash</div>
          <pre
            style={{
              margin: 0,
              padding: '12px',
              borderRadius: '6px',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              overflowX: 'auto',
              fontSize: '12px',
              lineHeight: '1.5',
            }}
          >
            {snippet.bash}
          </pre>
        </div>
      </div>
    </div>
  );
}

export default PendingRunnerPanel;
