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

type OSType = 'windows' | 'macos' | 'linux';

interface DeploymentInstructions {
  title: string;
  steps: string[];
  commands: string[];
}

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

const deploymentInstructions: Record<OSType, DeploymentInstructions> = {
  windows: {
    title: 'Windows Deployment',
    steps: [
      'Download and install Node.js 20+ from nodejs.org',
      'Clone or download the AI Remote Coder repository',
      'Open PowerShell and navigate to the project directory',
      'Run the setup script to start the gateway',
      'The UI will be available at https://localhost:3100',
      'Create a run from the UI to get the run-id and token',
      'Connect a client using the provided run-id and token',
    ],
    commands: [
      'cd C:\\path\\to\\ai-remote-coder',
      '.\\run.ps1',
      '.\\wrapper\\ai-runner start --run-id <id> --token <token>',
    ],
  },
  macos: {
    title: 'macOS Deployment',
    steps: [
      'Install Node.js 20+ using Homebrew or from nodejs.org',
      'Clone the repository: git clone <repo-url>',
      'Navigate to the project directory',
      'Make the run script executable: chmod +x ./run.sh',
      'Run the setup script: ./run.sh',
      'Access the UI at https://localhost:3100',
      'Create a run from the UI to get credentials',
      'Connect a client with the run-id and token',
    ],
    commands: [
      'brew install node',
      'git clone <repository-url>',
      'cd ai-remote-coder',
      'chmod +x ./run.sh',
      './run.sh',
      './wrapper/ai-runner start --run-id <id> --token <token>',
    ],
  },
  linux: {
    title: 'Linux Deployment',
    steps: [
      'Install Node.js 20+ using your package manager',
      'Clone the repository to your desired location',
      'Install dependencies with npm',
      'Build the project: npm run build',
      'Start the gateway with npm',
      'The UI will be available at https://localhost:3100',
      'Create a run from the UI to get credentials',
      'Connect clients using the provided credentials',
    ],
    commands: [
      '# Ubuntu/Debian:',
      'sudo apt-get install nodejs npm',
      'git clone <repository-url>',
      'cd ai-remote-coder',
      'npm install',
      'npm run build',
      'npm run start -w gateway',
      './wrapper/ai-runner start --run-id <id> --token <token>',
    ],
  },
};

export function Clients({ user: _user }: Props) {
  const { addToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  // State
  const [clients, setClients] = useState<Client[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedOS, setSelectedOS] = useState<OSType>('windows');
  const [showDeploymentGuide, setShowDeploymentGuide] = useState(false);

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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div>
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
                ● {onlineCount} online
              </span>
              <span style={{ color: 'var(--accent-red)' }}>
                ○ {offlineCount} offline
              </span>
            </div>
          </div>
          <button
            className={`btn ${showDeploymentGuide ? 'btn-primary' : ''}`}
            onClick={() => setShowDeploymentGuide(!showDeploymentGuide)}
            style={{ whiteSpace: 'nowrap' }}
          >
            {showDeploymentGuide ? '✓ Deployment Guide' : 'Deployment Guide'}
          </button>
        </div>
      </div>

      {/* Deployment Guide Section */}
      {showDeploymentGuide && (
        <div
          style={{
            marginBottom: '20px',
            padding: '20px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
          }}
        >
          <h3 style={{ marginTop: 0, marginBottom: '16px', fontSize: '16px', fontWeight: '600' }}>
            Deployment Instructions
          </h3>

          {/* OS Selection Tabs */}
          <div
            style={{
              display: 'flex',
              gap: '8px',
              marginBottom: '16px',
              borderBottom: '1px solid var(--border-color)',
            }}
          >
            {(['windows', 'macos', 'linux'] as OSType[]).map((os) => (
              <button
                key={os}
                onClick={() => setSelectedOS(os)}
                style={{
                  padding: '10px 16px',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: selectedOS === os ? '2px solid var(--accent-blue)' : 'none',
                  color: selectedOS === os ? 'var(--accent-blue)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: selectedOS === os ? '600' : '400',
                  transition: 'all 0.2s ease',
                }}
              >
                {os === 'windows' ? '🪟 Windows' : os === 'macos' ? '🍎 macOS' : '🐧 Linux'}
              </button>
            ))}
          </div>

          {/* Instructions Content */}
          <div style={{ paddingBottom: '16px' }}>
            <h4 style={{ marginTop: 0, marginBottom: '12px', fontSize: '14px', fontWeight: '600' }}>
              {deploymentInstructions[selectedOS].title}
            </h4>

            <div style={{ marginBottom: '16px' }}>
              <h5 style={{ marginTop: 0, marginBottom: '8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                Steps:
              </h5>
              <ol
                style={{
                  margin: 0,
                  paddingLeft: '20px',
                  fontSize: '13px',
                  lineHeight: '1.6',
                  color: 'var(--text-secondary)',
                }}
              >
                {deploymentInstructions[selectedOS].steps.map((step, idx) => (
                  <li key={idx} style={{ marginBottom: '6px' }}>
                    {step}
                  </li>
                ))}
              </ol>
            </div>

            <div>
              <h5 style={{ marginTop: 0, marginBottom: '8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                Commands:
              </h5>
              <div
                style={{
                  background: 'var(--bg-tertiary)',
                  padding: '12px',
                  borderRadius: '6px',
                  overflow: 'auto',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  color: 'var(--text-primary)',
                  lineHeight: '1.6',
                }}
              >
                {deploymentInstructions[selectedOS].commands.map((cmd, idx) => (
                  <div key={idx} style={{ marginBottom: idx === deploymentInstructions[selectedOS].commands.length - 1 ? 0 : '6px' }}>
                    {cmd.startsWith('#') ? (
                      <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>{cmd}</span>
                    ) : (
                      <span>$ {cmd}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div
              style={{
                marginTop: '16px',
                padding: '12px',
                background: 'var(--bg-tertiary)',
                borderRadius: '6px',
                fontSize: '12px',
                color: 'var(--text-secondary)',
                borderLeft: '3px solid var(--accent-blue)',
              }}
            >
              <strong>💡 Tip:</strong> Once the gateway is running, create a run from the UI, then use the provided run-id and token to connect clients.
            </div>
          </div>
        </div>
      )}

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
            <p style={{ marginBottom: '12px' }}>
              <strong>To get started:</strong>
            </p>
            <ol style={{ margin: '0 0 12px 20px', paddingLeft: 0 }}>
              <li style={{ marginBottom: '6px' }}>
                <button
                  onClick={() => setShowDeploymentGuide(true)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--accent-blue)',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    fontSize: '13px',
                    padding: 0,
                  }}
                >
                  Follow the deployment guide
                </button>
                {' '}for your operating system
              </li>
              <li style={{ marginBottom: '6px' }}>Create a run from the Runs page to get a run-id and token</li>
              <li>Connect a client using the command below</li>
            </ol>
            <p style={{ marginBottom: '8px', marginTop: '12px' }}>
              <strong>Connect a client:</strong>
            </p>
            <code style={{ display: 'block', padding: '8px', background: 'var(--bg-tertiary)', borderRadius: '4px' }}>
              ai-runner start --run-id [id] --token [token]
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
