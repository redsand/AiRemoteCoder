export interface RunnerCommandSnippet {
  bash: string;
  powershell: string;
}

export function buildRunnerCommandSnippet(
  provider: string,
  runnerIdSeed: string,
  gatewayUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3100'
): RunnerCommandSnippet {
  const normalizedProvider = (provider || 'codex').toLowerCase();
  const safeRunnerId = runnerIdSeed.replace(/"/g, '\\"');
  const safeGatewayUrl = gatewayUrl.replace(/"/g, '\\"');

  return {
    bash: `export AIREMOTECODER_GATEWAY_URL="${safeGatewayUrl}"
export AIREMOTECODER_MCP_TOKEN="<YOUR_MCP_TOKEN>"
export AIREMOTECODER_PROVIDER="${normalizedProvider}"
export AIREMOTECODER_CODEX_MODE="app-server"
export AIREMOTECODER_RUNNER_ID="${safeRunnerId}"
airc-mcp-runner --runner-id "$AIREMOTECODER_RUNNER_ID"`,
    powershell: `$env:AIREMOTECODER_GATEWAY_URL="${safeGatewayUrl}"
$env:AIREMOTECODER_MCP_TOKEN="<YOUR_MCP_TOKEN>"
$env:AIREMOTECODER_PROVIDER="${normalizedProvider}"
$env:AIREMOTECODER_CODEX_MODE="app-server"
$env:AIREMOTECODER_RUNNER_ID="${safeRunnerId}"
airc-mcp-runner --runner-id "$env:AIREMOTECODER_RUNNER_ID"`,
  };
}
