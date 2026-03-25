export interface McpProviderDefinition {
  key: 'claude' | 'codex' | 'gemini' | 'opencode' | 'zenflow' | 'rev';
  label: string;
  icon: string;
  description: string;
  configFile: string;
  docsKey: string;
  runnerSupport: 'production' | 'preview';
  runnerSupportNote: string;
}

export const MCP_PROVIDERS: McpProviderDefinition[] = [
  {
    key: 'claude',
    label: 'Claude Code',
    icon: '🤖',
    description: "Anthropic's Claude Code CLI and IDE extension",
    configFile: '.claude/mcp.json',
    docsKey: 'claude_code',
    runnerSupport: 'preview',
    runnerSupportNote: 'Runner pairing is not production-ready yet. Use MCP setup now; native Claude runner transport is planned next.',
  },
  {
    key: 'codex',
    label: 'Codex',
    icon: '⚡',
    description: 'OpenAI Codex CLI agent',
    configFile: 'Environment variables',
    docsKey: 'codex',
    runnerSupport: 'production',
    runnerSupportNote: 'Production-ready runner path. Uses airc-mcp-runner with codex app-server by default.',
  },
  {
    key: 'gemini',
    label: 'Gemini CLI',
    icon: '✨',
    description: 'Google Gemini CLI coding agent',
    configFile: '.gemini/settings.json',
    docsKey: 'gemini_cli',
    runnerSupport: 'preview',
    runnerSupportNote: 'Runner pairing is not production-ready yet. Current support is manual exec-template fallback only.',
  },
  {
    key: 'opencode',
    label: 'OpenCode',
    icon: '🔧',
    description: 'OpenCode agent (native MCP support)',
    configFile: 'opencode.json',
    docsKey: 'opencode',
    runnerSupport: 'preview',
    runnerSupportNote: 'Runner pairing is not production-ready yet. Current support is manual exec-template fallback only.',
  },
  {
    key: 'zenflow',
    label: 'Zenflow',
    icon: '🧭',
    description: 'Zenflow coding environment',
    configFile: '.zenflow/mcp.json',
    docsKey: 'claude_code',
    runnerSupport: 'preview',
    runnerSupportNote: 'Runner pairing is not production-ready yet. Current support is manual exec-template fallback only.',
  },
  {
    key: 'rev',
    label: 'Rev',
    icon: '🔄',
    description: 'Rev AI coding agent',
    configFile: 'Environment variables',
    docsKey: 'rev',
    runnerSupport: 'preview',
    runnerSupportNote: 'Runner pairing is not production-ready yet. Current support is manual exec-template fallback only.',
  },
];

export type McpProviderKey = typeof MCP_PROVIDERS[number]['key'];

export function getMcpProvider(providerKey: McpProviderKey) {
  return MCP_PROVIDERS.find((provider) => provider.key === providerKey);
}

export function isProductionReadyRunnerProvider(providerKey: string | null | undefined): boolean {
  return getMcpProvider((providerKey ?? '') as McpProviderKey)?.runnerSupport === 'production';
}
