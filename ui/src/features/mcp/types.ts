export interface McpConnectionInstruction {
  description: string;
  config?: object;
  env?: object;
  command?: string;
  commands?: string[];
  note?: string;
}

export interface McpConfig {
  enabled: boolean;
  url: string;
  transport: string;
  specVersion: string;
  availableScopes: string[];
  defaultAgentScopes: string[];
  enabledProviders: string[];
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
  tokenReused?: boolean;
  snippet?: object | string;
  copyPaste?: {
    bash?: string[];
    powershell?: string[];
  };
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

export interface McpProjectTarget {
  id: string;
  user_id: string;
  label: string;
  path: string;
  machine_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at?: number;
  updated_at?: number;
}

export interface McpActiveSession {
  id: string;
  user: {
    id: string;
    username: string;
    role: string;
  };
  provider?: string | null;
  tokenLabel?: string;
  createdAt: number;
  lastSeenAt: number;
  scopes: string[];
}
