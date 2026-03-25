import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { McpProviderGrid } from './McpProviderGrid';
import type { McpConfig, McpProviderSetupState } from '../../features/mcp/types';

const baseConfig: McpConfig = {
  enabled: true,
  url: 'https://gateway.example.test/mcp',
  transport: 'streamable-http',
  specVersion: '2024-11-05',
  availableScopes: ['runs:read', 'runs:write', 'vnc:read', 'vnc:control'],
  defaultAgentScopes: ['runs:read', 'runs:write', 'vnc:read', 'vnc:control'],
  enabledProviders: ['claude', 'codex', 'gemini', 'opencode', 'zenflow', 'rev'],
  connectionInstructions: {
    curl_test: { description: 'Connectivity check', command: 'curl https://gateway.example.test/mcp' },
  },
};

describe('McpProviderGrid', () => {
  it('renders every supported provider with auto-install actions', () => {
    const providerSetup: Record<string, McpProviderSetupState> = {};

    const html = renderToStaticMarkup(
      <McpProviderGrid
        mcpConfig={baseConfig}
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
    expect(html).toContain('runner ready');
    expect((html.match(/runner preview/g) || []).length).toBe(5);
    expect((html.match(/Generate Snippet/g) || []).length).toBe(6);
  });

  it('shows reinstall and copied state when a provider is configured', () => {
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
        providerSetup={providerSetup}
        installingProvider={null}
        copiedField="snippet-claude"
        onInstall={() => {}}
        onCopy={() => {}}
      />
    );

    expect(html).toContain('Refresh Commands');
    expect(html).toContain('Generate New Token');
    expect(html).toContain('✓ Copied');
    expect(html).toContain('Token (shown once)');
    expect(html).toContain('Recommended: Bash one-shot setup');
    expect(html).toContain('Recommended: PowerShell one-shot setup');
    expect(html).toContain('Written config (advanced/manual):');
  });
});
