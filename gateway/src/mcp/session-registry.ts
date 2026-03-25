import { basename } from 'path';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpAuthContext } from './auth.js';

export interface McpSessionEntry {
  id: string;
  transport: StreamableHTTPServerTransport;
  authContext: McpAuthContext;
  createdAt: number;
  lastSeenAt: number;
  projectDir?: string | null;
  projectName?: string | null;
}

export interface McpRunnerHostEntry {
  id: string;
  tokenId: string;
  runnerId: string;
  provider: string | null;
  user: McpAuthContext['user'];
  scopes: string[];
  createdAt: number;
  lastSeenAt: number;
  projectDir: string | null;
  projectName: string | null;
}

const sessions = new Map<string, McpSessionEntry>();
const runnerHosts = new Map<string, McpRunnerHostEntry>();
const MCP_SESSION_TTL_SECONDS = 120;
const MCP_RUNNER_TTL_SECONDS = 120;

function projectNameFromDir(projectDir: string | null | undefined): string | null {
  if (!projectDir) return null;
  const trimmed = projectDir.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return null;
  const name = basename(trimmed);
  return name || null;
}

export function registerMcpSession(entry: McpSessionEntry): void {
  pruneStaleMcpEntries();
  entry.projectName = entry.projectName ?? projectNameFromDir(entry.projectDir);
  sessions.set(entry.id, entry);
}

export function getMcpSession(sessionId: string): McpSessionEntry | undefined {
  return sessions.get(sessionId);
}

export function touchMcpSession(sessionId: string): void {
  pruneStaleMcpEntries();
  const existing = sessions.get(sessionId);
  if (!existing) return;
  existing.lastSeenAt = Math.floor(Date.now() / 1000);
  sessions.set(sessionId, existing);
}

export function removeMcpSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function listMcpSessions(): McpSessionEntry[] {
  pruneStaleMcpEntries();
  return Array.from(sessions.values());
}

export function findLatestMcpSessionByTokenId(tokenId: string): McpSessionEntry | undefined {
  pruneStaleMcpEntries();
  const matches = Array.from(sessions.values())
    .filter((entry) => entry.authContext.tokenId === tokenId)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return matches[0];
}

export function clearMcpSessionsForTests(): void {
  sessions.clear();
  runnerHosts.clear();
}

export function upsertMcpRunnerHost(
  entry: Omit<McpRunnerHostEntry, 'id' | 'createdAt' | 'projectName'> & { id?: string; createdAt?: number },
): McpRunnerHostEntry {
  pruneStaleMcpEntries();
  const key = entry.id ?? `${entry.tokenId}:${entry.runnerId}`;
  const now = Math.floor(Date.now() / 1000);
  const existing = runnerHosts.get(key);
  const next: McpRunnerHostEntry = {
    id: key,
    tokenId: entry.tokenId,
    runnerId: entry.runnerId,
    provider: entry.provider,
    user: entry.user,
    scopes: entry.scopes,
    createdAt: existing?.createdAt ?? entry.createdAt ?? now,
    lastSeenAt: entry.lastSeenAt ?? now,
    projectDir: entry.projectDir ?? null,
    projectName: projectNameFromDir(entry.projectDir ?? null),
  };
  runnerHosts.set(key, next);
  return next;
}

export function listMcpRunnerHosts(): McpRunnerHostEntry[] {
  pruneStaleMcpEntries();
  return Array.from(runnerHosts.values());
}

function pruneStaleMcpEntries(now = Math.floor(Date.now() / 1000)): void {
  for (const [id, session] of sessions.entries()) {
    if ((now - session.lastSeenAt) > MCP_SESSION_TTL_SECONDS) {
      sessions.delete(id);
    }
  }
  for (const [id, runner] of runnerHosts.entries()) {
    if ((now - runner.lastSeenAt) > MCP_RUNNER_TTL_SECONDS) {
      runnerHosts.delete(id);
    }
  }
}
