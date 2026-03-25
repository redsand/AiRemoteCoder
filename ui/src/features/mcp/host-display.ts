import type { McpActiveSession } from './types';

export function getMcpHostTitle(session: McpActiveSession): string {
  const project = session.projectName?.trim();
  const runner = session.runnerId?.trim();
  if (project && runner) return `${project} • runner ${runner}`;
  if (project) return `${project} • ${(session.provider ?? 'unknown').toUpperCase()}`;
  if (runner) return `runner ${runner}`;
  return `${(session.provider ?? 'unknown').toUpperCase()} ${session.kind === 'runner' ? 'helper' : 'session'}`;
}

export function getMcpHostSubtitle(session: McpActiveSession): string {
  const parts = [
    session.kind === 'runner' ? 'connected' : 'session connected',
    session.projectDir ? `Directory: ${session.projectDir}` : null,
    session.user?.username ? `User: ${session.user.username}` : null,
  ].filter(Boolean);
  return parts.join(' • ');
}
