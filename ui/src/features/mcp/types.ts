export interface McpConnectionInstruction {
  description: string;
  config?: object;
  env?: object;
  command?: string;
  note?: string;
}

export interface McpConfig {
  enabled: boolean;
  url: string;
  transport: string;
  specVersion: string;
  enabledProviders: string[];
  legacyWrapperDeprecated: boolean;
  connectionInstructions: Record<string, McpConnectionInstruction>;
}

export interface McpToken {
  id: string;
  label: string;
  scopes: string[];
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface McpSetupStatus {
  configured: boolean;
  filePath: string | null;
  exists: boolean;
  hasAiRemoteCoder: boolean;
}

export interface McpProviderSetupState {
  token?: string;
  snippet?: object | string;
  filePath?: string | null;
  installed?: boolean;
  error?: string;
}

export interface McpProviderCardState {
  providerKey: string;
  enabled: boolean;
  status?: McpSetupStatus;
  setup?: McpProviderSetupState;
  installing: boolean;
  copiedField: string | null;
}

