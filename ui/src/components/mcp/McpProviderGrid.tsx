import { MCP_PROVIDERS, type McpProviderKey } from '../../features/mcp/providers';
import type { McpConfig, McpProviderSetupState } from '../../features/mcp/types';

interface Props {
  mcpConfig: McpConfig | null;
  providerSetup: Record<string, McpProviderSetupState>;
  installingProvider: McpProviderKey | null;
  copiedField: string | null;
  onInstall: (providerKey: McpProviderKey, options?: { generateNewToken?: boolean }) => void;
  onCopy: (text: string, field: string) => void;
}

export function McpProviderGrid({
  mcpConfig,
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
        const isInstalling = installingProvider === provider.key;
        const setup = providerSetup[provider.key];
        const hasGenerated = Boolean(setup);
        const enabled = enabledProviders.includes(provider.key);

        return (
          <div key={provider.key} className="provider-row">
            <div className="provider-row-header">
              <div className="provider-identity">
                <span className="provider-icon-lg">{provider.icon}</span>
                <div>
                  <div className="provider-name">{provider.label}</div>
                  <div className="provider-desc text-muted">{provider.description}</div>
                  <div className="provider-file text-muted"><code>{provider.configFile}</code></div>
                  <div className="provider-file text-muted">{provider.runnerSupportNote}</div>
                </div>
              </div>
              <div className="provider-actions">
                {!enabled && <span className="provider-badge disabled">disabled in config</span>}
                {enabled && provider.runnerSupport === 'production' && (
                  <span className="provider-badge enabled">runner ready</span>
                )}
                {enabled && provider.runnerSupport === 'preview' && (
                  <span className="provider-badge disabled">runner preview</span>
                )}
                {enabled && (
                  <>
                    <button
                      className={`btn btn-primary ${isInstalling ? 'loading' : ''} ${hasGenerated ? 'btn-secondary' : ''}`}
                      onClick={() => onInstall(provider.key, { generateNewToken: false })}
                      disabled={isInstalling}
                    >
                      {isInstalling ? 'Generating…' : hasGenerated ? '↺ Refresh Commands' : '⚡ Generate Snippet'}
                    </button>
                    {hasGenerated && (
                      <button
                        className="btn btn-danger"
                        onClick={() => onInstall(provider.key, { generateNewToken: true })}
                        disabled={isInstalling}
                      >
                        Generate New Token
                      </button>
                    )}
                  </>
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
                {setup.tokenReused && (
                  <div className="alert alert-success install-success">
                    Reusing latest unused token for this provider. Use "Generate New Token" to rotate.
                  </div>
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
