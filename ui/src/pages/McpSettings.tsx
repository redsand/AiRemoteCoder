import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../components/ui';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpConfig {
  enabled: boolean;
  url: string;
  transport: string;
  specVersion: string;
  enabledProviders: string[];
  legacyWrapperDeprecated: boolean;
  connectionInstructions: Record<string, {
    description: string;
    config?: object;
    env?: object;
    command?: string;
    note?: string;
  }>;
}

interface McpToken {
  id: string;
  label: string;
  scopes: string[];
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface SetupStatus {
  configured: boolean;
  filePath: string | null;
  exists: boolean;
  hasAiRemoteCoder: boolean;
}

interface Props {
  user: { id: string; username: string; role: string } | null;
}

// ---------------------------------------------------------------------------
// Provider metadata
// ---------------------------------------------------------------------------

const PROVIDERS = [
  {
    key: 'claude',
    label: 'Claude Code',
    icon: '🤖',
    description: 'Anthropic\'s Claude Code CLI and IDE extension',
    configFile: '.claude/mcp.json',
    docsKey: 'claude_code',
  },
  {
    key: 'codex',
    label: 'Codex',
    icon: '⚡',
    description: 'OpenAI Codex CLI agent',
    configFile: 'Environment variables',
    docsKey: 'codex',
  },
  {
    key: 'gemini',
    label: 'Gemini CLI',
    icon: '✨',
    description: 'Google Gemini CLI coding agent',
    configFile: '.gemini/settings.json',
    docsKey: 'gemini_cli',
  },
  {
    key: 'opencode',
    label: 'OpenCode',
    icon: '🔧',
    description: 'OpenCode agent (native MCP support)',
    configFile: 'opencode.json',
    docsKey: 'opencode',
  },
  {
    key: 'rev',
    label: 'Rev',
    icon: '🔄',
    description: 'Rev AI coding agent',
    configFile: 'Environment variables',
    docsKey: 'rev',
  },
] as const;

type ProviderKey = typeof PROVIDERS[number]['key'];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function McpSettings({ user }: Props) {
  const { addToast } = useToast();

  const [mcpConfig, setMcpConfig] = useState<McpConfig | null>(null);
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [setupStatus, setSetupStatus] = useState<Record<string, SetupStatus>>({});
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'connect' | 'tokens' | 'test'>('connect');

  // Per-provider state
  const [installingProvider, setInstallingProvider] = useState<ProviderKey | null>(null);
  const [installedProvider, setInstalledProvider] = useState<ProviderKey | null>(null);
  const [providerSetup, setProviderSetup] = useState<Record<string, {
    token?: string; snippet?: object | string; filePath?: string | null; installed?: boolean; error?: string;
  }>>({});

  // Token creation
  const [newTokenLabel, setNewTokenLabel] = useState('');
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const isAdmin = user?.role === 'admin';

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

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
      addToast({ type: 'error', message: 'Failed to load MCP configuration' });
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // -------------------------------------------------------------------------
  // Provider auto-install
  // -------------------------------------------------------------------------

  async function setupProvider(providerKey: ProviderKey) {
    setInstallingProvider(providerKey);
    setInstalledProvider(null);
    try {
      // Step 1: get token + snippet
      const setupRes = await fetch(`/api/mcp/setup/${providerKey}`, { method: 'POST' });
      if (!setupRes.ok) {
        const err = await setupRes.json();
        setProviderSetup((p) => ({ ...p, [providerKey]: { error: err.error } }));
        addToast({ type: 'error', message: `Setup failed: ${err.error}` });
        return;
      }
      const setup = await setupRes.json();

      // Step 2: auto-install if file-based
      if (setup.canAutoInstall) {
        const installRes = await fetch(`/api/mcp/setup/${providerKey}/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const install = await installRes.json();
        if (installRes.ok && install.installed) {
          setProviderSetup((p) => ({
            ...p, [providerKey]: { token: setup.token, snippet: setup.snippet, filePath: install.filePath, installed: true },
          }));
          setInstalledProvider(providerKey);
          addToast({ type: 'success', message: `${providerKey} MCP config installed at ${install.filePath}` });
        } else {
          setProviderSetup((p) => ({ ...p, [providerKey]: { token: setup.token, snippet: setup.snippet, filePath: setup.filePath, installed: false, error: install.error } }));
          addToast({ type: 'warning', message: `Auto-install failed. Use manual config below.` });
        }
      } else {
        // Env-var provider
        setProviderSetup((p) => ({
          ...p, [providerKey]: { token: setup.token, snippet: setup.snippet, filePath: null, installed: false },
        }));
      }

      // Refresh setup status
      const statusRes = await fetch('/api/mcp/setup/status');
      if (statusRes.ok) setSetupStatus((await statusRes.json()).status ?? {});
      await fetchAll();
    } catch (e: any) {
      addToast({ type: 'error', message: `Setup error: ${e.message}` });
    } finally {
      setInstallingProvider(null);
    }
  }

  // -------------------------------------------------------------------------
  // Token management
  // -------------------------------------------------------------------------

  async function createToken() {
    if (!newTokenLabel.trim()) {
      addToast({ type: 'error', message: 'Token label is required' });
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
      addToast({ type: 'success', message: 'Token created — copy it now' });
    } else {
      const err = await res.json();
      addToast({ type: 'error', message: err.error || 'Failed to create token' });
    }
  }

  async function revokeToken(id: string) {
    setRevokingId(id);
    const res = await fetch(`/api/mcp/tokens/${id}`, { method: 'DELETE' });
    if (res.ok) { await fetchAll(); addToast({ type: 'success', message: 'Token revoked' }); }
    else addToast({ type: 'error', message: 'Failed to revoke token' });
    setRevokingId(null);
  }

  async function copyToClipboard(text: string, field: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      addToast({ type: 'error', message: 'Clipboard access denied' });
    }
  }

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  function ProviderStatusBadge({ providerKey }: { providerKey: string }) {
    const status = setupStatus[providerKey];
    if (!status) return null;
    if (status.hasAiRemoteCoder) return <span className="provider-badge success">✓ connected</span>;
    if (status.exists) return <span className="provider-badge warn">file exists, not configured</span>;
    return <span className="provider-badge neutral">not configured</span>;
  }

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  if (loading) {
    return <div className="page-content"><div className="loading"><div className="spinner" /></div></div>;
  }

  const activeTokens = tokens.filter((t) => !t.revoked_at);
  const connectedCount = Object.values(setupStatus).filter((s) => s.hasAiRemoteCoder).length;

  // -------------------------------------------------------------------------
  // Main render
  // -------------------------------------------------------------------------

  return (
    <div className="page-content mcp-page">

      {/* ------------------------------------------------------------------ */}
      {/* Hero header                                                         */}
      {/* ------------------------------------------------------------------ */}
      <div className="mcp-hero">
        <div className="mcp-hero-text">
          <h1>🔌 MCP Control Plane</h1>
          <p>
            Connect your AI coding agents to AiRemoteCoder in seconds.
            One config file — full remote control from your phone.
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
          <div className={`hero-stat-status ${mcpConfig?.enabled ? 'online' : 'offline'}`}>
            <span className="status-dot" />
            <span>{mcpConfig?.enabled ? 'MCP Active' : 'MCP Disabled'}</span>
          </div>
        </div>
      </div>

      {/* MCP disabled notice */}
      {!mcpConfig?.enabled && (
        <div className="alert alert-warning">
          MCP is disabled. Set <code>AIRC_MCP_ENABLED=true</code> and restart the gateway.
        </div>
      )}

      {/* Deprecation notice */}
      {mcpConfig?.legacyWrapperDeprecated && (
        <div className="alert alert-warning">
          ⚠️ <strong>Legacy wrapper mode is deprecated</strong> — migrate to a native provider above. It will be removed in the next major release.
        </div>
      )}

      {mcpConfig?.enabled && (
        <>
          {/* -------------------------------------------------------------- */}
          {/* Tabs                                                            */}
          {/* -------------------------------------------------------------- */}
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

          {/* -------------------------------------------------------------- */}
          {/* TAB: Connect Agent                                              */}
          {/* -------------------------------------------------------------- */}
          {activeTab === 'connect' && (
            <section className="mcp-connect-tab">
              <p className="text-muted section-intro">
                Click <strong>Auto-Install</strong> to configure the agent automatically,
                or copy the snippet manually. The token is generated and saved for you.
              </p>

              <div className="provider-list">
                {PROVIDERS.map((provider) => {
                  const isConfigured = setupStatus[provider.key]?.hasAiRemoteCoder;
                  const isInstalling = installingProvider === provider.key;
                  const setup = providerSetup[provider.key];
                  const enabled = mcpConfig.enabledProviders.includes(provider.key);

                  return (
                    <div key={provider.key} className={`provider-row ${isConfigured ? 'configured' : ''}`}>
                      <div className="provider-row-header">
                        <div className="provider-identity">
                          <span className="provider-icon-lg">{provider.icon}</span>
                          <div>
                            <div className="provider-name">{provider.label}</div>
                            <div className="provider-desc text-muted">{provider.description}</div>
                            <div className="provider-file text-muted"><code>{provider.configFile}</code></div>
                          </div>
                        </div>
                        <div className="provider-actions">
                          <ProviderStatusBadge providerKey={provider.key} />
                          {!enabled && <span className="provider-badge disabled">disabled in config</span>}
                          {enabled && (
                            <button
                              className={`btn btn-primary ${isInstalling ? 'loading' : ''} ${isConfigured ? 'btn-secondary' : ''}`}
                              onClick={() => setupProvider(provider.key as ProviderKey)}
                              disabled={isInstalling}
                            >
                              {isInstalling ? 'Installing…' : isConfigured ? '↺ Reinstall' : '⚡ Auto-Install'}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Show snippet after setup */}
                      {setup && (
                        <div className="provider-setup-result">
                          {setup.installed && (
                            <div className="alert alert-success install-success">
                              ✓ Config written to <code>{setup.filePath}</code>
                              {' — '}restart your agent to connect.
                            </div>
                          )}
                          {setup.error && (
                            <div className="alert alert-warning">{setup.error}</div>
                          )}
                          {setup.snippet && (
                            <div className="snippet-block">
                              <div className="snippet-header">
                                <span className="text-muted">
                                  {setup.installed ? 'Written config:' : 'Manual config (copy this):'}
                                </span>
                                <button
                                  className="btn-icon"
                                  onClick={() => copyToClipboard(
                                    typeof setup.snippet === 'string'
                                      ? setup.snippet
                                      : JSON.stringify(setup.snippet, null, 2),
                                    `snippet-${provider.key}`
                                  )}
                                >
                                  {copiedField === `snippet-${provider.key}` ? '✓ Copied' : '⧉ Copy'}
                                </button>
                              </div>
                              <pre className="code-block">
                                {typeof setup.snippet === 'string'
                                  ? setup.snippet
                                  : JSON.stringify(setup.snippet, null, 2)}
                              </pre>
                              {setup.token && (
                                <div className="token-reveal">
                                  <span className="text-muted">Token (shown once):</span>
                                  <code className="token-value">{setup.token}</code>
                                  <button
                                    className="btn-icon"
                                    onClick={() => copyToClipboard(setup.token!, `token-${provider.key}`)}
                                  >
                                    {copiedField === `token-${provider.key}` ? '✓' : '⧉'}
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* -------------------------------------------------------------- */}
          {/* TAB: Tokens                                                     */}
          {/* -------------------------------------------------------------- */}
          {activeTab === 'tokens' && (
            <section className="mcp-tokens-tab">
              {createdToken && (
                <div className="alert alert-success">
                  <strong>✓ Token created</strong> — copy it now, it won't be shown again.
                  <div className="created-token-row">
                    <code className="token-value">{createdToken}</code>
                    <button className="btn btn-sm" onClick={() => copyToClipboard(createdToken, 'new-token')}>
                      {copiedField === 'new-token' ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>
                  <button className="btn btn-sm btn-secondary" onClick={() => setCreatedToken(null)}>Dismiss</button>
                </div>
              )}

              <div className="create-token-form card">
                <h3>Generate Token</h3>
                <div className="form-row">
                  <input
                    type="text"
                    className="input"
                    placeholder="Label (e.g. &quot;My Claude session&quot;)"
                    value={newTokenLabel}
                    onChange={(e) => setNewTokenLabel(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && createToken()}
                  />
                  <button className="btn btn-primary" onClick={createToken} disabled={!newTokenLabel.trim()}>
                    Generate
                  </button>
                </div>
                <p className="text-muted" style={{ marginTop: '8px', fontSize: '12px' }}>
                  Tokens generated here get all standard agent scopes. Use Auto-Install for per-provider tokens.
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

          {/* -------------------------------------------------------------- */}
          {/* TAB: Test & Verify                                              */}
          {/* -------------------------------------------------------------- */}
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
                  {PROVIDERS.map((p) => {
                    const st = setupStatus[p.key];
                    return (
                      <div key={p.key} className="provider-status-item">
                        <span>{p.icon} {p.label}</span>
                        {st?.hasAiRemoteCoder
                          ? <span className="badge-green">✓ configured</span>
                          : <span className="badge-grey">not configured</span>
                        }
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
