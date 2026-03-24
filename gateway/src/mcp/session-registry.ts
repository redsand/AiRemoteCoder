import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpAuthContext } from './auth.js';

export interface McpSessionEntry {
  id: string;
  transport: StreamableHTTPServerTransport;
  authContext: McpAuthContext;
  createdAt: number;
  lastSeenAt: number;
}

const sessions = new Map<string, McpSessionEntry>();

export function registerMcpSession(entry: McpSessionEntry): void {
  sessions.set(entry.id, entry);
}

export function getMcpSession(sessionId: string): McpSessionEntry | undefined {
  return sessions.get(sessionId);
}

export function touchMcpSession(sessionId: string): void {
  const existing = sessions.get(sessionId);
  if (!existing) return;
  existing.lastSeenAt = Math.floor(Date.now() / 1000);
  sessions.set(sessionId, existing);
}

export function removeMcpSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function listMcpSessions(): McpSessionEntry[] {
  return Array.from(sessions.values());
}

export function findLatestMcpSessionByTokenId(tokenId: string): McpSessionEntry | undefined {
  const matches = Array.from(sessions.values())
    .filter((entry) => entry.authContext.tokenId === tokenId)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return matches[0];
}

export function clearMcpSessionsForTests(): void {
  sessions.clear();
}
