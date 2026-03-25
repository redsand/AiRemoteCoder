export function getRunsRefreshInterval(statuses: string[]): number {
  return statuses.some((status) => status === 'pending') ? 3000 : 15000;
}

export function shouldPollPendingRun(status: string | null | undefined): boolean {
  return status === 'pending';
}
