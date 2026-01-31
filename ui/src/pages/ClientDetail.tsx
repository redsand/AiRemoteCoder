import { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  StatusPill,
  RunCard,
  type Run,
  type Client,
  Modal,
  ConfirmModal,
  useToast,
} from '../components/ui';

interface ClientDetail extends Client {
  runs: Run[];
  recentEvents: {
    id: number;
    run_id: string;
    type: string;
    data: string;
    timestamp: number;
  }[];
}

interface Props {
  user: { id: string; username: string; role: string } | null;
}

function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

export function ClientDetailPage({ user }: Props) {
  const { clientId } = useParams<{ clientId: string }>();
  const navigate = useNavigate();
  const { addToast } = useToast();

  // State
  const [client, setClient] = useState<ClientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [rotateLoading, setRotateLoading] = useState(false);
  const [rotatedToken, setRotatedToken] = useState<string | null>(null);

  const canOperate = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';

  // Fetch client
  const fetchClient = useCallback(async () => {
    try {
      const res = await fetch(`/api/clients/${clientId}`);
      if (res.ok) {
        const data = await res.json();
        setClient(data);
      } else if (res.status === 404) {
        navigate('/clients', { replace: true });
        addToast('error', 'Client not found');
      }
    } catch (err) {
      console.error('Failed to fetch client:', err);
      addToast('error', 'Failed to load client');
    } finally {
      setLoading(false);
    }
  }, [clientId, navigate, addToast]);

  // Initial fetch
  useEffect(() => {
    fetchClient();
    const interval = setInterval(fetchClient, 15000);
    return () => clearInterval(interval);
  }, [fetchClient]);

  // Toggle operator enabled
  const toggleOperatorEnabled = async () => {
    if (!client) return;

    setActionLoading(true);
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorEnabled: !client.operator_enabled }),
      });
      if (res.ok) {
        addToast('success', `Operator actions ${client.operator_enabled ? 'disabled' : 'enabled'}`);
        setShowDisableConfirm(false);
        fetchClient();
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to update client');
      }
    } catch (err) {
      addToast('error', 'Failed to update client');
    } finally {
      setActionLoading(false);
    }
  };

  // Delete client
  const deleteClient = async () => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/clients/${clientId}`, { method: 'DELETE' });
      if (res.ok) {
        addToast('success', 'Client deleted');
        navigate('/clients', { replace: true });
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to delete client');
      }
    } catch (err) {
      addToast('error', 'Failed to delete client');
    } finally {
      setActionLoading(false);
      setShowDeleteConfirm(false);
    }
  };

  const rotateToken = async () => {
    if (!client) return;

    setRotateLoading(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/token`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setRotatedToken(data.token);
        setShowTokenModal(true);
        setShowRotateConfirm(false);
        addToast('success', 'Client token rotated');
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to rotate token');
      }
    } catch (err) {
      addToast('error', 'Failed to rotate token');
    } finally {
      setRotateLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
      </div>
    );
  }

  if (!client) {
    return (
      <div className="empty-state">
        <h2>Client not found</h2>
        <Link to="/clients" className="btn">
          Back to clients
        </Link>
      </div>
    );
  }

  const activeRuns = client.runs?.filter(r => r.status === 'running') || [];
  const recentRuns = client.runs?.slice(0, 10) || [];

  return (
    <div className="client-detail">
      {/* Header */}
      <div className="client-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
          <Link to="/clients" className="btn btn-sm">
            ← Back
          </Link>
          <StatusPill status={client.status as any} />
          {!client.operator_enabled && (
            <span
              style={{
                padding: '4px 8px',
                fontSize: '11px',
                background: 'rgba(210, 153, 34, 0.15)',
                color: 'var(--accent-yellow)',
                borderRadius: '4px',
              }}
            >
              Operator Disabled
            </span>
          )}
        </div>

        <h1 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>
          {client.display_name}
        </h1>

        <div
          style={{
            fontSize: '13px',
            color: 'var(--text-secondary)',
            fontFamily: 'monospace',
            marginBottom: '12px',
          }}
        >
          {client.agent_id}
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '16px',
            fontSize: '13px',
            color: 'var(--text-secondary)',
          }}
        >
          <span>
            <strong>Last seen:</strong> {formatRelativeTime(client.last_seen_at)}
          </span>
          {client.version && (
            <span>
              <strong>Version:</strong> {client.version}
            </span>
          )}
          {client.created_at && (
            <span>
              <strong>Connected:</strong> {formatTime(client.created_at)}
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      {canOperate && (
        <div
          style={{
            display: 'flex',
            gap: '8px',
            marginTop: '16px',
            marginBottom: '24px',
            flexWrap: 'wrap',
          }}
        >
          <button
            className="btn"
            onClick={() => setShowDisableConfirm(true)}
          >
            {client.operator_enabled ? 'Disable Operator Actions' : 'Enable Operator Actions'}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setShowRotateConfirm(true)}
          >
            Rotate Token
          </button>
          {isAdmin && (
            <button
              className="btn btn-danger"
              onClick={() => setShowDeleteConfirm(true)}
            >
              Delete Client
            </button>
          )}
        </div>
      )}

      {/* Capabilities */}
      {client.capabilities && client.capabilities.length > 0 && (
        <section className="client-section">
          <h2 className="section-title">Capabilities</h2>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '8px',
            }}
          >
            {client.capabilities.map((cap, i) => (
              <span
                key={i}
                style={{
                  padding: '4px 10px',
                  fontSize: '12px',
                  background: 'var(--bg-tertiary)',
                  borderRadius: '4px',
                  fontFamily: 'monospace',
                }}
              >
                {cap}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Active Runs */}
      {activeRuns.length > 0 && (
        <section className="client-section">
          <h2 className="section-title">
            Active Runs
            <span
              style={{
                marginLeft: '8px',
                padding: '2px 8px',
                fontSize: '12px',
                background: 'rgba(59, 185, 80, 0.15)',
                color: 'var(--accent-green)',
                borderRadius: '10px',
              }}
            >
              {activeRuns.length}
            </span>
          </h2>
          <div className="run-list">
            {activeRuns.map((run) => (
              <RunCard key={run.id} run={run as Run} showClient={false} />
            ))}
          </div>
        </section>
      )}

      {/* Recent Runs */}
      <section className="client-section">
        <div className="section-header">
          <h2 className="section-title">Recent Runs</h2>
          <Link
            to={`/runs?clientId=${client.id}`}
            className="btn btn-sm"
          >
            View All
          </Link>
        </div>
        {recentRuns.length === 0 ? (
          <div className="empty-state-small">
            No runs from this client yet.
          </div>
        ) : (
          <div className="run-list">
            {recentRuns.map((run) => (
              <RunCard key={run.id} run={run as Run} compact showClient={false} />
            ))}
          </div>
        )}
      </section>

      {/* Recent Events */}
      {client.recentEvents && client.recentEvents.length > 0 && (
        <section className="client-section">
          <h2 className="section-title">Recent Events</h2>
          <div className="event-list">
            {client.recentEvents.slice(0, 20).map((event) => (
              <div
                key={event.id}
                className="event-item"
                onClick={() => navigate(`/runs/${event.run_id}`)}
                style={{ cursor: 'pointer' }}
              >
                <span
                  style={{
                    width: '80px',
                    flexShrink: 0,
                    fontSize: '11px',
                    color: 'var(--text-muted)',
                  }}
                >
                  {formatRelativeTime(event.timestamp)}
                </span>
                <span
                  style={{
                    padding: '2px 6px',
                    fontSize: '10px',
                    background: 'var(--bg-tertiary)',
                    borderRadius: '3px',
                    textTransform: 'uppercase',
                    flexShrink: 0,
                  }}
                >
                  {event.type}
                </span>
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: '12px',
                    fontFamily: 'monospace',
                  }}
                >
                  {event.data.slice(0, 80)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Disable Operator Confirmation */}
      <ConfirmModal
        open={showDisableConfirm}
        onClose={() => setShowDisableConfirm(false)}
        onConfirm={toggleOperatorEnabled}
        title={client.operator_enabled ? 'Disable Operator Actions' : 'Enable Operator Actions'}
        message={
          client.operator_enabled
            ? 'Disabling operator actions will prevent commands from being sent to this client. Existing runs will continue but no new commands can be issued.'
            : 'Enabling operator actions will allow commands to be sent to this client.'
        }
        confirmText={client.operator_enabled ? 'Disable' : 'Enable'}
        danger={!!client.operator_enabled}
        loading={actionLoading}
      />

      {/* Delete Confirmation */}
      <ConfirmModal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={deleteClient}
        title="Delete Client"
        message="Are you sure you want to delete this client? This action cannot be undone. Associated runs will be preserved but will no longer be linked to this client."
        confirmText="Delete Client"
        danger
        loading={actionLoading}
      />

      {/* Rotate Token Confirmation */}
      <ConfirmModal
        open={showRotateConfirm}
        onClose={() => setShowRotateConfirm(false)}
        onConfirm={rotateToken}
        title="Rotate Client Token"
        message="This will invalidate the existing token. The runner must be restarted with the new token. Continue?"
        confirmText={rotateLoading ? 'Rotating...' : 'Rotate Token'}
        danger
        loading={rotateLoading}
      />

      {/* Token Modal */}
      {showTokenModal && rotatedToken && client && (
        <Modal
          open={showTokenModal}
          onClose={() => setShowTokenModal(false)}
          title="New Client Token"
          footer={
            <button className="btn btn-primary" onClick={() => setShowTokenModal(false)}>
              Done
            </button>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
              Copy the new token and restart the runner:
            </p>

            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px', color: 'var(--text-secondary)' }}>
                Client Token:
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
                  {rotatedToken}
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(rotatedToken);
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
                  ai-runner listen --agent-id {client.agent_id} --client-token {rotatedToken} --agent-label "{client.display_name}"
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(`ai-runner listen --agent-id ${client.agent_id} --client-token ${rotatedToken} --agent-label "${client.display_name}"`);
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
          </div>
        </Modal>
      )}
    </div>
  );
}

export default ClientDetailPage;
