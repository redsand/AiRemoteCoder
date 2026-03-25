export interface RunnerCommandSnippet {
  bash: string;
  powershell: string;
}

export function buildRunnerCommandSnippet(provider: string, runnerIdSeed: string): RunnerCommandSnippet {
  const normalizedProvider = (provider || 'codex').toLowerCase();
  const safeRunnerId = runnerIdSeed.replace(/"/g, '\\"');

  return {
    bash: `export AIREMOTECODER_PROVIDER="${normalizedProvider}"
export AIREMOTECODER_CODEX_MODE="interactive"
export AIREMOTECODER_RUNNER_ID="${safeRunnerId}"
airc-mcp-runner --runner-id "$AIREMOTECODER_RUNNER_ID"`,
    powershell: `$env:AIREMOTECODER_PROVIDER="${normalizedProvider}"
$env:AIREMOTECODER_CODEX_MODE="interactive"
$env:AIREMOTECODER_RUNNER_ID="${safeRunnerId}"
airc-mcp-runner --runner-id "$env:AIREMOTECODER_RUNNER_ID"`,
  };
}
