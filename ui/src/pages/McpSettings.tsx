import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../components/ui';
import McpProviderGrid from '../components/mcp/McpProviderGrid';
import { MCP_PROVIDERS, type McpProviderKey } from '../features/mcp/providers';
import type { McpConfig, McpProviderSetupState, McpSetupStatus, McpToken } from '../features/mcp/types';

interface Props {
  user: { id: string; username: string; role: string } | null;
}

export function McpSettings(_props: Props) {
  const { addToast } = useToast();
  const navigate = useNavigate();

  const [mcpConfig, setMcpConfig] = useState<McpConfig | null>(null);
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [setupStatus, setSetupStatus] = useState<Record<string, McpSetupStatus>>({});
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'connect' | 'tokens' | 'test'>('connect');
  const [installingProvider, setInstallingProvider] = useState<McpProviderKey | null>(null);
  const [providerSetup, setProviderSetup] = useState<Record<string, McpProviderSetupState>>({});
  const [newTokenLabel, setNewTokenLabel] = useState('');
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [configRes, tokensRes, statusRes] = await Promise.all([
        fetch('/api/mcp/config'),
        fetch('/api/mcp/tokens'),
        fetch('/api/mcp/setup/status'),
      ]);
      if (configRes.ok) setMcpConfig(await configRes.json());
      if (tokensRes.ok) setTokens((await tokensRes.json()).tokens ?? []);
      if (statusRes.ok) setSetupStatus((await statusRes.json()).status ?? {});
    } catch {
      addToast('error', 'Failed to load MCP configuration');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  async function setupProvider(providerKey: McpProviderKey) {
    setInstallingProvider(providerKey);
    try {
      const setupRes = await fetch(`/api/mcp/setup/${providerKey}`, { method: 'POST' });
      if (!setupRes.ok) {
        const err = await setupRes.json();
        setProviderSetup((prev) => ({ ...prev, [providerKey]: { error: err.error } }));
        addToast('error', `Setup failed: ${err.error}`);
        return;
      }

      const setup = await setupRes.json();
      if (setup.canAutoInstall) {
        const installRes = await fetch(`/api/mcp/setup/${providerKey}/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: setup.token }),
        });
        const install = await installRes.json();

        if (installRes.ok && install.installed) {
          setProviderSetup((prev) => ({
            ...prev,
            [providerKey]: {
              token: setup.token,
              snippet: setup.snippet,
              filePath: install.filePath,
              installed: true,
            },
          }));
          addToast('success', `${providerKey} MCP config installed at ${install.filePath}`);
        } else {
          setProviderSetup((prev) => ({
            ...prev,
            [providerKey]: {
              token: setup.token,
              snippet: setup.snippet,
              filePath: install.filePath,
              installed: false,
              error: install.error,
            },
          }));
          addToast('warning', 'Auto-install failed. Use manual config below.');
        }
      } else {
        setProviderSetup((prev) => ({
          ...prev,
          [providerKey]: { token: setup.token, snippet: setup.snippet, filePath: null, installed: false },
        }));
      }

      const statusRes = await fetch('/api/mcp/setup/status');
      if (statusRes.ok) setSetupStatus((await statusRes.json()).status ?? {});
      await fetchAll();
    } catch (e: any) {
      addToast('error', `Setup error: ${e.message}`);
    } finally {
      setInstallingProvider(null);
    }
  }

  async function createToken() {
    if (!newTokenLabel.trim()) {
      addToast('error', 'Token label is required');
      return;
    }

    const res = await fetch('/api/mcp/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: newTokenLabel.trim() }),
    });
    if (res.ok) {
      const data = await res.json();
      setCreatedToken(data.token);
      setNewTokenLabel('');
      await fetchAll();
      addToast('success', 'Token created — copy it now');
    } else {
      const err = await res.json();
      addToast('error', err.error || 'Failed to create token');
    }
  }

  async function revokeToken(id: string) {
    setRevokingId(id);
    const res = await fetch(`/api/mcp/tokens/${id}`, { method: 'DELETE' });
    if (res.ok) {
      await fetchAll();
      addToast('success', 'Token revoked');
    } else {
      addToast('error', 'Failed to revoke token');
    }
    setRevokingId(null);
  }

  async function copyToClipboard(text: string, field: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      addToast('error', 'Clipboard access denied');
    }
  }

  if (loading) {
    return (
      <div className="page-content">
        <div className="loading"><div className="spinner" /></div>
      </div>
    );
  }

  const activeTokens = tokens.filter((token) => !token.revoked_at);
  const connectedCount = Object.values(setupStatus).filter((status) => status.hasAiRemoteCoder).length;
  const providerCount = MCP_PROVIDERS.length;

  return (
    <div className="page-content mcp-page">
      <div className="mcp-hero">
        <div className="mcp-hero-text">
          <div className="eyebrow">MVP focus</div>
          <h1>🔌 MCP Control Plane</h1>
          <p>
            Connect your AI coding agents to AiRemoteCoder in seconds.
            MCP is now the primary control path; the legacy wrapper flow is only compatibility support.
          </p>
        </div>
        <div className="mcp-hero-stats">
          <div className="hero-stat">
            <span className="hero-stat-value">{connectedCount}</span>
            <span className="hero-stat-label">agents connected</span>
          </div>
          <div className="hero-stat">
            <span className="hero-stat-value">{activeTokens.length}</span>
            <span className="hero-stat-label">active tokens</span>
          </div>
          <div className="hero-stat">
            <span className="hero-stat-value">{providerCount}</span>
            <span className="hero-stat-label">supported environments</span>
          </div>
          <div className={`hero-stat-status ${mcpConfig?.enabled ? 'online' : 'offline'}`}>
            <span className="status-dot" />
            <span>{mcpConfig?.enabled ? 'MCP Active' : 'MCP Disabled'}</span>
          </div>
        </div>
      </div>

      {!mcpConfig?.enabled && (
        <div className="alert alert-warning">
          MCP is disabled. Set <code>AIRC_MCP_ENABLED=true</code> and restart the gateway.
        </div>
      )}

      {mcpConfig?.legacyWrapperDeprecated && (
        <div className="alert alert-warning">
          <strong>Legacy wrapper mode is deprecated</strong> and will be removed after MCP migration confidence is high.
        </div>
      )}

      {mcpConfig?.enabled && (
        <>
          <div className="tab-bar">
            {(['connect', 'tokens', 'test'] as const).map((tab) => (
              <button
                key={tab}
                className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab === 'connect' && '⚡ Connect Agent'}
                {tab === 'tokens' && `🔑 Tokens (${activeTokens.length})`}
                {tab === 'test' && '🧪 Test & Verify'}
              </button>
            ))}
          </div>

          {activeTab === 'connect' && (
            <section className="mcp-connect-tab">
              <p className="text-muted section-intro">
                Auto-install is available for every supported coding environment.
                Click a provider card to configure MCP immediately or copy the snippet manually.
              </p>

              <McpProviderGrid
                mcpConfig={mcpConfig}
                setupStatus={setupStatus}
                providerSetup={providerSetup}
                installingProvider={installingProvider}
                copiedField={copiedField}
                onInstall={(providerKey) => setupProvider(providerKey)}
                onCopy={copyToClipboard}
              />
            </section>
          )}

          {activeTab === 'tokens' && (
            <section className="mcp-tokens-tab">
              {createdToken && (
                <div className="alert alert-success">
                  <strong>✓ Token created</strong> — copy it now, it will not be shown again.
                  <div className="created-token-row">
                    <code className="token-value">{createdToken}</code>
                    <button className="btn btn-sm" onClick={() => copyToClipboard(createdToken, 'new-token')}>
                      {copiedField === 'new-token' ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>
                  <button className="btn btn-sm btn-secondary" onClick={() => setCreatedToken(null)}>
                    Dismiss
                  </button>
                </div>
              )}

              <div className="create-token-form card">
                <h3>Generate Token</h3>
                <div className="form-row">
                  <input
                    type="text"
                    className="input"
                    placeholder='Label (e.g. "My Claude session")'
                    value={newTokenLabel}
                    onChange={(e) => setNewTokenLabel(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && createToken()}
                  />
                  <button className="btn btn-primary" onClick={createToken} disabled={!newTokenLabel.trim()}>
                    Generate
                  </button>
                </div>
                <p className="text-muted" style={{ marginTop: '8px', fontSize: '12px' }}>
                  Tokens generated here get standard agent scopes. Use Auto-Install for per-provider setup.
                </p>
              </div>

              {activeTokens.length > 0 ? (
                <div className="token-list card">
                  <h3>Active Tokens ({activeTokens.length})</h3>
                  {activeTokens.map((token) => (
                    <div key={token.id} className="token-row">
                      <div className="token-info">
                        <span className="token-label">{token.label}</span>
                        <span className="token-scopes text-muted">{token.scopes.join(', ')}</span>
                        <span className="token-meta text-muted">
                          Created {new Date(token.created_at * 1000).toLocaleDateString()}
                          {token.last_used_at && ` · Last used ${new Date(token.last_used_at * 1000).toLocaleDateString()}`}
                        </span>
                      </div>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => revokeToken(token.id)}
                        disabled={revokingId === token.id}
                      >
                        {revokingId === token.id ? 'Revoking…' : 'Revoke'}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="card" style={{ padding: '24px', textAlign: 'center' }}>
                  <p className="text-muted">No active tokens. Use Auto-Install or generate one above.</p>
                </div>
              )}
            </section>
          )}

          {activeTab === 'test' && (
            <section className="mcp-test-tab">
              <div className="card">
                <h3>MCP Server URL</h3>
                <div className="mcp-url-row">
                  <code className="mcp-url">{mcpConfig.url}</code>
                  <button className="btn-icon" onClick={() => copyToClipboard(mcpConfig.url, 'url')}>
                    {copiedField === 'url' ? '✓' : '⧉'}
                  </button>
                </div>
                <div className="mcp-meta">
                  <span>Transport: {mcpConfig.transport}</span>
                  <span>Spec: {mcpConfig.specVersion}</span>
                </div>
              </div>

              <div className="card">
                <h3>Curl Test</h3>
                <p className="text-muted">Run this to verify MCP connectivity:</p>
                <div className="code-block-wrapper">
                  <pre className="code-block">{mcpConfig.connectionInstructions.curl_test?.command ?? ''}</pre>
                  <button
                    className="btn-icon copy-code-btn"
                    onClick={() => copyToClipboard(mcpConfig.connectionInstructions.curl_test?.command ?? '', 'curl')}
                  >
                    {copiedField === 'curl' ? '✓ Copied' : '⧉ Copy'}
                  </button>
                </div>
              </div>

              <div className="card">
                <h3>Connection Status</h3>
                <div className="provider-status-grid">
                  {MCP_PROVIDERS.map((provider) => {
                    const status = setupStatus[provider.key];
                    return (
                      <div key={provider.key} className="provider-status-item">
                        <span>
                          {provider.icon} {provider.label}
                        </span>
                        {status?.hasAiRemoteCoder ? (
                          <span className="badge-green">✓ configured</span>
                        ) : (
                          <span className="badge-grey">not configured</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="card">
                <h3>Deployment Shortcuts</h3>
                <p className="text-muted">
                  Jump straight to the agent setup flow from the rest of the app.
                </p>
                <div className="btn-group">
                  <button className="btn btn-primary" onClick={() => navigate('/dashboard')}>
                    Dashboard
                  </button>
                  <button className="btn" onClick={() => navigate('/settings')}>
                    Settings
                  </button>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

export default McpSettings;

