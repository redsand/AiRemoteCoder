import { describe, expect, it } from 'vitest';
import { getRunsRefreshInterval, shouldPollPendingRun } from './refresh';

describe('run refresh policy', () => {
  it('polls faster when any run is pending', () => {
    expect(getRunsRefreshInterval(['running', 'pending'])).toBe(3000);
  });

  it('uses normal cadence when nothing is pending', () => {
    expect(getRunsRefreshInterval(['running', 'done', 'failed'])).toBe(15000);
  });

  it('polls individual run detail only while pending', () => {
    expect(shouldPollPendingRun('pending')).toBe(true);
    expect(shouldPollPendingRun('running')).toBe(false);
    expect(shouldPollPendingRun('done')).toBe(false);
    expect(shouldPollPendingRun(null)).toBe(false);
  });
});
