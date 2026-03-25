export function shouldBypassRateLimit(url: string | undefined, mcpPath: string): boolean {
  const normalizedUrl = url || '';
  if (normalizedUrl.startsWith('/ws/vnc/')) return true;
  if (/^\/api\/runs\/[^/]+\/vnc/.test(normalizedUrl)) return true;
  if (normalizedUrl === mcpPath || normalizedUrl.startsWith(mcpPath + '?')) return true;
  if (normalizedUrl.startsWith('/api/mcp/')) return true;
  return false;
}
