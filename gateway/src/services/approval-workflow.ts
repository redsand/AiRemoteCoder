import { nanoid } from 'nanoid';

export interface CreateApprovalRequestInput {
  runId: string;
  description: string;
  action: Record<string, unknown>;
  timeoutSeconds: number;
  sessionId?: string | null;
  providerCorrelationId?: string | null;
}

export interface ResolveApprovalRequestInput {
  approvalRequestId: string;
  decision: 'approved' | 'denied';
  resolvedBy: string;
  resolution: string | null;
}

export interface ApprovalWorkflowDatabase {
  transaction: any;
  prepare: any;
}

export interface CreatedApprovalRequest {
  approvalRequestId: string;
  runId: string;
}

export interface ResolvedApprovalRequest {
  requestId: string;
  runId: string;
  decision: 'approved' | 'denied';
  currentStatus: 'pending' | 'approved' | 'denied' | 'timed_out' | 'cancelled';
  resolvedBy: string;
  resolution: string | null;
  providerCorrelationId: string | null;
  commandId: string;
  wasPending: boolean;
  runResumed: boolean;
}

export function createApprovalRequest(
  db: ApprovalWorkflowDatabase,
  input: CreateApprovalRequestInput
): CreatedApprovalRequest {
  return db.transaction(() => {
    const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(input.runId) as { id: string } | undefined;
    if (!run) {
      throw new Error(`Run not found: ${input.runId}`);
    }

    const approvalRequestId = nanoid();
    db.prepare(`
      INSERT INTO approval_requests
        (id, run_id, session_id, description, action, status, requested_at, timeout_seconds, provider_correlation_id)
      VALUES (?, ?, ?, ?, ?, 'pending', unixepoch(), ?, ?)
    `).run(
      approvalRequestId,
      input.runId,
      input.sessionId ?? null,
      input.description,
      JSON.stringify(input.action),
      input.timeoutSeconds,
      input.providerCorrelationId ?? null
    );

    db.prepare(
      "UPDATE runs SET waiting_approval = 1, status = 'waiting_approval' WHERE id = ?"
    ).run(input.runId);

    return { approvalRequestId, runId: input.runId };
  })() as CreatedApprovalRequest;
}

export function resolveApprovalRequest(
  db: ApprovalWorkflowDatabase,
  input: ResolveApprovalRequestInput
): ResolvedApprovalRequest {
  return db.transaction(() => {
    const req = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(input.approvalRequestId) as
      | {
          id: string;
          run_id: string;
          status: string;
          provider_correlation_id: string | null;
        }
      | undefined;

    if (!req) {
      throw new Error(`Approval request not found: ${input.approvalRequestId}`);
    }

    if (req.status !== 'pending') {
      return {
        requestId: req.id,
        runId: req.run_id,
        decision: input.decision,
        currentStatus: req.status as ResolvedApprovalRequest['currentStatus'],
        resolvedBy: input.resolvedBy,
        resolution: input.resolution,
        providerCorrelationId: req.provider_correlation_id,
        commandId: '',
        wasPending: false,
        runResumed: false,
      };
    }

    db.prepare(`
      UPDATE approval_requests
      SET status = ?, resolved_at = unixepoch(), resolved_by = ?, resolution = ?
      WHERE id = ?
    `).run(input.decision, input.resolvedBy, input.resolution, input.approvalRequestId);

    const pendingCount = db.prepare(
      "SELECT COUNT(*) as c FROM approval_requests WHERE run_id = ? AND status = 'pending'"
    ).get(req.run_id) as { c: number };

    const runResumed = pendingCount.c === 0;
    if (runResumed) {
      db.prepare(
        "UPDATE runs SET waiting_approval = 0, status = 'running' WHERE id = ? AND status = 'waiting_approval'"
      ).run(req.run_id);
    }

    const commandId = nanoid();
    db.prepare(`
      INSERT INTO commands (id, run_id, command, arguments, status, created_at)
      VALUES (?, ?, '__APPROVAL_RESOLVED__', ?, 'pending', unixepoch())
    `).run(
      commandId,
      req.run_id,
      JSON.stringify({
        requestId: req.id,
        decision: input.decision,
        providerCorrelationId: req.provider_correlation_id,
      })
    );

    return {
      requestId: req.id,
      runId: req.run_id,
      decision: input.decision,
      currentStatus: input.decision,
      resolvedBy: input.resolvedBy,
      resolution: input.resolution,
      providerCorrelationId: req.provider_correlation_id,
      commandId,
      wasPending: true,
      runResumed,
    };
  })() as ResolvedApprovalRequest;
}
