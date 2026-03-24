import type { McpActiveSession } from './types';

export const MCP_HOST_FRESHNESS_SECONDS = 45;

export function isMcpSessionFresh(
  session: McpActiveSession | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
  freshnessWindowSeconds = MCP_HOST_FRESHNESS_SECONDS
): boolean {
  if (!session) return false;
  const age = nowSeconds - session.lastSeenAt;
  return age >= 0 && age <= freshnessWindowSeconds;
}
