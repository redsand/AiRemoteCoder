/**
 * Provider adapter interface.
 *
 * Every AI agent runtime (Claude, Codex, Gemini, OpenCode, Rev, …) must be
 * wrapped in a class implementing ProviderAdapter. The orchestrator calls only
 * this interface — provider-specific quirks stay inside the adapter.
 *
 * Adapters replace the previous subprocess/stdio wrapper model. The legacy
 * wrapper compatibility shim is the only code path that still uses popen/pipe
 * internally, and it is marked @deprecated.
 */

import type {
  RunId,
  SessionId,
  Checkpoint,
  ResumeToken,
  Artifact,
  AgentCapability,
  ProviderName,
  AdapterEventType,
} from '../domain/types.js';

// ---------------------------------------------------------------------------
// Event emitted by adapter → orchestrator → subscribers
// ---------------------------------------------------------------------------

export interface AdapterEvent {
  runId: RunId;
  sessionId: SessionId;
  type: AdapterEventType;
  data: string;
  stepId?: string;
  /** Monotonically increasing within a session (resets between sessions). */
  sequence: number;
  timestamp: number;
  /** Structured payload for non-text events (tool_use, approval_requested, …). */
  structured?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Approval gate — adapter → orchestrator
// ---------------------------------------------------------------------------

export interface ApprovalGate {
  /** Unique ID the adapter generates so it can correlate the resolution. */
  correlationId: string;
  runId: RunId;
  sessionId: SessionId;
  description: string;
  action: Record<string, unknown>;
  timeoutSeconds: number;
}

export interface ApprovalResolution {
  correlationId: string;
  decision: 'approved' | 'denied';
  resolution: string | null;
}

// ---------------------------------------------------------------------------
// Session start options
// ---------------------------------------------------------------------------

export interface StartSessionOptions {
  runId: RunId;
  workingDir: string;
  command?: string;
  model?: string;
  environment?: Record<string, string>;
  resumeToken?: ResumeToken;
  /** Approval callback — called when the agent requests human approval. */
  onApprovalRequired?: (gate: ApprovalGate) => void;
  /** Event callback — called for every output/lifecycle event. */
  onEvent?: (event: AdapterEvent) => void;
}

// ---------------------------------------------------------------------------
// Provider adapter contract
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  /** Canonical provider name. */
  readonly provider: ProviderName;

  /**
   * Start a new agent session.
   * Returns the session ID once the session is established.
   */
  startSession(options: StartSessionOptions): Promise<SessionId>;

  /**
   * Attach an event listener to an already-running session.
   * Useful for observers connecting after session start.
   */
  attachToSession(sessionId: SessionId, onEvent: (event: AdapterEvent) => void): Promise<void>;

  /** Send user input (or a structured command) to the active session. */
  sendUserInput(sessionId: SessionId, input: string): Promise<void>;

  /** Send an interrupt signal to the session. */
  interrupt(sessionId: SessionId): Promise<void>;

  /**
   * Create a checkpoint capturing enough state to resume later.
   * Returns null if the provider does not support checkpoints.
   */
  checkpoint(sessionId: SessionId): Promise<Checkpoint | null>;

  /**
   * Resume a session from a checkpoint / resume token.
   * Returns the new session ID.
   */
  resume(token: ResumeToken, options: StartSessionOptions): Promise<SessionId>;

  /** Deliver an approval resolution back to the provider. */
  applyApprovalDecision(sessionId: SessionId, resolution: ApprovalResolution): Promise<void>;

  /** Return artifacts produced by the session. */
  fetchArtifacts(sessionId: SessionId): Promise<Artifact[]>;

  /** Gracefully stop the session. */
  terminate(sessionId: SessionId): Promise<void>;

  /** Return the provider's capability descriptor. */
  getCapabilities(): AgentCapability;

  /** Return true if the provider process/connection is healthy. */
  healthcheck(): Promise<boolean>;
}
