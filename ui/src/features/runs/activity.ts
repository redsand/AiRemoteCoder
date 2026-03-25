import type { LogEvent } from '../../components/ui/LiveLogViewer';

export interface RunActivitySummary {
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'error';
  title: string;
  detail: string;
}

export function summarizeRunActivity(
  runStatus: string | null | undefined,
  events: LogEvent[],
  pendingCommandCount: number,
): RunActivitySummary {
  const lastEvent = [...events].reverse().find((event) => event.type !== 'stdout');
  const lastData = lastEvent?.data ?? '';

  if (runStatus === 'pending') {
    return {
      tone: 'warning',
      title: 'Waiting for runner claim',
      detail: pendingCommandCount > 0 ? `${pendingCommandCount} queued command${pendingCommandCount === 1 ? '' : 's'} waiting for pickup.` : 'No runner has claimed this run yet.',
    };
  }

  if (runStatus === 'running' && /"method":"item\/started".*"commandExecution"/.test(lastData)) {
    return {
      tone: 'info',
      title: 'Codex is executing a tool',
      detail: pendingCommandCount > 0 ? 'The latest prompt is active. Command completion will clear the pending badge.' : 'Tool execution is in progress.',
    };
  }

  if (runStatus === 'running' && /"method":"item\/started".*"agentMessage"/.test(lastData)) {
    return {
      tone: 'info',
      title: 'Codex is composing a response',
      detail: pendingCommandCount > 0 ? 'The command is still active while the turn streams tokens.' : 'Streaming output is in progress.',
    };
  }

  if (runStatus === 'running' && pendingCommandCount > 0) {
    return {
      tone: 'warning',
      title: 'Command still pending completion',
      detail: 'The runner accepted the run, but the current turn has not finished yet.',
    };
  }

  if (runStatus === 'done') {
    return {
      tone: 'success',
      title: 'Run completed',
      detail: 'The runner reported a finished marker for this run.',
    };
  }

  if (runStatus === 'failed') {
    return {
      tone: 'error',
      title: 'Run failed',
      detail: 'Check the error lines and recent command history for the failure point.',
    };
  }

  return {
    tone: 'neutral',
    title: 'Awaiting activity',
    detail: pendingCommandCount > 0 ? `${pendingCommandCount} command${pendingCommandCount === 1 ? '' : 's'} queued.` : 'No recent structured activity yet.',
  };
}
