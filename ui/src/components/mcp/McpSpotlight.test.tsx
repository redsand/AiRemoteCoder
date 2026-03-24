import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { McpSpotlight } from './McpSpotlight';
import type { McpConfig } from '../../features/mcp/types';

const config: McpConfig = {
  enabled: true,
  url: 'https://gateway.example.test/mcp',
  transport: 'streamable-http',
  specVersion: '2024-11-05',
  availableScopes: ['runs:read', 'vnc:read'],
  defaultAgentScopes: ['runs:read', 'vnc:read'],
  enabledProviders: ['claude', 'codex'],
  legacyWrapperDeprecated: false,
  connectionInstructions: {},
};

describe('McpSpotlight', () => {
  it('promotes MCP as the primary control plane', () => {
    const html = renderToStaticMarkup(
      <McpSpotlight
        mcpConfig={config}
        activeSessionCount={2}
        configuredCount={4}
        activeTokens={5}
        copiedUrl={false}
        onCopyUrl={() => {}}
        onOpenMcp={() => {}}
        onOpenTokens={() => {}}
      />
    );

    expect(html).toContain('Primary control plane');
    expect(html).toContain('MCP-first operations');
    expect(html).toContain('active mcp sessions');
    expect(html).toContain('configured environments');
    expect(html).toContain('active tokens');
    expect(html).toContain('Copy MCP URL');
    expect(html).toContain('https://gateway.example.test/mcp');
  });

  it('shows copied state when url has been copied', () => {
    const html = renderToStaticMarkup(
      <McpSpotlight
        mcpConfig={config}
        activeSessionCount={1}
        configuredCount={2}
        activeTokens={1}
        copiedUrl
        onCopyUrl={() => {}}
        onOpenMcp={() => {}}
        onOpenTokens={() => {}}
      />
    );

    expect(html).toContain('✓ MCP URL copied');
  });
});
