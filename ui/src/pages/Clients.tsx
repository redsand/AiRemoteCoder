import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ClientCard,
  type Client,
  FilterBar,
  FilterSelect,
  SearchInput,
  type FilterOption,
  useToast,
} from '../components/ui';

interface ClientsResponse {
  clients: Client[];
  total: number;
  limit: number;
  offset: number;
}

interface Props {
  user: { id: string; username: string; role: string } | null;
}

const statusOptions: FilterOption[] = [
  { value: 'all', label: 'All Statuses' },
  { value: 'online', label: 'Online' },
  { value: 'degraded', label: 'Degraded' },
  { value: 'offline', label: 'Offline' },
];

export function Clients({ user: _user }: Props) {
  const { addToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  // State
  const [clients, setClients] = useState<Client[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Filters from URL
  const status = searchParams.get('status') || 'all';
  const search = searchParams.get('search') || '';

  // Update URL params
  const updateFilter = useCallback((key: string, value: string) => {
    const newParams = new URLSearchParams(searchParams);
    if (value && value !== 'all') {
      newParams.set(key, value);
    } else {
      newParams.delete(key);
    }
    setSearchParams(newParams);
  }, [searchParams, setSearchParams]);

  // Fetch clients
  const fetchClients = useCallback(async (append = false) => {
    const offset = append ? clients.length : 0;
    const params = new URLSearchParams();

    if (status !== 'all') params.set('status', status);
    if (search) params.set('search', search);
    params.set('limit', '20');
    params.set('offset', String(offset));

    try {
      append ? setLoadingMore(true) : setLoading(true);
      const res = await fetch(`/api/clients?${params}`);
      if (res.ok) {
        const data: ClientsResponse = await res.json();
        if (append) {
          setClients(prev => [...prev, ...data.clients]);
        } else {
          setClients(data.clients);
        }
        setTotal(data.total);
      }
    } catch (err) {
      console.error('Failed to fetch clients:', err);
      addToast('error', 'Failed to load clients');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [status, search, clients.length, addToast]);

  // Initial fetch
  useEffect(() => {
    fetchClients();
  }, [status, search]);

  // Auto-refresh
  useEffect(() => {
    const interval = setInterval(() => {
      fetchClients();
    }, 15000);
    return () => clearInterval(interval);
  }, [fetchClients]);

  // Reset filters
  const resetFilters = () => {
    setSearchParams(new URLSearchParams());
  };

  // Check if any filters are active
  const hasActiveFilters = status !== 'all' || !!search;

  // Load more
  const loadMore = () => {
    fetchClients(true);
  };

  // Stats
  const onlineCount = clients.filter(c => c.status === 'online').length;
  const offlineCount = clients.filter(c => c.status === 'offline').length;

  return (
    <div className="clients-page">
      {/* Header */}
      <div className="page-header">
        <h2 className="page-title">Clients</h2>
        <div
          style={{
            display: 'flex',
            gap: '12px',
            fontSize: '13px',
            color: 'var(--text-secondary)',
          }}
        >
          <span style={{ color: 'var(--accent-green)' }}>
            \u25CF {onlineCount} online
          </span>
          <span style={{ color: 'var(--accent-red)' }}>
            \u25CB {offlineCount} offline
          </span>
        </div>
      </div>

      {/* Filters */}
      <FilterBar hasActiveFilters={hasActiveFilters} onReset={resetFilters}>
        <SearchInput
          value={search}
          onChange={(val) => updateFilter('search', val)}
          placeholder="Search clients..."
        />
        <FilterSelect
          label="Status"
          value={status}
          options={statusOptions}
          onChange={(val) => updateFilter('status', val)}
        />
      </FilterBar>

      {/* Results count */}
      <div
        style={{
          fontSize: '13px',
          color: 'var(--text-muted)',
          marginBottom: '12px',
        }}
      >
        {loading ? 'Loading...' : `${total} clients found`}
      </div>

      {/* Clients list */}
      {loading ? (
        <div className="loading">
          <div className="spinner" />
        </div>
      ) : clients.length === 0 ? (
        <div className="empty-state">
          <h2>No clients found</h2>
          <p>
            {hasActiveFilters
              ? 'Try adjusting your filters.'
              : 'Clients will appear here when they connect to the gateway.'}
          </p>
          <div
            style={{
              marginTop: '16px',
              padding: '16px',
              background: 'var(--bg-secondary)',
              borderRadius: '8px',
              fontSize: '13px',
              color: 'var(--text-secondary)',
            }}
          >
            <p style={{ marginBottom: '8px' }}>
              <strong>To connect a client, run:</strong>
            </p>
            <code style={{ display: 'block', padding: '8px', background: 'var(--bg-tertiary)', borderRadius: '4px' }}>
              claude-runner start --run-id [id] --token [token]
            </code>
          </div>
        </div>
      ) : (
        <>
          <div className="client-list">
            {clients.map((client) => (
              <ClientCard key={client.id} client={client} />
            ))}
          </div>

          {/* Load more */}
          {clients.length < total && (
            <div style={{ textAlign: 'center', marginTop: '16px' }}>
              <button
                className="btn"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading...' : `Load More (${clients.length}/${total})`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default Clients;
