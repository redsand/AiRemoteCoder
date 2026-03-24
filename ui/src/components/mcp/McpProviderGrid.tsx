import { MCP_PROVIDERS, type McpProviderKey } from '../../features/mcp/providers';
import type { McpConfig, McpProviderSetupState, McpSetupStatus } from '../../features/mcp/types';

interface Props {
  mcpConfig: McpConfig | null;
  setupStatus: Record<string, McpSetupStatus>;
  providerSetup: Record<string, McpProviderSetupState>;
  installingProvider: McpProviderKey | null;
  copiedField: string | null;
  onInstall: (providerKey: McpProviderKey) => void;
  onCopy: (text: string, field: string) => void;
}

function ProviderStatusBadge({ status }: { status?: McpSetupStatus }) {
  if (!status) return <span className="provider-badge neutral">not configured</span>;
  if (status.hasAiRemoteCoder) return <span className="provider-badge success">✓ configured</span>;
  if (status.exists) return <span className="provider-badge warn">file exists, not configured</span>;
  return <span className="provider-badge neutral">not configured</span>;
}

export function McpProviderGrid({
  mcpConfig,
  setupStatus,
  providerSetup,
  installingProvider,
  copiedField,
  onInstall,
  onCopy,
}: Props) {
  const enabledProviders = mcpConfig?.enabledProviders ?? [];

  return (
    <div className="provider-list">
      {MCP_PROVIDERS.map((provider) => {
        const isConfigured = setupStatus[provider.key]?.hasAiRemoteCoder;
        const isInstalling = installingProvider === provider.key;
        const setup = providerSetup[provider.key];
        const enabled = enabledProviders.includes(provider.key);

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
                <ProviderStatusBadge status={setupStatus[provider.key]} />
                {!enabled && <span className="provider-badge disabled">disabled in config</span>}
                {enabled && (
                  <button
                    className={`btn btn-primary ${isInstalling ? 'loading' : ''} ${isConfigured ? 'btn-secondary' : ''}`}
                    onClick={() => onInstall(provider.key)}
                    disabled={isInstalling}
                  >
                    {isInstalling ? 'Generating…' : isConfigured ? '↺ Regenerate Snippet' : '⚡ Generate Snippet'}
                  </button>
                )}
              </div>
            </div>

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
                {setup.copyPaste?.bash?.length ? (
                  <div className="snippet-block">
                    <div className="snippet-header">
                      <span className="text-muted">Recommended: Bash one-shot setup</span>
                      <button
                        className="btn-icon"
                        onClick={() => onCopy(setup.copyPaste!.bash!.join('\n\n'), `bash-${provider.key}`)}
                      >
                        {copiedField === `bash-${provider.key}` ? '✓ Copied' : '⧉ Copy'}
                      </button>
                    </div>
                    <pre className="code-block">{setup.copyPaste.bash.join('\n\n')}</pre>
                  </div>
                ) : null}
                {setup.copyPaste?.powershell?.length ? (
                  <div className="snippet-block">
                    <div className="snippet-header">
                      <span className="text-muted">Recommended: PowerShell one-shot setup</span>
                      <button
                        className="btn-icon"
                        onClick={() => onCopy(setup.copyPaste!.powershell!.join('\n\n'), `powershell-${provider.key}`)}
                      >
                        {copiedField === `powershell-${provider.key}` ? '✓ Copied' : '⧉ Copy'}
                      </button>
                    </div>
                    <pre className="code-block">{setup.copyPaste.powershell.join('\n\n')}</pre>
                  </div>
                ) : null}
                {setup.snippet && (
                  <div className="snippet-block">
                    <div className="snippet-header">
                      <span className="text-muted">
                        {setup.installed ? 'Written config (advanced/manual):' : 'Advanced/manual config snippet:'}
                      </span>
                      <button
                        className="btn-icon"
                        onClick={() => onCopy(
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
                          onClick={() => onCopy(setup.token!, `token-${provider.key}`)}
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
  );
}

export default McpProviderGrid;
