import { describe, expect, it } from 'vitest';
import { buildRunnerCommandSnippet } from './runner-command';

describe('buildRunnerCommandSnippet', () => {
  it('builds a copyable bash and powershell command with runner id', () => {
    const snippet = buildRunnerCommandSnippet('codex', 'runner-123', 'http://localhost:3100');
    expect(snippet.bash).toContain('AIREMOTECODER_GATEWAY_URL="http://localhost:3100"');
    expect(snippet.bash).toContain('AIREMOTECODER_MCP_TOKEN="<YOUR_MCP_TOKEN>"');
    expect(snippet.bash).toContain('AIREMOTECODER_PROVIDER="codex"');
    expect(snippet.bash).toContain('AIREMOTECODER_CODEX_MODE="app-server"');
    expect(snippet.bash).toContain('AIREMOTECODER_CODEX_APPROVAL_POLICY="never"');
    expect(snippet.bash).toContain('AIREMOTECODER_RUNNER_ID="runner-123"');
    expect(snippet.bash).toContain('airc-mcp-runner --runner-id "$AIREMOTECODER_RUNNER_ID"');
    expect(snippet.powershell).toContain('$env:AIREMOTECODER_GATEWAY_URL="http://localhost:3100"');
    expect(snippet.powershell).toContain('$env:AIREMOTECODER_MCP_TOKEN="<YOUR_MCP_TOKEN>"');
    expect(snippet.powershell).toContain('$env:AIREMOTECODER_PROVIDER="codex"');
    expect(snippet.powershell).toContain('$env:AIREMOTECODER_CODEX_MODE="app-server"');
    expect(snippet.powershell).toContain('$env:AIREMOTECODER_CODEX_APPROVAL_POLICY="never"');
    expect(snippet.powershell).toContain('$env:AIREMOTECODER_RUNNER_ID="runner-123"');
    expect(snippet.powershell).toContain('airc-mcp-runner --runner-id "$env:AIREMOTECODER_RUNNER_ID"');
  });

  it('does not emit Codex-only mode flags for non-codex providers', () => {
    const snippet = buildRunnerCommandSnippet('gemini', 'runner-456', 'http://localhost:3100');

    expect(snippet.bash).toContain('AIREMOTECODER_PROVIDER="gemini"');
    expect(snippet.bash).not.toContain('AIREMOTECODER_CODEX_MODE=');
    expect(snippet.bash).toContain('AIREMOTECODER_EXEC_TEMPLATE="<SET_GEMINI_COMMAND_WITH_{input}_PLACEHOLDER>"');

    expect(snippet.powershell).toContain('$env:AIREMOTECODER_PROVIDER="gemini"');
    expect(snippet.powershell).not.toContain('AIREMOTECODER_CODEX_MODE=');
    expect(snippet.powershell).toContain('$env:AIREMOTECODER_EXEC_TEMPLATE="<SET_GEMINI_COMMAND_WITH_{input}_PLACEHOLDER>"');
  });

  it('does not require an exec template for Claude preview runner commands', () => {
    const snippet = buildRunnerCommandSnippet('claude', 'runner-789', 'http://localhost:3100');

    expect(snippet.bash).toContain('AIREMOTECODER_PROVIDER="claude"');
    expect(snippet.bash).not.toContain('AIREMOTECODER_EXEC_TEMPLATE=');
    expect(snippet.bash).toContain('airc-mcp-runner --runner-id "$AIREMOTECODER_RUNNER_ID"');

    expect(snippet.powershell).toContain('$env:AIREMOTECODER_PROVIDER="claude"');
    expect(snippet.powershell).not.toContain('AIREMOTECODER_EXEC_TEMPLATE=');
    expect(snippet.powershell).toContain('airc-mcp-runner --runner-id "$env:AIREMOTECODER_RUNNER_ID"');
  });
});
