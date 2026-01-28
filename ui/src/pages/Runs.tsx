import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
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

const workerTypeOptions: FilterOption[] = [
  { value: 'all', label: 'All Workers' },
  { value: 'claude', label: 'Claude' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'ollama-launch', label: 'Ollama Launch (Claude)' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'rev', label: 'Rev' },
];

const ollamaModels = [
  { value: 'codellama:7b', label: 'CodeLlama 7B' },
  { value: 'codellama:13b', label: 'CodeLlama 13B' },
  { value: 'codellama:34b', label: 'CodeLlama 34B' },
  { value: 'deepseek-coder:6.7b', label: 'DeepSeek Coder 6.7B' },
  { value: 'mistral:7b', label: 'Mistral 7B' },
  { value: 'custom', label: 'Custom...' },
];

const geminiModels = [
  { value: 'gemini-pro', label: 'Gemini Pro' },
  { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
  { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
  { value: 'custom', label: 'Custom...' },
];

export function Runs({ user }: Props) {
  const { addToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  // State
  const [runs, setRuns] = useState<Run[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Create run modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createWorkerType, setCreateWorkerType] = useState('claude');
  const [createModel, setCreateModel] = useState('');
  const [createCustomModel, setCreateCustomModel] = useState('');
  const [createCommand, setCreateCommand] = useState('');
  const [createAutonomous, setCreateAutonomous] = useState(true);
  const [createLoading, setCreateLoading] = useState(false);

  // Credentials display state
  const [showCredentialsModal, setShowCredentialsModal] = useState(false);
  const [credentials, setCredentials] = useState<{ id: string; token: string; command: string } | null>(null);

  // Filters from URL
  const status = searchParams.get('status') || 'all';
  const clientId = searchParams.get('clientId') || '';
  const search = searchParams.get('search') || '';
  const waitingApproval = searchParams.get('waitingApproval') === 'true';
  const workerType = searchParams.get('workerType') || 'all';

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
  }, [status, clientId, search, waitingApproval, runs.length, addToast]);

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

  // Initial fetch
  useEffect(() => {
    fetchRuns();
    fetchClients();
  }, [status, clientId, search, waitingApproval, workerType]);

  // Auto-refresh
  useEffect(() => {
    const interval = setInterval(() => {
      fetchRuns();
    }, 15000);
    return () => clearInterval(interval);
  }, [fetchRuns]);

  // Reset filters
  const resetFilters = () => {
    setSearchParams(new URLSearchParams());
    setSelectedRuns(new Set());
  };

  // Check if any filters are active
  const hasActiveFilters = status !== 'all' || !!clientId || !!search || waitingApproval || workerType !== 'all';

  // Client filter options
  const clientOptions: FilterOption[] = [
    { value: '', label: 'All Clients' },
    ...clients.map(c => ({ value: c.id, label: c.display_name })),
  ];

  // Create new run
  const handleCreateRun = async () => {
    setCreateLoading(true);
    try {
      let model = createModel;
      if (model === 'custom') {
        model = createCustomModel;
      }

      const requestBody: any = {
        workerType: createWorkerType,
        autonomous: createAutonomous,
      };

      if (createCommand.trim()) {
        requestBody.command = createCommand.trim();
      }

      if (model && (createWorkerType === 'ollama' || createWorkerType === 'gemini')) {
        requestBody.model = model;
      }

      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (res.ok) {
        const data = await res.json();
        addToast('success', `Run ${data.id} created`);

        // Show credentials modal
        const cmd = `ai-runner start --run-id ${data.id} --token ${data.capabilityToken}` +
          ` --worker-type ${createWorkerType}` +
          (model ? ` --model "${model}"` : '') +
          (createCommand ? ` --cmd "${createCommand}"` : '');

        setCredentials({
          id: data.id,
          token: data.capabilityToken,
          command: cmd
        });
        setShowCredentialsModal(true);

        fetchRuns();
        setShowCreateModal(false);
        // Reset form
        setCreateWorkerType('claude');
        setCreateModel('');
        setCreateCustomModel('');
        setCreateCommand('');
        setCreateAutonomous(true);
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

  const supportsModelSelection = createWorkerType === 'ollama' || createWorkerType === 'ollama-launch' || createWorkerType === 'gemini';
  const availableModels = createWorkerType === 'ollama' || createWorkerType === 'ollama-launch' ? ollamaModels :
                         createWorkerType === 'gemini' ? geminiModels : [];

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
                disabled={createLoading}
              >
                {createLoading ? 'Creating...' : 'Create Run'}
              </button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Worker Type Selection */}
            <div>
              <label className="form-label">Worker Type</label>
              <select
                value={createWorkerType}
                onChange={(e) => {
                  setCreateWorkerType(e.target.value);
                  setCreateModel('');
                  setCreateCustomModel('');
                }}
                className="form-input"
                style={{ cursor: 'pointer' }}
              >
                <option value="claude">Claude (Anthropic)</option>
                <option value="ollama">Ollama (Local LLM)</option>
                <option value="ollama-launch">Ollama Launch (Claude)</option>
                <option value="codex">Codex CLI</option>
                <option value="gemini">Gemini CLI</option>
                <option value="rev">Rev</option>
              </select>
            </div>

            {/* Model Selection (for Ollama/Gemini) */}
            {supportsModelSelection && (
              <div>
                <label className="form-label">Model</label>
                <select
                  value={createModel}
                  onChange={(e) => setCreateModel(e.target.value)}
                  className="form-input"
                  style={{ cursor: 'pointer' }}
                >
                  <option value="">Default Model</option>
                  {availableModels.map((model) => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                    </option>
                  ))}
                </select>
                {createModel === 'custom' && (
                  <input
                    type="text"
                    value={createCustomModel}
                    onChange={(e) => setCreateCustomModel(e.target.value)}
                    placeholder="Enter custom model name..."
                    className="form-input"
                    style={{ marginTop: '8px' }}
                  />
                )}
              </div>
            )}

            {/* Command/Prompt */}
            <div>
              <label className="form-label">Command / Prompt (optional)</label>
              <input
                type="text"
                value={createCommand}
                onChange={(e) => setCreateCommand(e.target.value)}
                placeholder="Enter initial command or prompt..."
                className="form-input"
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
              <strong>Tip:</strong> After creating the run, you'll see your credentials and the command to start
              the ai-runner worker from your terminal. You can copy each piece individually or copy the entire command.
            </div>
          </div>
        </Modal>
      )}

      {/* Credentials Modal */}
      {showCredentialsModal && credentials && (
        <Modal
          open={showCredentialsModal}
          onClose={() => setShowCredentialsModal(false)}
          title="Run Created Successfully! 🎉"
          footer={
            <button
              className="btn btn-primary"
              onClick={() => setShowCredentialsModal(false)}
            >
              Done
            </button>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
              Your run has been created. Here are your credentials and the command to start the worker:
            </p>

            {/* Run ID */}
            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px', color: 'var(--text-secondary)' }}>
                Run ID:
              </label>
              <div
                style={{
                  display: 'flex',
                  gap: '8px',
                  background: 'var(--bg-tertiary)',
                  padding: '12px',
                  borderRadius: '6px',
                  fontFamily: 'monospace',
                  fontSize: '14px',
                }}
              >
                <code style={{ flex: 1, color: 'var(--accent-blue)', wordBreak: 'break-all' }}>
                  {credentials.id}
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(credentials.id);
                    addToast('success', 'Run ID copied to clipboard');
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--accent-blue)',
                    cursor: 'pointer',
                    fontSize: '12px',
                    padding: '0 8px',
                  }}
                >
                  Copy
                </button>
              </div>
            </div>

            {/* Token */}
            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px', color: 'var(--text-secondary)' }}>
                Capability Token:
              </label>
              <div
                style={{
                  display: 'flex',
                  gap: '8px',
                  background: 'var(--bg-tertiary)',
                  padding: '12px',
                  borderRadius: '6px',
                  fontFamily: 'monospace',
                  fontSize: '14px',
                }}
              >
                <code style={{ flex: 1, color: 'var(--accent-green)', wordBreak: 'break-all' }}>
                  {credentials.token}
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(credentials.token);
                    addToast('success', 'Token copied to clipboard');
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--accent-blue)',
                    cursor: 'pointer',
                    fontSize: '12px',
                    padding: '0 8px',
                  }}
                >
                  Copy
                </button>
              </div>
            </div>

            {/* Start Command */}
            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px', color: 'var(--text-secondary)' }}>
                Start Command:
              </label>
              <div
                style={{
                  display: 'flex',
                  gap: '8px',
                  background: 'var(--bg-tertiary)',
                  padding: '12px',
                  borderRadius: '6px',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  overflow: 'auto',
                }}
              >
                <code style={{ flex: 1, color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                  {credentials.command}
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(credentials.command);
                    addToast('success', 'Command copied to clipboard');
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--accent-blue)',
                    cursor: 'pointer',
                    fontSize: '12px',
                    padding: '0 8px',
                    flexShrink: 0,
                  }}
                >
                  Copy
                </button>
              </div>
            </div>

            {/* Info Box */}
            <div
              style={{
                padding: '12px',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                fontSize: '13px',
                color: 'var(--text-secondary)',
              }}
            >
              <strong>💡 Next Steps:</strong>
              <ol style={{ marginTop: '8px', paddingLeft: '20px', margin: '8px 0 0 0' }}>
                <li>Copy the token and run ID above</li>
                <li>Open your terminal/command prompt</li>
                <li>Paste and run the start command</li>
                <li>The worker will connect to this gateway</li>
              </ol>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default Runs;
