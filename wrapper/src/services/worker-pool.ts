import { EventEmitter } from 'events';
import os from 'os';
import { WorkerWrapper, type WorkerStats } from './worker-wrapper.js';
import type { BaseRunner } from './base-runner.js';
import type { WorkerType, getWorkerCommand } from './worker-registry.js';
import { getWorkerDisplayName } from './worker-registry.js';

export interface WorkerConfig {
  runId: string;
  capabilityToken: string;
  workerType: WorkerType;
  command?: string;
  workingDir?: string;
  autonomous?: boolean;
  model?: string;
  integration?: string;
  provider?: string;
}

export interface ResourceLimits {
  maxConcurrent: number;
  maxMemoryMB?: number;
  maxCpuPercent?: number;
}

export interface ResourceStats {
  activeWorkers: number;
  pendingWorkers: number;
  memoryUsageMB: number;
  cpuUsagePercent: number;
}

export class WorkerPool extends EventEmitter {
  private workers: Map<string, WorkerWrapper> = new Map();
  private limits: ResourceLimits;
  private hostname: string;
  private startTime: number;
  private totalRunsCompleted: number = 0;
  private totalRunsFailed: number = 0;

  constructor(limits: ResourceLimits) {
    super();
    this.limits = limits;
    this.hostname = os.hostname();
    this.startTime = Date.now();
  }

  /**
   * Get current resource stats
   */
  getResourceStats(): ResourceStats {
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    return {
      activeWorkers: this.getActiveWorkerCount(),
      pendingWorkers: this.getPendingWorkerCount(),
      memoryUsageMB: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      cpuUsagePercent: this.calculateCpuPercent(cpuUsage)
    };
  }

  /**
   * Check if resources are available for a new worker
   */
  checkResourceAvailability(workerType: string): boolean {
    const stats = this.getResourceStats();
    const hasCapacity = stats.activeWorkers < this.limits.maxConcurrent;

    if (!hasCapacity) {
      console.log(`[WorkerPool] No capacity for ${workerType}: ${stats.activeWorkers}/${this.limits.maxConcurrent} active`);
    }

    return hasCapacity;
  }

  /**
   * Spawn a new worker for the given run
   */
  async spawnWorker(runner: BaseRunner, config: WorkerConfig): Promise<WorkerWrapper> {
    if (!this.checkResourceAvailability(config.workerType)) {
      throw new Error(`No capacity available for ${config.workerType} worker`);
    }

    const workerId = `${this.hostname}-${config.runId}`;

    console.log(`[WorkerPool] Spawning worker ${workerId} for run ${config.runId}`);
    console.log(`[WorkerPool] Worker type: ${getWorkerDisplayName(config.workerType)}`);
    console.log(`[WorkerPool] Command: ${config.command || '(none)'}`);

    const wrapper = new WorkerWrapper(workerId, runner, config);

    wrapper.on('started', () => {
      console.log(`[WorkerPool] Worker ${workerId} started`);
      this.emit('worker-started', workerId, config);
    });

    wrapper.on('completed', (stats: WorkerStats) => {
      console.log(`[WorkerPool] Worker ${workerId} completed with exit code ${stats.exitCode}`);
      this.totalRunsCompleted++;
      this.emit('worker-completed', workerId, stats);
    });

    wrapper.on('failed', (error: Error) => {
      console.error(`[WorkerPool] Worker ${workerId} failed:`, error.message);
      this.totalRunsFailed++;
      this.emit('worker-failed', workerId, error);
    });

    wrapper.on('terminated', () => {
      console.log(`[WorkerPool] Worker ${workerId} terminated`);
      this.workers.delete(workerId);
      this.emit('worker-terminated', workerId);
    });

    this.workers.set(workerId, wrapper);

    try {
      await wrapper.start();
    } catch (err) {
      this.workers.delete(workerId);
      throw err;
    }

    return wrapper;
  }

  /**
   * Terminate a worker
   */
  async terminateWorker(workerId: string): Promise<void> {
    const wrapper = this.workers.get(workerId);
    if (!wrapper) {
      console.warn(`[WorkerPool] Worker ${workerId} not found`);
      return;
    }

    console.log(`[WorkerPool] Terminating worker ${workerId}`);
    await wrapper.stop();
    this.workers.delete(workerId);
  }

  /**
   * Terminate all workers
   */
  async terminateAll(): Promise<void> {
    console.log(`[WorkerPool] Terminating all workers (${this.workers.size})`);

    const promises = Array.from(this.workers.entries()).map(([id, wrapper]) => {
      return wrapper.stop().catch(err => {
        console.error(`[WorkerPool] Failed to stop worker ${id}:`, err);
      });
    });

    await Promise.all(promises);
    this.workers.clear();
  }

  /**
   * Get worker by ID
   */
  getWorker(workerId: string): WorkerWrapper | undefined {
    return this.workers.get(workerId);
  }

  /**
   * Get all active workers
   */
  getActiveWorkers(): WorkerWrapper[] {
    return Array.from(this.workers.values()).filter(w => w.isActive());
  }

  /**
   * Get all pending workers
   */
  getPendingWorkers(): WorkerWrapper[] {
    return Array.from(this.workers.values()).filter(w => w.isPending());
  }

  /**
   * Get worker count
   */
  getActiveWorkerCount(): number {
    return Array.from(this.workers.values()).filter(w => w.isActive()).length;
  }

  /**
   * Get pending worker count
   */
  getPendingWorkerCount(): number {
    return Array.from(this.workers.values()).filter(w => w.isPending()).length;
  }

  /**
   * Get worker stats
   */
  getWorkerStats(): Array<{ workerId: string; config: WorkerConfig; stats: WorkerStats }> {
    return Array.from(this.workers.entries()).map(([workerId, wrapper]) => ({
      workerId,
      config: wrapper.getConfig(),
      stats: wrapper.getStats()
    }));
  }

  /**
   * Enforce resource limits (called periodically)
   */
  enforceResourceLimits(): void {
    const stats = this.getResourceStats();

    // Check memory limit
    if (this.limits.maxMemoryMB && stats.memoryUsageMB > this.limits.maxMemoryMB) {
      console.warn(`[WorkerPool] Memory limit exceeded: ${stats.memoryUsageMB}/${this.limits.maxMemoryMB}MB`);
      // Could trigger worker termination here if needed
    }

    // Check CPU limit
    if (this.limits.maxCpuPercent && stats.cpuUsagePercent > this.limits.maxCpuPercent) {
      console.warn(`[WorkerPool] CPU limit exceeded: ${stats.cpuUsagePercent}/${this.limits.maxCpuPercent}%`);
      // Could trigger worker termination here if needed
    }

    // Log stats
    const activeCount = stats.activeWorkers;
    const pendingCount = stats.pendingWorkers;
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);

    console.log(`[WorkerPool] Stats: ${activeCount} active, ${pendingCount} pending, ` +
                `${stats.memoryUsageMB}MB memory, ${stats.cpuUsagePercent}% CPU, ` +
                `${this.totalRunsCompleted} completed, ${this.totalRunsFailed} failed, ` +
                `uptime: ${uptime}s`);
  }

  /**
   * Get pool summary
   */
  getSummary() {
    const stats = this.getResourceStats();
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);

    return {
      hostname: this.hostname,
      activeWorkers: stats.activeWorkers,
      pendingWorkers: stats.pendingWorkers,
      maxConcurrent: this.limits.maxConcurrent,
      memoryUsageMB: stats.memoryUsageMB,
      cpuUsagePercent: stats.cpuUsagePercent,
      totalRunsCompleted: this.totalRunsCompleted,
      totalRunsFailed: this.totalRunsFailed,
      uptime
    };
  }

  /**
   * Calculate CPU usage percentage
   */
  private calculateCpuPercent(cpuUsage: NodeJS.CpuUsage): number {
    // Simplified CPU calculation
    const totalTime = cpuUsage.user + cpuUsage.system;
    // This is a rough estimate - for more accurate results we'd need to track delta
    return Math.min(100, Math.round(totalTime / 1000000)); // Convert to approximate percentage
  }
}