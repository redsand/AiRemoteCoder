/**
 * Autonomous Loop Poller
 * 
 * Continuously polls for new work items and dispatches them to the
 * autonomous loop orchestrator. Designed to run as a long-lived process
 * that keeps the AI agent productive without human intervention.
 * 
 * Polling Strategy:
 * - Checks for new work every POLL_INTERVAL_MS
 * - Respects rate limits and backoff on errors
 * - Supports graceful shutdown via SIGINT/SIGTERM
 * - Emits events for observability
 */

import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PollerConfig {
  /** Milliseconds between polls (default: 30_000) */
  pollIntervalMs?: number;
  /** Max consecutive errors before entering backoff (default: 5) */
  maxConsecutiveErrors?: number;
  /** Base backoff multiplier in ms (default: 60_000) */
  backoffBaseMs?: number;
  /** Maximum backoff in ms (default: 3_600_000 — 1 hour) */
  maxBackoffMs?: number;
}

export interface WorkItem {
  id: string;
  type: string;
  payload: unknown;
  priority: 'low' | 'medium' | 'high' | 'critical';
  createdAt: string;
}

export type PollerState = 'idle' | 'polling' | 'backoff' | 'stopped';

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

export class AutonomousLoopPoller extends EventEmitter {
  private state: PollerState = 'idle';
  private consecutiveErrors = 0;
  private currentBackoffMs = 0;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly config: Required<PollerConfig>;

  constructor(
    private readonly fetchWork: () => Promise<WorkItem[]>,
    config?: PollerConfig,
  ) {
    super();
    this.config = {
      pollIntervalMs: config?.pollIntervalMs ?? 30_000,
      maxConsecutiveErrors: config?.maxConsecutiveErrors ?? 5,
      backoffBaseMs: config?.backoffBaseMs ?? 60_000,
      maxBackoffMs: config?.maxBackoffMs ?? 3_600_000,
    };
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Start the poller loop. */
  start(): void {
    if (this.state !== 'idle' && this.state !== 'backoff') {
      return; // already running
    }
    this.state = 'polling';
    this.emit('started');
    this.scheduleNextPoll(0);
  }

  /** Gracefully stop the poller. In-flight poll completes, then halts. */
  stop(): void {
    this.state = 'stopped';
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    this.emit('stopped');
  }

  /** Current poller state for observability. */
  getState(): PollerState {
    return this.state;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private scheduleNextPoll(delayMs: number): void {
    if (this.state === 'stopped') return;
    this.timerHandle = setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    if (this.state === 'stopped') return;

    this.state = 'polling';
    this.emit('poll-started');

    try {
      const items = await this.fetchWork();
      this.consecutiveErrors = 0;
      this.currentBackoffMs = 0;

      if (items.length > 0) {
        this.emit('work-available', items);
      }

      this.emit('poll-completed', { itemCount: items.length });
      this.scheduleNextPoll(this.config.pollIntervalMs);
    } catch (err) {
      this.consecutiveErrors += 1;
      this.emit('poll-error', { error: err, consecutiveErrors: this.consecutiveErrors });

      if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
        // Enter exponential backoff
        this.currentBackoffMs = Math.min(
          this.config.backoffBaseMs * 2 ** (this.consecutiveErrors - this.config.maxConsecutiveErrors),
          this.config.maxBackoffMs,
        );
        this.state = 'backoff';
        this.emit('backoff-entered', { backoffMs: this.currentBackoffMs });
      }

      const delay = this.currentBackoffMs > 0 ? this.currentBackoffMs : this.config.pollIntervalMs;
      this.scheduleNextPoll(delay);
    }
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown helpers
// ---------------------------------------------------------------------------

/**
 * Wire up SIGINT / SIGTERM to stop a poller gracefully.
 * Returns a function to remove the handlers (useful in tests).
 */
export function wireGracefulShutdown(poller: AutonomousLoopPoller): () => void {
  const handler = () => {
    poller.stop();
    process.exit(0);
  };

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);

  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}