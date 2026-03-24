/**
 * Canonical domain model for AiRemoteCoder.
 *
 * These types are the internal contract used by the orchestrator, MCP server,
 * and provider adapters. Provider-specific quirks must not leak past an adapter
 * boundary — everything the rest of the system sees uses these shapes.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export type RunId = string;
export type SessionId = string;
export type ArtifactId = string;
export type EventId = number; // monotonically increasing integer (DB autoincrement)
export type CommandId = string;
export type ApprovalRequestId = string;
export type UserId = string;
export type ClientId = string;
export type McpTokenId = string;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type RunStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'done'
  | 'failed'
  | 'cancelled';

export type SessionStatus =
  | 'starting'
  | 'active'
  | 'idle'
  | 'reconnecting'
  | 'stopped'
  | 'failed';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'timed_out'
  | 'cancelled';

export type AdapterEventType =
  | 'stdout'
  | 'stderr'
  | 'marker'
  | 'info'
  | 'error'
  | 'assist'
  | 'tool_use'
  | 'prompt_waiting'
  | 'prompt_resolved'
  | 'approval_requested'
  | 'approval_resolved'
  | 'checkpoint_created'
  | 'session_started'
  | 'session_stopped'
  | 'artifact_available'
  | 'heartbeat';

/** All supported provider identifiers. */
export type ProviderName =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'rev'
  /** @deprecated Scheduled for removal in next major release */
  | 'legacy_wrapper';

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

/** A top-level unit of work assigned to an agent. */
export interface Run {
  id: RunId;
  clientId: ClientId | null;
  status: RunStatus;
  label: string | null;
  command: string | null;
  repoPath: string | null;
  repoName: string | null;
  workerType: string;
  provider: ProviderName | null;
  capabilityToken: string;
  claimedBy: string | null;
  claimedAt: number | null;
  waitingApproval: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
  tags: string[] | null;
}

/** An active or historical connection between a provider adapter and an agent process. */
export interface Session {
  id: SessionId;
  runId: RunId;
  provider: ProviderName;
  status: SessionStatus;
  workingDir: string;
  model: string | null;
  agentId: string | null;
  pid: number | null;
  createdAt: number;
  lastActiveAt: number;
  resumedFromSessionId: SessionId | null;
  checkpoint: Checkpoint | null;
}

/** A snapshot of session state sufficient to resume after a restart. */
export interface Checkpoint {
  sessionId: SessionId;
  runId: RunId;
  workingDir: string;
  lastSequence: number;
  stdinBuffer: string | null;
  environment: Record<string, string> | null;
  providerState: Record<string, unknown> | null; // provider-specific resume data
  createdAt: number;
}

/** A resume token passed to the provider to re-attach to a prior session. */
export interface ResumeToken {
  runId: RunId;
  previousSessionId: SessionId;
  checkpoint: Checkpoint;
  issuedAt: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * An immutable entry in the append-only event log.
 * id is monotonically increasing within a run (autoincrement from DB).
 */
export interface RunEvent {
  id: EventId;
  runId: RunId;
  type: AdapterEventType;
  data: string | null;
  stepId: string | null;
  sequence: number;
  timestamp: number;
}

/**
 * A cursor representing a position in the event stream for a subscriber.
 * Used for reconnect-safe replay.
 */
export interface EventCursor {
  runId: RunId;
  subscriberId: string;
  lastSeenEventId: EventId;
  lastSeenSequence: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export type ArtifactType = 'log' | 'text' | 'json' | 'diff' | 'patch' | 'markdown' | 'file';

export interface Artifact {
  id: ArtifactId;
  runId: RunId;
  name: string;
  type: ArtifactType;
  size: number;
  path: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/**
 * A request for human approval before an agent performs a potentially
 * dangerous or irreversible action.
 */
export interface ApprovalRequest {
  id: ApprovalRequestId;
  runId: RunId;
  sessionId: SessionId | null;
  description: string;
  /** Structured action payload — what the agent wants to do. */
  action: Record<string, unknown>;
  status: ApprovalStatus;
  requestedAt: number;
  resolvedAt: number | null;
  resolvedBy: UserId | null;
  /** Reason provided by the resolver (approve/deny rationale). */
  resolution: string | null;
  /** Auto-expires if not resolved within this many seconds (0 = never). */
  timeoutSeconds: number;
  /** Provider-specific correlation ID so the adapter can unblock on resolution. */
  providerCorrelationId: string | null;
}

export interface ApprovalDecision {
  requestId: ApprovalRequestId;
  decision: 'approved' | 'denied';
  resolvedBy: UserId;
  resolution: string | null;
  resolvedAt: number;
}

// ---------------------------------------------------------------------------
// Provider capabilities
// ---------------------------------------------------------------------------

/** Describes what a specific provider adapter supports. */
export interface AgentCapability {
  provider: ProviderName;
  supportsInteractiveInput: boolean;
  supportsResume: boolean;
  supportsCheckpoint: boolean;
  supportsApprovalGating: boolean;
  supportsToolUseEvents: boolean;
  supportsStreaming: boolean;
  supportsModelSelection: boolean;
  nativeMcp: boolean;  // true when provider natively speaks MCP (future)
  version: string;
}

// ---------------------------------------------------------------------------
// Auth / identity
// ---------------------------------------------------------------------------

export interface UserIdentity {
  id: UserId;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  source: 'session' | 'cloudflare' | 'wrapper' | 'mcp_token';
}

export interface DeviceIdentity {
  agentId: ClientId;
  displayName: string;
  version: string | null;
  capabilities: Record<string, unknown> | null;
}

/**
 * An MCP-specific API token granting scoped access to the MCP control plane.
 * Separate from UI session tokens.
 */
export interface McpToken {
  id: McpTokenId;
  tokenHash: string;         // SHA-256 of the raw token
  label: string;             // human-readable description
  userId: UserId;
  scopes: McpScope[];
  createdAt: number;
  expiresAt: number | null;  // null = never expires
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/**
 * Scopes control which MCP tools a token may invoke.
 * Principle of least privilege: grant only what the client needs.
 */
export type McpScope =
  | 'runs:read'
  | 'runs:write'
  | 'runs:cancel'
  | 'sessions:read'
  | 'sessions:write'
  | 'events:read'
  | 'artifacts:read'
  | 'artifacts:write'
  | 'approvals:read'
  | 'approvals:write'
  | 'approvals:decide'
  | 'admin';

// Convenience: all scopes granted to admin tokens
export const ALL_MCP_SCOPES: McpScope[] = [
  'runs:read', 'runs:write', 'runs:cancel',
  'sessions:read', 'sessions:write',
  'events:read',
  'artifacts:read', 'artifacts:write',
  'approvals:read', 'approvals:write', 'approvals:decide',
  'admin',
];

// ---------------------------------------------------------------------------
// Transport / channel
// ---------------------------------------------------------------------------

export type TransportStatus = 'connected' | 'reconnecting' | 'disconnected' | 'degraded';

export interface ChannelStatus {
  transport: TransportStatus;
  lastHeartbeatAt: number | null;
  reconnectCount: number;
  subscribedRunIds: RunId[];
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** A snapshot of operational policy applied to a run/session. */
export interface PolicySnapshot {
  allowlistedCommands: string[];
  approvalRequired: boolean;
  maxArtifactSizeBytes: number;
  secretRedactionEnabled: boolean;
  sandboxRootEnforced: boolean;
}
