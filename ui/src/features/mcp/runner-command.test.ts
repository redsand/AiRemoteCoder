import { describe, expect, it } from 'vitest';
import { buildRunnerCommandSnippet } from './runner-command';

describe('buildRunnerCommandSnippet', () => {
  it('builds a copyable bash and powershell command with runner id', () => {
    const snippet = buildRunnerCommandSnippet('codex', 'runner-123', 'http://localhost:3100');
    expect(snippet.bash).toContain('AIREMOTECODER_GATEWAY_URL="http://localhost:3100"');
    expect(snippet.bash).toContain('AIREMOTECODER_MCP_TOKEN="<YOUR_MCP_TOKEN>"');
    expect(snippet.bash).toContain('AIREMOTECODER_PROVIDER="codex"');
    expect(snippet.bash).toContain('AIREMOTECODER_CODEX_MODE="app-server"');
    expect(snippet.bash).toContain('AIREMOTECODER_RUNNER_ID="runner-123"');
    expect(snippet.bash).toContain('airc-mcp-runner --runner-id "$AIREMOTECODER_RUNNER_ID"');
    expect(snippet.powershell).toContain('$env:AIREMOTECODER_GATEWAY_URL="http://localhost:3100"');
    expect(snippet.powershell).toContain('$env:AIREMOTECODER_MCP_TOKEN="<YOUR_MCP_TOKEN>"');
    expect(snippet.powershell).toContain('$env:AIREMOTECODER_PROVIDER="codex"');
    expect(snippet.powershell).toContain('$env:AIREMOTECODER_CODEX_MODE="app-server"');
    expect(snippet.powershell).toContain('$env:AIREMOTECODER_RUNNER_ID="runner-123"');
    expect(snippet.powershell).toContain('airc-mcp-runner --runner-id "$env:AIREMOTECODER_RUNNER_ID"');
  });
});
