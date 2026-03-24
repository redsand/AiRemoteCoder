export interface McpProviderDefinition {
  key: 'claude' | 'codex' | 'gemini' | 'opencode' | 'zenflow' | 'rev';
  label: string;
  icon: string;
  description: string;
  configFile: string;
  docsKey: string;
}

export const MCP_PROVIDERS: McpProviderDefinition[] = [
  {
    key: 'claude',
    label: 'Claude Code',
    icon: '🤖',
    description: "Anthropic's Claude Code CLI and IDE extension",
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
    key: 'zenflow',
    label: 'Zenflow',
    icon: '🧭',
    description: 'Zenflow coding environment',
    configFile: '.zenflow/mcp.json',
    docsKey: 'claude_code',
  },
  {
    key: 'rev',
    label: 'Rev',
    icon: '🔄',
    description: 'Rev AI coding agent',
    configFile: 'Environment variables',
    docsKey: 'rev',
  },
];

export type McpProviderKey = typeof MCP_PROVIDERS[number]['key'];

export function getMcpProvider(providerKey: McpProviderKey) {
  return MCP_PROVIDERS.find((provider) => provider.key === providerKey);
}

