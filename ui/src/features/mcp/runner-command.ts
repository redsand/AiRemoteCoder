export interface RunnerCommandSnippet {
  bash: string;
  powershell: string;
}

function buildExecTemplatePlaceholder(provider: string): string {
  return `<SET_${provider.toUpperCase()}_COMMAND_WITH_{input}_PLACEHOLDER>`;
}

export function buildRunnerCommandSnippet(
  provider: string,
  runnerIdSeed: string,
  gatewayUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3100'
): RunnerCommandSnippet {
  const normalizedProvider = (provider || 'codex').toLowerCase();
  const safeRunnerId = runnerIdSeed.replace(/"/g, '\\"');
  const safeGatewayUrl = gatewayUrl.replace(/"/g, '\\"');
  const codexSpecificEnv = normalizedProvider === 'codex'
    ? 'export AIREMOTECODER_CODEX_MODE="app-server"\nexport AIREMOTECODER_CODEX_APPROVAL_POLICY="never"\n'
    : `export AIREMOTECODER_EXEC_TEMPLATE="${buildExecTemplatePlaceholder(normalizedProvider)}"\n`;
  const codexSpecificPsEnv = normalizedProvider === 'codex'
    ? '$env:AIREMOTECODER_CODEX_MODE="app-server"\n$env:AIREMOTECODER_CODEX_APPROVAL_POLICY="never"\n'
    : `$env:AIREMOTECODER_EXEC_TEMPLATE="${buildExecTemplatePlaceholder(normalizedProvider)}"\n`;

  return {
    bash: `export AIREMOTECODER_GATEWAY_URL="${safeGatewayUrl}"
export AIREMOTECODER_MCP_TOKEN="<YOUR_MCP_TOKEN>"
export AIREMOTECODER_PROVIDER="${normalizedProvider}"
${codexSpecificEnv}export AIREMOTECODER_RUNNER_ID="${safeRunnerId}"
airc-mcp-runner --runner-id "$AIREMOTECODER_RUNNER_ID"`,
    powershell: `$env:AIREMOTECODER_GATEWAY_URL="${safeGatewayUrl}"
$env:AIREMOTECODER_MCP_TOKEN="<YOUR_MCP_TOKEN>"
$env:AIREMOTECODER_PROVIDER="${normalizedProvider}"
${codexSpecificPsEnv}$env:AIREMOTECODER_RUNNER_ID="${safeRunnerId}"
airc-mcp-runner --runner-id "$env:AIREMOTECODER_RUNNER_ID"`,
  };
}
