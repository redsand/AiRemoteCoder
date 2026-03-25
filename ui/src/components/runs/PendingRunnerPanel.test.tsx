import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PendingRunnerPanel } from './PendingRunnerPanel';

describe('PendingRunnerPanel', () => {
  it('renders helper commands for runner-targeted runs regardless of status', () => {
    const html = renderToStaticMarkup(
      <PendingRunnerPanel
        workerType="claude"
        runnerId="runner-123"
        gatewayUrl="http://localhost:3100"
      />
    );

    expect(html).toContain('Runner Setup');
    expect(html).toContain('Launch or restart the CLAUDE helper');
    expect(html).toContain('AIREMOTECODER_PROVIDER=&quot;claude&quot;');
    expect(html).toContain('AIREMOTECODER_RUNNER_ID=&quot;runner-123&quot;');
    expect(html).toContain('airc-mcp-runner --runner-id');
  });

  it('does not render for untargeted or unsupported runs', () => {
    const unsupported = renderToStaticMarkup(
      <PendingRunnerPanel
        workerType="hands-on"
        runnerId="runner-123"
        gatewayUrl="http://localhost:3100"
      />
    );
    const missingRunner = renderToStaticMarkup(
      <PendingRunnerPanel
        workerType="codex"
        runnerId={null}
        gatewayUrl="http://localhost:3100"
      />
    );

    expect(unsupported).toBe('');
    expect(missingRunner).toBe('');
  });
});
