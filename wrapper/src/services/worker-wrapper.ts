import { EventEmitter } from 'events';
import type { BaseRunner, RunnerOptions } from './base-runner.js';
import type { WorkerConfig } from './worker-pool.js';
import type { WorkerType } from './worker-registry.js';

export type WorkerState = 'pending' | 'starting' | 'active' | 'stopping' | 'completed' | 'failed';

export interface WorkerStats {
  workerId: string;
  state: WorkerState;
  runId: string;
  workerType: WorkerType;
  startedAt: number | null;
  completedAt: number | null;
  exitCode: number | null;
  uptime: number;
  memoryUsageMB: number;
}

export class WorkerWrapper extends EventEmitter {
  private workerId: string;
  private runner: BaseRunner;
  private config: WorkerConfig;
  private state: WorkerState = 'pending';
  private startedAt: number | null = null;
  private completedAt: number | null = null;
  private exitCode: number | null = null;
  private processMemoryMB: number = 0;

  constructor(workerId: string, runner: BaseRunner, config: WorkerConfig) {
    super();
    this.workerId = workerId;
    this.runner = runner;
    this.config = config;
  }

  /**
   * Start the worker
   */
  async start(): Promise<void> {
    this.state = 'starting';
    this.startedAt = Date.now();

    console.log(`[WorkerWrapper ${this.workerId}] Starting...`);

    // Set up runner event handlers
    this.runner.on('exit', (code: number) => {
      this.handleExit(code);
    });

    this.runner.on('error', (err: Error) => {
      this.handleError(err);
    });

    // Start the runner
    await this.runner.start(this.config.command);

    this.state = 'active';
    this.emit('started');
  }

  /**
   * Stop the worker
   */
  async stop(): Promise<void> {
    if (this.state === 'completed' || this.state === 'failed' || this.state === 'stopping') {
      return;
    }

    console.log(`[WorkerWrapper ${this.workerId}] Stopping...`);
    this.state = 'stopping';

    try {
      await this.runner.stop();
      console.log(`[WorkerWrapper ${this.workerId}] Stopped gracefully`);
    } catch (err) {
      console.error(`[WorkerWrapper ${this.workerId}] Error stopping:`, err);
    }

    this.state = 'completed';
    this.completedAt = Date.now();
    this.emit('terminated');
  }

  /**
   * Handle runner exit
   */
  private handleExit(code: number): void {
    this.exitCode = code;
    this.completedAt = Date.now();

    if (code === 0) {
      this.state = 'completed';
      console.log(`[WorkerWrapper ${this.workerId}] Completed successfully`);
    } else {
      this.state = 'failed';
      console.log(`[WorkerWrapper ${this.workerId}] Failed with exit code ${code}`);
    }

    const stats = this.getStats();

    if (code === 0) {
      this.emit('completed', stats);
    } else {
      this.emit('failed', new Error(`Worker exited with code ${code}`));
    }
  }

  /**
   * Handle runner error
   */
  private handleError(error: Error): void {
    console.error(`[WorkerWrapper ${this.workerId}] Error:`, error);
    this.state = 'failed';
    this.completedAt = Date.now();
    this.emit('failed', error);
  }

  /**
   * Get current state
   */
  getState(): WorkerState {
    return this.state;
  }

  /**
   * Check if worker is active (running)
   */
  isActive(): boolean {
    return this.state === 'active';
  }

  /**
   * Check if worker is pending (waiting to start)
   */
  isPending(): boolean {
    return this.state === 'pending' || this.state === 'starting';
  }

  /**
   * Check if worker is finished
   */
  isFinished(): boolean {
    return this.state === 'completed' || this.state === 'failed';
  }

  /**
   * Get worker configuration
   */
  getConfig(): WorkerConfig {
    return { ...this.config };
  }

  /**
   * Get worker statistics
   */
  getStats(): WorkerStats {
    const now = Date.now();
    const uptime = this.startedAt ? now - this.startedAt : 0;

    // Estimate memory usage from process
    const memoryUsage = process.memoryUsage();

    return {
      workerId: this.workerId,
      state: this.state,
      runId: this.config.runId,
      workerType: this.config.workerType,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      exitCode: this.exitCode,
      uptime,
      memoryUsageMB: Math.round(memoryUsage.heapUsed / 1024 / 1024)
    };
  }

  /**
   * Get the underlying runner
   */
  getRunner(): BaseRunner {
    return this.runner;
  }
}