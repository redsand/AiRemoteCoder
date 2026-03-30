import type { McpActiveSession } from '../mcp/types';
import { isMcpSessionFresh } from '../mcp/run-worker-options';

interface RunMetadata {
  mcpRunnerId?: string | null;
  mcpSessionId?: string | null;
}

interface RunLike {
  worker_type?: string | null;
  metadata?: RunMetadata | null;
}

export interface RunConnectivityEntry {
  label: string;
  status: 'connected' | 'disconnected' | 'unknown';
  detail: string;
}

function findRunnerHost(run: RunLike, sessions: McpActiveSession[]): McpActiveSession | null {
  const runnerId = run.metadata?.mcpRunnerId;
  if (!runnerId) return null;
  return sessions.find((session) => session.kind === 'runner' && (session.id === runnerId || session.runnerId === runnerId)) ?? null;
}

function findExactSession(run: RunLike, sessions: McpActiveSession[]): McpActiveSession | null {
  const sessionId = run.metadata?.mcpSessionId;
  if (!sessionId) return null;
  return sessions.find((session) => session.kind === 'session' && session.id === sessionId) ?? null;
}

function findProviderSession(run: RunLike, sessions: McpActiveSession[]): McpActiveSession | null {
  const provider = run.worker_type?.toLowerCase();
  if (!provider || provider === 'vnc' || provider === 'hands-on') return null;
  return sessions.find((session) => session.kind === 'session' && session.provider === provider) ?? null;
}

export function buildRunConnectivitySummary(
  run: RunLike,
  sessions: McpActiveSession[],
  streamConnected: boolean,
  reconnecting: boolean
): RunConnectivityEntry[] {
  const entries: RunConnectivityEntry[] = [
    {
      label: 'UI Stream',
      status: streamConnected ? 'connected' : reconnecting ? 'unknown' : 'disconnected',
      detail: streamConnected ? 'Gateway event stream connected' : reconnecting ? 'Reconnecting to gateway event stream' : 'Gateway event stream disconnected',
    },
  ];

  const runnerHost = findRunnerHost(run, sessions);
  if (run.metadata?.mcpRunnerId) {
    entries.push({
      label: 'Runner Host',
      status: runnerHost && isMcpSessionFresh(runnerHost) ? 'connected' : 'disconnected',
      detail: runnerHost?.projectDir
        ? `Helper heartbeat seen from ${runnerHost.projectDir}`
        : runnerHost
          ? 'Helper heartbeat seen recently'
          : 'No active helper heartbeat for this run target',
    });
  }

  const exactSession = findExactSession(run, sessions);
  if (run.metadata?.mcpSessionId) {
    entries.push({
      label: 'MCP Session',
      status: exactSession && isMcpSessionFresh(exactSession) ? 'connected' : 'disconnected',
      detail: exactSession
        ? `Pinned ${String(exactSession.provider ?? 'agent').toUpperCase()} session is active`
        : 'Pinned MCP session is not connected',
    });
    return entries;
  }

  const providerSession = findProviderSession(run, sessions);
  if (providerSession) {
    entries.push({
      label: 'MCP Session',
      status: isMcpSessionFresh(providerSession) ? 'connected' : 'disconnected',
      detail: `${String(providerSession.provider ?? 'agent').toUpperCase()} session detected, but this run is not pinned to a specific MCP client`,
    });
  } else if (run.worker_type && !['vnc', 'hands-on'].includes(run.worker_type)) {
    entries.push({
      label: 'MCP Session',
      status: 'unknown',
      detail: 'No MCP client session detected for this provider',
    });
  }

  return entries;
}
