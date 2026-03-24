import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useToast } from '../components/ui';
import McpProviderGrid from '../components/mcp/McpProviderGrid';
import { MCP_PROVIDERS, type McpProviderKey } from '../features/mcp/providers';
import type { McpActiveSession, McpConfig, McpProjectTarget, McpProviderSetupState, McpToken } from '../features/mcp/types';

interface Props {
  user: { id: string; username: string; role: string } | null;
}

export function McpSettings(_props: Props) {
  const { addToast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [mcpConfig, setMcpConfig] = useState<McpConfig | null>(null);
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [projectTargets, setProjectTargets] = useState<McpProjectTarget[]>([]);
  const [selectedProjectTargetId, setSelectedProjectTargetId] = useState<string>('');
  const [customProjectPath, setCustomProjectPath] = useState('');
  const [newTargetLabel, setNewTargetLabel] = useState('');
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [activeSessionCount, setActiveSessionCount] = useState(0);
  const [activeSessions, setActiveSessions] = useState<McpActiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'connect' | 'tokens' | 'test'>('connect');
  const [installingProvider, setInstallingProvider] = useState<McpProviderKey | null>(null);
  const [providerSetup, setProviderSetup] = useState<Record<string, McpProviderSetupState>>({});
  const [persistEnvVars, setPersistEnvVars] = useState(true);
  const [newTokenLabel, setNewTokenLabel] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  function normalizeTokenScopes(scopes: unknown): string[] {
    if (Array.isArray(scopes)) {
      return scopes.filter((scope): scope is string => typeof scope === 'string');
    }
    if (typeof scopes === 'string') {
      try {
        const parsed = JSON.parse(scopes);
        if (Array.isArray(parsed)) {
          return parsed.filter((scope): scope is string => typeof scope === 'string');
        }
      } catch {
        // ignore malformed payload
      }
    }
    return [];
  }

  const buildTargetPayload = useCallback(() => {
    const payload: { projectTargetId?: string; projectPath?: string } = {};
    if (selectedProjectTargetId) {
      payload.projectTargetId = selectedProjectTargetId;
      return payload;
    }
    if (customProjectPath.trim()) {
      payload.projectPath = customProjectPath.trim();
    }
    return payload;
  }, [customProjectPath, selectedProjectTargetId]);

  const fetchAll = useCallback(async () => {
    try {
      const [configRes, tokensRes] = await Promise.all([
        fetch('/api/mcp/config'),
        fetch('/api/mcp/tokens'),
      ]);
      const targetsRes = await fetch('/api/mcp/project-targets');
      const meRes = await fetch('/api/auth/me');
      const sessionsRes = await fetch('/api/mcp/sessions');
      if (configRes.ok) {
        const config = (await configRes.json()) as McpConfig;
        setMcpConfig(config);
        setSelectedScopes((prev) => (prev.length > 0 ? prev : (config.defaultAgentScopes ?? [])));
      }
      if (tokensRes.ok) {
        const payload = await tokensRes.json();
        const normalized = (payload.tokens ?? []).map((token: any) => ({
          ...token,
          scopes: normalizeTokenScopes(token.scopes),
        })) as McpToken[];
        setTokens(normalized);
      }
      if (targetsRes.ok) setProjectTargets((await targetsRes.json()).targets ?? []);
      if (meRes.ok) {
        const me = await meRes.json();
        setCurrentDeviceId(me.deviceId ?? null);
      }
      if (sessionsRes.ok) {
        const sessions = await sessionsRes.json();
        const list = Array.isArray(sessions.sessions) ? sessions.sessions : [];
        setActiveSessionCount(list.length);
        setActiveSessions(list);
      }
    } catch {
      addToast('error', 'Failed to load MCP configuration');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'connect' || tab === 'tokens' || tab === 'test') {
      setActiveTab(tab);
    }
  }, [searchParams]);

  async function setupProvider(providerKey: McpProviderKey, options: { generateNewToken?: boolean } = {}) {
    setInstallingProvider(providerKey);
    try {
      const targetPayload = buildTargetPayload();
      const setupRes = await fetch(`/api/mcp/setup/${providerKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...targetPayload,
          persistEnv: persistEnvVars,
          generateNewToken: Boolean(options.generateNewToken),
        }),
      });
      if (!setupRes.ok) {
        const err = await setupRes.json();
        setProviderSetup((prev) => ({ ...prev, [providerKey]: { error: err.error } }));
        addToast('error', `Setup failed: ${err.error}`);
        return;
      }

      const setup = await setupRes.json();
      setProviderSetup((prev) => ({
        ...prev,
        [providerKey]: {
          token: setup.token,
          tokenReused: Boolean(setup.tokenReused),
          snippet: setup.snippet,
          copyPaste: setup.copyPaste,
          filePath: null,
          installed: false,
        },
      }));
      addToast('success', setup.tokenReused
        ? `${providerKey} commands refreshed using your latest unused token.`
        : `${providerKey} setup snippet generated.`);

      await fetchAll();
    } catch (e: any) {
      addToast('error', `Setup error: ${e.message}`);
    } finally {
      setInstallingProvider(null);
    }
  }

  async function saveProjectTarget() {
    const path = customProjectPath.trim();
    if (!path) {
      addToast('error', 'Project path is required');
      return;
    }
    const label = newTargetLabel.trim() || path.split(/[\\/]/).filter(Boolean).pop() || 'Project';
    const res = await fetch('/api/mcp/project-targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, path }),
    });
    if (!res.ok) {
      const err = await res.json();
      addToast('error', err.error || 'Failed to save project target');
      return;
    }
    const created = await res.json();
    await fetchAll();
    setSelectedProjectTargetId(created.id);
    addToast('success', 'Project target saved');
  }

  async function createToken() {
    if (!newTokenLabel.trim()) {
      addToast('error', 'Token label is required');
      return;
    }

    const res = await fetch('/api/mcp/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: newTokenLabel.trim(), scopes: selectedScopes }),
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

  function toggleScope(scope: string) {
    setSelectedScopes((prev) => (
      prev.includes(scope)
        ? prev.filter((entry) => entry !== scope)
        : [...prev, scope]
    ));
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
  const connectedProviderCount = new Set(
    activeSessions
      .map((session) => session.provider)
      .filter((provider): provider is string => Boolean(provider))
  ).size;
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
            <span className="hero-stat-value">{activeSessionCount}</span>
            <span className="hero-stat-label">active mcp sessions</span>
          </div>
          <div className="hero-stat">
            <span className="hero-stat-value">{connectedProviderCount}</span>
            <span className="hero-stat-label">connected providers</span>
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
            <span>{mcpConfig?.enabled ? 'MCP Enabled' : 'MCP Disabled'}</span>
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
              <div className="card" style={{ marginBottom: '12px' }}>
                <h3>Target Project</h3>
                <div className="form-row" style={{ marginBottom: '8px' }}>
                  <select
                    className="form-input"
                    value={selectedProjectTargetId}
                    onChange={(e) => setSelectedProjectTargetId(e.target.value)}
                  >
                    <option value="">Default ({mcpConfig?.url ? 'current gateway project' : 'current'})</option>
                    {projectTargets.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.label} — {target.path}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <input
                    type="text"
                    className="form-input"
                    placeholder="Or enter absolute project path (e.g. /repos/my-app)"
                    value={customProjectPath}
                    onChange={(e) => {
                      setCustomProjectPath(e.target.value);
                      if (selectedProjectTargetId) setSelectedProjectTargetId('');
                    }}
                  />
                  <input
                    type="text"
                    className="form-input"
                    placeholder="Label (optional)"
                    value={newTargetLabel}
                    onChange={(e) => setNewTargetLabel(e.target.value)}
                  />
                  <button className="btn btn-secondary" onClick={saveProjectTarget}>
                    Save Target
                  </button>
                </div>
                <p className="text-muted" style={{ marginTop: '8px', fontSize: '12px' }}>
                  Generate provider setup commands, copy/paste one-shot into your project shell, then launch Claude/Codex/Gemini/OpenCode/Zenflow in that project.
                </p>
                <label className="provider-status-item" style={{ marginTop: '10px', justifyContent: 'space-between' }}>
                  <span>Persist env vars for future shells</span>
                  <input
                    type="checkbox"
                    checked={persistEnvVars}
                    onChange={(e) => setPersistEnvVars(e.target.checked)}
                  />
                </label>
                <p className="text-muted" style={{ marginTop: '6px', fontSize: '12px' }}>
                  When enabled, setup commands also persist token variables to your user shell profile/environment.
                </p>
                {currentDeviceId ? (
                  <p className="text-muted" style={{ marginTop: '6px', fontSize: '12px' }}>
                    Trusted device identity: <code>{currentDeviceId}</code>
                  </p>
                ) : null}
              </div>

              <p className="text-muted section-intro">
                Command-first setup is the default: generate one-shot commands, run them in the target project environment, then start your coding agent in that context.
              </p>

              <div className="card" style={{ marginBottom: '12px' }}>
                <h3>Active MCP Sessions</h3>
                {activeSessions.length === 0 ? (
                  <p className="text-muted" style={{ fontSize: '12px' }}>No active MCP sessions currently connected.</p>
                ) : (
                  <div className="provider-status-grid">
                    {activeSessions.map((session) => (
                      <div key={session.id} className="provider-status-item">
                        <span>
                          {session.user.username} ({session.user.role})
                        </span>
                        <span className="text-muted" style={{ fontSize: '11px' }}>
                          last seen {new Date(session.lastSeenAt * 1000).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <McpProviderGrid
                mcpConfig={mcpConfig}
                providerSetup={providerSetup}
                installingProvider={installingProvider}
                copiedField={copiedField}
                onInstall={(providerKey, options) => setupProvider(providerKey, options)}
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
                    className="form-input"
                    placeholder='Label (e.g. "My Claude session")'
                    value={newTokenLabel}
                    onChange={(e) => setNewTokenLabel(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && createToken()}
                  />
                  <button className="btn btn-primary" onClick={createToken} disabled={!newTokenLabel.trim()}>
                    Generate
                  </button>
                </div>
                {mcpConfig?.availableScopes?.length ? (
                  <div style={{ marginTop: '12px' }}>
                    <div className="text-muted" style={{ fontSize: '12px', marginBottom: '6px' }}>
                      Scopes for this token
                    </div>
                    <div className="provider-status-grid">
                      {mcpConfig.availableScopes.map((scope) => (
                        <label key={scope} className="provider-status-item" style={{ justifyContent: 'space-between' }}>
                          <span>{scope}</span>
                          <input
                            type="checkbox"
                            checked={selectedScopes.includes(scope)}
                            onChange={() => toggleScope(scope)}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
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
                <h3>Connected Provider Sessions</h3>
                <div className="provider-status-grid">
                  {activeSessions.length === 0 ? (
                    <div className="provider-status-item">
                      <span>No active provider sessions</span>
                    </div>
                  ) : activeSessions.map((session) => (
                    <div key={session.id} className="provider-status-item">
                      <span>{(session.provider ?? 'unknown').toUpperCase()} · {session.user.username}</span>
                      <span className="text-muted" style={{ fontSize: '11px' }}>
                        session {session.id.slice(0, 8)}
                      </span>
                    </div>
                  ))}
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
