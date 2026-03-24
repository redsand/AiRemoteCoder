import type { McpConfig } from '../../features/mcp/types';

interface Props {
  mcpConfig: McpConfig | null;
  connectedCount: number;
  activeTokens: number;
  onOpenMcp: () => void;
  onOpenTokens: () => void;
  onCopyUrl: () => void;
  copiedUrl: boolean;
}

export function McpSpotlight({
  mcpConfig,
  connectedCount,
  activeTokens,
  onOpenMcp,
  onOpenTokens,
  onCopyUrl,
  copiedUrl,
}: Props) {
  return (
    <section className="mcp-spotlight card">
      <div className="mcp-spotlight-header">
        <div>
          <div className="eyebrow">Primary control plane</div>
          <h2 className="mcp-spotlight-title">MCP-first operations</h2>
          <p className="mcp-spotlight-copy">
            Connect Claude, Codex, Gemini, OpenCode, Zenflow, and Rev through one remote MCP endpoint.
            The gateway is the source of truth; the phone stays the human control surface.
          </p>
        </div>
        <div className={`mcp-spotlight-state ${mcpConfig?.enabled ? 'online' : 'offline'}`}>
          <span className="status-dot" />
          <span>{mcpConfig?.enabled ? 'MCP active' : 'MCP disabled'}</span>
        </div>
      </div>

      <div className="mcp-spotlight-grid">
        <div className="mcp-spotlight-stat">
          <span className="mcp-spotlight-stat-value">{connectedCount}</span>
          <span className="mcp-spotlight-stat-label">connected agents</span>
        </div>
        <div className="mcp-spotlight-stat">
          <span className="mcp-spotlight-stat-value">{activeTokens}</span>
          <span className="mcp-spotlight-stat-label">active tokens</span>
        </div>
        <div className="mcp-spotlight-stat">
          <span className="mcp-spotlight-stat-value">{mcpConfig?.transport ?? 'n/a'}</span>
          <span className="mcp-spotlight-stat-label">transport</span>
        </div>
        <div className="mcp-spotlight-stat">
          <span className="mcp-spotlight-stat-value">{mcpConfig?.specVersion ?? 'n/a'}</span>
          <span className="mcp-spotlight-stat-label">spec</span>
        </div>
      </div>

      <div className="btn-group mcp-spotlight-actions">
        <button className="btn btn-primary" onClick={onOpenMcp}>
          Open MCP setup
        </button>
        <button className="btn" onClick={onOpenTokens}>
          Manage tokens
        </button>
        <button className="btn" onClick={onCopyUrl} disabled={!mcpConfig?.url}>
          {copiedUrl ? '✓ MCP URL copied' : 'Copy MCP URL'}
        </button>
      </div>

      {mcpConfig?.url && (
        <div className="mcp-spotlight-url">
          <span className="text-muted">Remote endpoint</span>
          <code>{mcpConfig.url}</code>
        </div>
      )}
    </section>
  );
}

export default McpSpotlight;

