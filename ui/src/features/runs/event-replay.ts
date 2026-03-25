import type { LogEvent } from '../../components/ui';

export async function loadAllRunEvents(
  runId: string,
  fetchImpl: typeof fetch = fetch,
  pageSize = 500,
): Promise<LogEvent[]> {
  const events: LogEvent[] = [];
  let after = 0;

  while (true) {
    const res = await fetchImpl(`/api/runs/${runId}/events?after=${after}&limit=${pageSize}`);
    if (!res.ok) {
      throw new Error(`Failed to load events for run ${runId}`);
    }

    const batch = await res.json() as LogEvent[];
    if (batch.length === 0) break;

    events.push(...batch);
    after = batch[batch.length - 1].id;

    if (batch.length < pageSize) break;
  }

  return events;
}
