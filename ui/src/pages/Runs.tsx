import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  RunCard,
  type Run,
  FilterBar,
  FilterSelect,
  SearchInput,
  type FilterOption,
  Modal,
  ConfirmModal,
  useToast,
} from '../components/ui';
import type { McpActiveSession } from '../features/mcp/types';
import { isMcpSessionFresh } from '../features/mcp/run-worker-options';

interface RunsResponse {
  runs: Run[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

interface Client {
  id: string;
  display_name: string;
  agent_id: string;
}

interface Props {
  user: { id: string; username: string; role: string } | null;
}

const statusOptions: FilterOption[] = [
  { value: 'all', label: 'All Statuses' },
  { value: 'running', label: 'Running' },
  { value: 'pending', label: 'Pending' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
];

const claimOptions: FilterOption[] = [
  { value: 'all', label: 'All Claims' },
  { value: 'claimed', label: 'Claimed' },
  { value: 'unclaimed', label: 'Unclaimed' },
];

const workerTypeOptions: FilterOption[] = [
  { value: 'all', label: 'All Workers' },
  { value: 'claude', label: 'Claude' },
  { value: 'ollama-launch', label: 'Ollama Launch' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'rev', label: 'Rev' },
  { value: 'vnc', label: 'VNC (Remote Desktop)' },
  { value: 'hands-on', label: 'Hands-On' },
];

export function Runs({ user }: Props) {
  const { addToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  // State
  const [runs, setRuns] = useState<Run[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [activeMcpSessions, setActiveMcpSessions] = useState<McpActiveSession[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Create run modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createHostSessionId, setCreateHostSessionId] = useState('');
  const [createMode, setCreateMode] = useState<'agent' | 'vnc' | 'hands-on'>('agent');
  const [createCommand, setCreateCommand] = useState('');
  const [createAutonomous, setCreateAutonomous] = useState(true);
  const [createLoading, setCreateLoading] = useState(false);

  const navigate = useNavigate();

  // Filters from URL
  const status = searchParams.get('status') || 'all';
  const clientId = searchParams.get('clientId') || '';
  const search = searchParams.get('search') || '';
  const waitingApproval = searchParams.get('waitingApproval') === 'true';
  const workerType = searchParams.get('workerType') || 'all';
  const claim = searchParams.get('claim') || 'all';

  // Bulk actions
  const [selectedRuns, setSelectedRuns] = useState<Set<string>>(new Set());
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const canOperate = user?.role === 'admin' || user?.role === 'operator';

  // Update URL params
  const updateFilter = useCallback((key: string, value: string) => {
    const newParams = new URLSearchParams(searchParams);
    if (value && value !== 'all') {
      newParams.set(key, value);
    } else {
      newParams.delete(key);
    }
    newParams.delete('offset'); // Reset pagination on filter change
    setSearchParams(newParams);
  }, [searchParams, setSearchParams]);

  // Fetch runs
  const fetchRuns = useCallback(async (append = false) => {
    const offset = append ? runs.length : 0;
    const params = new URLSearchParams();

    if (status !== 'all') params.set('status', status);
    if (clientId) params.set('clientId', clientId);
    if (search) params.set('search', search);
    if (waitingApproval) params.set('waitingApproval', 'true');
    if (workerType !== 'all') params.set('workerType', workerType);
    if (claim !== 'all') params.set('claim', claim);
    params.set('limit', '20');
    params.set('offset', String(offset));

    try {
      append ? setLoadingMore(true) : setLoading(true);
      const res = await fetch(`/api/runs?${params}`);
      if (res.ok) {
        const data: RunsResponse = await res.json();
        if (append) {
          setRuns(prev => [...prev, ...data.runs]);
        } else {
          setRuns(data.runs);
        }
        setTotal(data.total);
      }
    } catch (err) {
      console.error('Failed to fetch runs:', err);
      addToast('error', 'Failed to load runs');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [status, clientId, search, waitingApproval, workerType, claim, runs.length, addToast]);

  // Fetch clients for filter dropdown
  const fetchClients = useCallback(async () => {
    try {
      const res = await fetch('/api/clients?limit=100');
      if (res.ok) {
        const data = await res.json();
        setClients(data.clients || []);
      }
    } catch (err) {
      // Ignore
    }
  }, []);

  const fetchMcpSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/mcp/sessions');
      if (res.ok) {
        const data = await res.json();
        setActiveMcpSessions(Array.isArray(data.sessions) ? data.sessions : []);
      }
    } catch {
      // ignore
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchRuns();
    fetchClients();
    fetchMcpSessions();
  }, [status, clientId, search, waitingApproval, workerType, claim]);

  // Auto-refresh
  useEffect(() => {
    const interval = setInterval(() => {
      fetchRuns();
    }, 15000);
    return () => clearInterval(interval);
  }, [fetchRuns]);

  // Auto-refresh clients when new workers connect
  useEffect(() => {
    const interval = setInterval(() => {
      fetchClients();
      fetchMcpSessions();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchClients, fetchMcpSessions]);

  useEffect(() => {
    if (activeMcpSessions.length === 0) {
      setCreateHostSessionId('');
      return;
    }
    if (!activeMcpSessions.some((session) => session.id === createHostSessionId)) {
      setCreateHostSessionId(activeMcpSessions[0].id);
    }
  }, [activeMcpSessions, createHostSessionId]);

  // Reset filters
  const resetFilters = () => {
    setSearchParams(new URLSearchParams());
    setSelectedRuns(new Set());
  };

  // Check if any filters are active
  const hasActiveFilters = status !== 'all' || !!clientId || !!search || waitingApproval || workerType !== 'all' || claim !== 'all';

  // Client filter options
  const clientOptions: FilterOption[] = [
    { value: '', label: 'All Clients' },
    ...clients.map(c => ({ value: c.id, label: c.display_name })),
  ];

  // Create new run
  const handleCreateRun = async () => {
    const selectedHost = activeMcpSessions.find((session) => session.id === createHostSessionId);
    if (!selectedHost) {
      addToast('error', 'Select a connected MCP host first');
      return;
    }
    const selectedHostFresh = isMcpSessionFresh(selectedHost);
    const resolvedWorkerType = createMode === 'agent' ? selectedHost.provider : createMode;
    if (!resolvedWorkerType) {
      addToast('error', 'Selected host does not expose an agent provider');
      return;
    }
    if ((createMode === 'vnc' || createMode === 'hands-on') && !selectedHostFresh) {
      addToast('error', 'Selected MCP host is stale. Wait for reconnect before using VNC or Hands-On.');
      return;
    }

    setCreateLoading(true);
    try {
      const requestBody: any = {
        workerType: resolvedWorkerType,
        autonomous: createAutonomous,
        metadata: {
          mcpSessionId: selectedHost.id,
          mcpProvider: selectedHost.provider ?? null,
          mcpMode: createMode,
          mcpConnectedUser: selectedHost.user.username,
        },
      };

      if (createCommand.trim()) {
        requestBody.command = createCommand.trim();
      }

      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (res.ok) {
        const data = await res.json();
        addToast('success', `Run ${data.id} created`);

        fetchRuns();
        setShowCreateModal(false);
        // Reset form
        setCreateHostSessionId(activeMcpSessions[0]?.id ?? '');
        setCreateMode('agent');
        setCreateCommand('');
        setCreateAutonomous(true);
        navigate(`/runs/${data.id}`);
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to create run');
      }
    } catch (err) {
      addToast('error', 'Failed to create run');
    } finally {
      setCreateLoading(false);
    }
  };

  const selectedHost = activeMcpSessions.find((session) => session.id === createHostSessionId);
  const selectedProviderLabel = selectedHost?.provider ? selectedHost.provider.toUpperCase() : 'Unavailable';
  const selectedHostFresh = isMcpSessionFresh(selectedHost);
  const canUseManualModes = Boolean(selectedHost && selectedHostFresh);

  useEffect(() => {
    if ((createMode === 'vnc' || createMode === 'hands-on') && !canUseManualModes) {
      setCreateMode('agent');
    }
  }, [canUseManualModes, createMode]);

  // Toggle run selection
  const toggleRunSelection = (runId: string) => {
    setSelectedRuns(prev => {
      const next = new Set(prev);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  };

  // Stop selected runs
  const stopSelectedRuns = async () => {
    setActionLoading(true);
    let succeeded = 0;
    let failed = 0;

    for (const runId of selectedRuns) {
      try {
        const res = await fetch(`/api/runs/${runId}/stop`, { method: 'POST' });
        if (res.ok) {
          succeeded++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    setActionLoading(false);
    setShowStopConfirm(false);
    setSelectedRuns(new Set());

    if (succeeded > 0) {
      addToast('success', `Stopped ${succeeded} run(s)`);
    }
    if (failed > 0) {
      addToast('error', `Failed to stop ${failed} run(s)`);
    }

    fetchRuns();
  };

  // Load more
  const loadMore = () => {
    fetchRuns(true);
  };

  return (
    <div className="runs-page">
      {/* Header with actions */}
      <div className="page-header">
        <h2 className="page-title">Runs</h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {canOperate && selectedRuns.size > 0 && (
            <button
              className="btn btn-danger btn-sm"
              onClick={() => setShowStopConfirm(true)}
            >
              Stop {selectedRuns.size} selected
            </button>
          )}
          {canOperate && (
            <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
              New Run
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <FilterBar hasActiveFilters={hasActiveFilters} onReset={resetFilters}>
        <SearchInput
          value={search}
          onChange={(val) => updateFilter('search', val)}
          placeholder="Search runs..."
        />
        <FilterSelect
          label="Status"
          value={status}
          options={statusOptions}
          onChange={(val) => updateFilter('status', val)}
        />
        <FilterSelect
          label="Worker"
          value={workerType}
          options={workerTypeOptions}
          onChange={(val) => updateFilter('workerType', val)}
        />
        <FilterSelect
          label="Claim"
          value={claim}
          options={claimOptions}
          onChange={(val) => updateFilter('claim', val)}
        />
        <FilterSelect
          label="Client"
          value={clientId}
          options={clientOptions}
          onChange={(val) => updateFilter('clientId', val)}
        />
        {waitingApproval && (
          <div
            style={{
              padding: '8px 12px',
              background: 'rgba(163, 113, 247, 0.15)',
              borderRadius: '6px',
              fontSize: '12px',
              color: 'var(--accent-purple)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            Showing runs waiting approval
            <button
              onClick={() => updateFilter('waitingApproval', '')}
              style={{
                background: 'none',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                padding: '2px',
              }}
            >
              ×
            </button>
          </div>
        )}
      </FilterBar>

      {/* Results count */}
      <div
        style={{
          fontSize: '13px',
          color: 'var(--text-muted)',
          marginBottom: '12px',
        }}
      >
        {loading ? 'Loading...' : `${total} runs found`}
      </div>

      {/* Runs list */}
      {loading ? (
        <div className="loading">
          <div className="spinner" />
        </div>
      ) : runs.length === 0 ? (
        <div className="empty-state">
          <h2>No runs found</h2>
          <p>
            {hasActiveFilters
              ? 'Try adjusting your filters.'
              : 'Create a new run to get started.'}
          </p>
        </div>
      ) : (
        <>
          <div className="run-list">
            {runs.map((run) => (
              <div
                key={run.id}
                style={{
                  display: 'flex',
                  gap: '12px',
                  alignItems: 'flex-start',
                }}
              >
                {canOperate && run.status === 'running' && (
                  <input
                    type="checkbox"
                    checked={selectedRuns.has(run.id)}
                    onChange={() => toggleRunSelection(run.id)}
                    style={{
                      marginTop: '18px',
                      width: '18px',
                      height: '18px',
                      accentColor: 'var(--accent-blue)',
                    }}
                    aria-label={`Select run ${run.id}`}
                  />
                )}
                <div style={{ flex: 1 }}>
                  <RunCard run={run} />
                </div>
              </div>
            ))}
          </div>

          {/* Load more */}
          {runs.length < total && (
            <div style={{ textAlign: 'center', marginTop: '16px' }}>
              <button
                className="btn"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading...' : `Load More (${runs.length}/${total})`}
              </button>
            </div>
          )}
        </>
      )}

      {/* Stop confirmation modal */}
      <ConfirmModal
        open={showStopConfirm}
        onClose={() => setShowStopConfirm(false)}
        onConfirm={stopSelectedRuns}
        title="Stop Selected Runs"
        message={`Are you sure you want to stop ${selectedRuns.size} run(s)? This will send a stop signal to each running process.`}
        confirmText="Stop Runs"
        danger
        loading={actionLoading}
      />

      {/* Create Run Modal */}
      {canOperate && (
        <Modal
          open={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          title="Create New Run"
          footer={
            <>
              <button className="btn" onClick={() => setShowCreateModal(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCreateRun}
                disabled={createLoading || !createHostSessionId}
              >
                {createLoading ? 'Creating...' : 'Create Run'}
              </button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Connected Host Selection */}
            <div>
              <label className="form-label">Connected Host (MCP Session)</label>
              <select
                value={createHostSessionId}
                onChange={(e) => setCreateHostSessionId(e.target.value)}
                className="form-input"
                style={{ cursor: 'pointer' }}
                disabled={activeMcpSessions.length === 0}
              >
                {activeMcpSessions.length === 0 ? (
                  <option value="">No connected MCP hosts</option>
                ) : (
                  activeMcpSessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {(session.provider ?? 'unknown-agent').toUpperCase()} · {session.user.username} · {session.id.slice(0, 8)}
                    </option>
                  ))
                )}
              </select>
              {activeMcpSessions.length === 0 && (
                <div className="text-muted" style={{ marginTop: '8px', fontSize: '12px' }}>
                  Connect Codex/Claude/Gemini/OpenCode/Zenflow/Rev to MCP first from the MCP page.
                </div>
              )}
            </div>

            {/* Run Mode Selection */}
            <div>
              <label className="form-label">Execution Mode</label>
              <select
                value={createMode}
                onChange={(e) => setCreateMode(e.target.value as 'agent' | 'vnc' | 'hands-on')}
                className="form-input"
                style={{ cursor: 'pointer' }}
                disabled={!createHostSessionId}
              >
                <option value="agent">AI Coding Agent ({selectedProviderLabel})</option>
                <option value="vnc" disabled={!canUseManualModes}>VNC (Remote Desktop)</option>
                <option value="hands-on" disabled={!canUseManualModes}>Hands-On (Command Line)</option>
              </select>
              {createHostSessionId && (
                <div className="text-muted" style={{ marginTop: '8px', fontSize: '12px' }}>
                  Worker type: {createMode === 'agent'
                    ? (selectedHost?.provider ?? 'unavailable')
                    : createMode}
                </div>
              )}
              {createHostSessionId && !selectedHostFresh && (
                <div className="text-muted" style={{ marginTop: '6px', fontSize: '12px' }}>
                  Host heartbeat is stale. VNC and Hands-On require a fresh MCP connection.
                </div>
              )}
            </div>

            {/* Command/Prompt */}
            <div>
              <label className="form-label">Command / Prompt {createAutonomous ? '(disabled in autonomous mode)' : '(optional)'}</label>
              <input
                type="text"
                value={createCommand}
                onChange={(e) => setCreateCommand(e.target.value)}
                placeholder={createAutonomous ? "Disabled when autonomous mode is enabled" : "Enter initial command or prompt..."}
                className="form-input"
                disabled={createAutonomous}
              />
            </div>

            {/* Autonomous Mode Toggle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                id="autonomous"
                checked={createAutonomous}
                onChange={(e) => setCreateAutonomous(e.target.checked)}
                style={{ width: '18px', height: '18px', accentColor: 'var(--accent-blue)' }}
              />
              <label htmlFor="autonomous" style={{ cursor: 'pointer' }}>
                Autonomous mode (no prompt required)
              </label>
            </div>

            {/* Info Box */}
            <div
              style={{
                padding: '12px',
                background: 'var(--bg-tertiary)',
                borderRadius: '6px',
                fontSize: '13px',
                color: 'var(--text-secondary)',
              }}
            >
              <strong>Tip:</strong> Pick a connected host first, then choose Agent/VNC/Hands-On over that same MCP connection.
            </div>
          </div>
        </Modal>
      )}

    </div>
  );
}

export default Runs;
