import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  RunCard,
  type Run,
  FilterBar,
  FilterSelect,
  SearchInput,
  type FilterOption,
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

export function Runs({ user }: Props) {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  // State
  const [runs, setRuns] = useState<Run[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Filters from URL
  const status = searchParams.get('status') || 'all';
  const clientId = searchParams.get('clientId') || '';
  const search = searchParams.get('search') || '';
  const waitingApproval = searchParams.get('waitingApproval') === 'true';

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
  }, [status, clientId, search, waitingApproval]);

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
  const hasActiveFilters = status !== 'all' || !!clientId || !!search || waitingApproval;

  // Client filter options
  const clientOptions: FilterOption[] = [
    { value: '', label: 'All Clients' },
    ...clients.map(c => ({ value: c.id, label: c.display_name })),
  ];

  // Create new run
  const createRun = async () => {
    const command = prompt('Enter Claude command (optional):');
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command || undefined }),
      });
      if (res.ok) {
        const data = await res.json();
        addToast('success', `Run ${data.id} created`);

        // Show command to copy
        const cmd = `claude-runner start --run-id ${data.id} --token ${data.capabilityToken}${
          command ? ` --cmd "${command}"` : ''
        }`;
        await navigator.clipboard.writeText(cmd);
        addToast('info', 'Start command copied to clipboard');

        fetchRuns();
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to create run');
      }
    } catch (err) {
      addToast('error', 'Failed to create run');
    }
  };

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
            <button className="btn btn-primary" onClick={createRun}>
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
              \u00D7
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
    </div>
  );
}

export default Runs;
