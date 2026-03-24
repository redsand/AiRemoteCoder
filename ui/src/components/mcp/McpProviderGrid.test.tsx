import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { McpProviderGrid } from './McpProviderGrid';
import type { McpConfig, McpProviderSetupState, McpSetupStatus } from '../../features/mcp/types';

const baseConfig: McpConfig = {
  enabled: true,
  url: 'https://gateway.example.test/mcp',
  transport: 'streamable-http',
  specVersion: '2024-11-05',
  availableScopes: ['runs:read', 'runs:write', 'vnc:read', 'vnc:control'],
  defaultAgentScopes: ['runs:read', 'runs:write', 'vnc:read', 'vnc:control'],
  enabledProviders: ['claude', 'codex', 'gemini', 'opencode', 'zenflow', 'rev'],
  legacyWrapperDeprecated: true,
  connectionInstructions: {
    curl_test: { description: 'Connectivity check', command: 'curl https://gateway.example.test/mcp' },
  },
};

describe('McpProviderGrid', () => {
  it('renders every supported provider with auto-install actions', () => {
    const setupStatus: Record<string, McpSetupStatus> = {};
    const providerSetup: Record<string, McpProviderSetupState> = {};

    const html = renderToStaticMarkup(
      <McpProviderGrid
        mcpConfig={baseConfig}
        setupStatus={setupStatus}
        providerSetup={providerSetup}
        installingProvider={null}
        copiedField={null}
        onInstall={() => {}}
        onCopy={() => {}}
      />
    );

    expect(html).toContain('Claude Code');
    expect(html).toContain('Codex');
    expect(html).toContain('Gemini CLI');
    expect(html).toContain('OpenCode');
    expect(html).toContain('Zenflow');
    expect(html).toContain('Rev');
    expect((html.match(/Generate Snippet/g) || []).length).toBe(6);
  });

  it('shows reinstall and copied state when a provider is configured', () => {
    const setupStatus: Record<string, McpSetupStatus> = {
      claude: { configured: true, filePath: '.claude/mcp.json', exists: true, hasAiRemoteCoder: true },
    };
    const providerSetup: Record<string, McpProviderSetupState> = {
      claude: {
        token: 'token-123',
        snippet: '{"server":"mcp"}',
        copyPaste: {
          bash: ['cat > .claude/mcp.json <<\'EOF\'\n{}\nEOF'],
          powershell: ["@'\n{}\n'@ | Set-Content .claude/mcp.json"],
        },
        filePath: '.claude/mcp.json',
        installed: true,
      },
    };

    const html = renderToStaticMarkup(
      <McpProviderGrid
        mcpConfig={baseConfig}
        setupStatus={setupStatus}
        providerSetup={providerSetup}
        installingProvider={null}
        copiedField="snippet-claude"
        onInstall={() => {}}
        onCopy={() => {}}
      />
    );

    expect(html).toContain('Regenerate Snippet');
    expect(html).toContain('✓ Copied');
    expect(html).toContain('Token (shown once)');
    expect(html).toContain('Bash copy/paste');
    expect(html).toContain('PowerShell copy/paste');
  });
});
