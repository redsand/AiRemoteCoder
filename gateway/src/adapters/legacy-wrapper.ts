/**
 * @deprecated LegacyWrapperAdapter
 *
 * Compatibility shim that makes the existing subprocess/stdio wrapper flow
 * appear as a ProviderAdapter to the orchestrator.
 *
 * THIS ADAPTER IS SCHEDULED FOR REMOVAL IN THE NEXT MAJOR RELEASE.
 *
 * The legacy wrapper controls AI agents by:
 *   1. Spawning a process with piped stdin/stdout/stderr
 *   2. Writing commands to stdin
 *   3. Polling the gateway every 2 seconds for pending commands
 *   4. Parsing output buffers for event markers
 *
 * This brittle model is replaced by native provider adapters that speak
 * structured protocols. Migrate to a native adapter as soon as your
 * target provider is supported.
 *
 * Migration path:
 *   - Claude     → ClaudeAdapter (in development)
 *   - Codex      → CodexAdapter  (in development)
 *   - Gemini     → GeminiAdapter (in development)
 *   - OpenCode   → OpenCodeAdapter (has native MCP support)
 *   - Rev        → RevAdapter    (in development)
 *
 * @see docs/MIGRATION_FROM_LEGACY.md
 */

import type { ProviderAdapter, StartSessionOptions, AdapterEvent, ApprovalResolution } from './types.js';
import type {
  ProviderName, SessionId, Checkpoint, ResumeToken, Artifact, AgentCapability,
} from '../domain/types.js';
import { db } from '../services/database.js';
import { nanoid } from 'nanoid';

/**
 * @deprecated Use a native provider adapter instead.
 *
 * This class surfaces the existing DB-backed command/event model as an adapter
 * interface so the orchestrator and MCP server can talk to legacy wrappers
 * without knowing their implementation details.
 */
export class LegacyWrapperAdapter implements ProviderAdapter {
  /** @deprecated */
  readonly provider: ProviderName = 'legacy_wrapper';

  // Sessions managed externally by wrapper processes; we track them by runId.
  private readonly activeSessions = new Map<SessionId, string>(); // sessionId → runId

  /** @deprecated */
  async startSession(options: StartSessionOptions): Promise<SessionId> {
    // The legacy model: a run record already exists; a wrapper picks it up by
    // claiming it via POST /api/runs/claim. We cannot "start" a session here —
    // we just track the mapping and wait for the wrapper to claim the run.
    const sessionId = nanoid();
    this.activeSessions.set(sessionId, options.runId);
    return sessionId;
  }

  /** @deprecated */
  async attachToSession(_sessionId: SessionId, _onEvent: (event: AdapterEvent) => void): Promise<void> {
    // Legacy wrappers push events via HTTP POST /api/ingest/event → WebSocket.
    // Attaching an additional listener here is not directly supported.
    // Use WebSocket subscription on the gateway instead.
  }

  /** @deprecated */
  async sendUserInput(sessionId: SessionId, input: string): Promise<void> {
    const runId = this.activeSessions.get(sessionId);
    if (!runId) throw new Error(`LegacyWrapperAdapter: unknown sessionId ${sessionId}`);

    const cmdId = nanoid();
    db.prepare(`
      INSERT INTO commands (id, run_id, command, arguments, status, created_at)
      VALUES (?, ?, '__INPUT__', ?, 'pending', unixepoch())
    `).run(cmdId, runId, JSON.stringify({ text: input }));
  }

  /** @deprecated */
  async interrupt(sessionId: SessionId): Promise<void> {
    const runId = this.activeSessions.get(sessionId);
    if (!runId) throw new Error(`LegacyWrapperAdapter: unknown sessionId ${sessionId}`);

    const cmdId = nanoid();
    db.prepare(`
      INSERT INTO commands (id, run_id, command, status, created_at)
      VALUES (?, ?, '__ESCAPE__', 'pending', unixepoch())
    `).run(cmdId, runId);
  }

  /** @deprecated — Legacy wrappers do not support in-band checkpoints. */
  async checkpoint(_sessionId: SessionId): Promise<Checkpoint | null> {
    // Legacy wrappers persist state to run_state table automatically.
    // Return null here; the orchestrator will read run_state directly.
    return null;
  }

  /** @deprecated */
  async resume(token: ResumeToken, options: StartSessionOptions): Promise<SessionId> {
    // For legacy wrappers, resume = create a new run with the same metadata.
    // The wrapper will reload state from run_state on startup.
    return this.startSession(options);
  }

  /** @deprecated — Legacy wrappers do not support structured approval gating. */
  async applyApprovalDecision(_sessionId: SessionId, resolution: ApprovalResolution): Promise<void> {
    const runId = this.activeSessions.get(_sessionId);
    if (!runId) return;

    // Post a resolution command that the wrapper's stdin handler can process.
    const cmdId = nanoid();
    db.prepare(`
      INSERT INTO commands (id, run_id, command, arguments, status, created_at)
      VALUES (?, ?, '__APPROVAL_RESOLVED__', ?, 'pending', unixepoch())
    `).run(cmdId, runId, JSON.stringify(resolution));
  }

  /** @deprecated */
  async fetchArtifacts(sessionId: SessionId): Promise<Artifact[]> {
    const runId = this.activeSessions.get(sessionId);
    if (!runId) return [];

    return db.prepare('SELECT * FROM artifacts WHERE run_id = ?').all(runId) as Artifact[];
  }

  /** @deprecated */
  async terminate(sessionId: SessionId): Promise<void> {
    const runId = this.activeSessions.get(sessionId);
    if (!runId) return;

    const cmdId = nanoid();
    db.prepare(`
      INSERT INTO commands (id, run_id, command, status, created_at)
      VALUES (?, ?, '__STOP__', 'pending', unixepoch())
    `).run(cmdId, runId);

    this.activeSessions.delete(sessionId);
  }

  /** @deprecated */
  getCapabilities(): AgentCapability {
    return {
      provider: 'legacy_wrapper',
      supportsInteractiveInput: true,
      supportsResume: true,
      supportsCheckpoint: true,
      supportsApprovalGating: false,
      supportsToolUseEvents: false,
      supportsStreaming: true,
      supportsModelSelection: false,
      nativeMcp: false,
      version: '1.0.0',
    };
  }

  /** @deprecated */
  async healthcheck(): Promise<boolean> {
    // Check if any clients are online as a proxy for wrapper health.
    const row = db.prepare("SELECT COUNT(*) as c FROM clients WHERE status = 'online'").get() as { c: number };
    return row.c > 0;
  }
}
