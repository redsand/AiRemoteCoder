import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal, ConfirmModal, useToast } from '../components/ui';

interface Alert {
  id: string;
  rule_id: string | null;
  type: string;
  severity: string;
  title: string;
  message: string | null;
  target_type: string | null;
  target_id: string | null;
  acknowledged: number;
  acknowledged_by: string | null;
  acknowledged_at: number | null;
  created_at: number;
}

interface AlertRule {
  id: string;
  name: string;
  type: string;
  config: { timeoutMinutes?: number };
  enabled: number;
  created_at: number;
}

interface Props {
  user: { id: string; username: string; role: string } | null;
}

const alertTypeLabels: Record<string, string> = {
  run_failed: 'Run Failed',
  waiting_approval_timeout: 'Waiting Approval Timeout',
  client_offline_active_runs: 'Client Offline with Active Runs',
};

const severityColors: Record<string, string> = {
  critical: 'var(--accent-red)',
  warning: 'var(--accent-yellow)',
  info: 'var(--accent-blue)',
};

function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function Alerts({ user }: Props) {
  const navigate = useNavigate();
  const { addToast } = useToast();

  // State
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [unacknowledgedCount, setUnacknowledgedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [showAddRuleModal, setShowAddRuleModal] = useState(false);
  const [showAckAllConfirm, setShowAckAllConfirm] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unacknowledged'>('unacknowledged');

  // New rule form
  const [newRuleName, setNewRuleName] = useState('');
  const [newRuleType, setNewRuleType] = useState('run_failed');
  const [newRuleTimeout, setNewRuleTimeout] = useState(30);

  const canOperate = user?.role === 'admin' || user?.role === 'operator';

  // Fetch alerts
  const fetchAlerts = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filter === 'unacknowledged') {
        params.set('acknowledged', 'false');
      }
      params.set('limit', '50');

      const res = await fetch(`/api/alerts?${params}`);
      if (res.ok) {
        const data = await res.json();
        setAlerts(data.alerts || []);
        setUnacknowledgedCount(data.unacknowledged || 0);
      }
    } catch (err) {
      console.error('Failed to fetch alerts:', err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  // Fetch rules
  const fetchRules = useCallback(async () => {
    try {
      const res = await fetch('/api/alerts/rules');
      if (res.ok) {
        const data = await res.json();
        setRules(data || []);
      }
    } catch (err) {
      console.error('Failed to fetch rules:', err);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchAlerts();
    fetchRules();
    const interval = setInterval(fetchAlerts, 30000);
    return () => clearInterval(interval);
  }, [fetchAlerts, fetchRules]);

  // Acknowledge single alert
  const acknowledgeAlert = async (alertId: string) => {
    try {
      const res = await fetch(`/api/alerts/${alertId}/acknowledge`, { method: 'POST' });
      if (res.ok) {
        fetchAlerts();
      }
    } catch (err) {
      addToast('error', 'Failed to acknowledge alert');
    }
  };

  // Acknowledge all alerts
  const acknowledgeAll = async () => {
    try {
      const res = await fetch('/api/alerts/acknowledge-all', { method: 'POST' });
      if (res.ok) {
        addToast('success', 'All alerts acknowledged');
        setShowAckAllConfirm(false);
        fetchAlerts();
      }
    } catch (err) {
      addToast('error', 'Failed to acknowledge alerts');
    }
  };

  // Create rule
  const createRule = async () => {
    if (!newRuleName) {
      addToast('error', 'Rule name is required');
      return;
    }

    try {
      const res = await fetch('/api/alerts/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newRuleName,
          type: newRuleType,
          config: newRuleType === 'waiting_approval_timeout' ? { timeoutMinutes: newRuleTimeout } : {},
          enabled: true,
        }),
      });
      if (res.ok) {
        addToast('success', 'Alert rule created');
        setShowAddRuleModal(false);
        setNewRuleName('');
        fetchRules();
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to create rule');
      }
    } catch (err) {
      addToast('error', 'Failed to create rule');
    }
  };

  // Toggle rule enabled
  const toggleRule = async (ruleId: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/alerts/rules/${ruleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        fetchRules();
      }
    } catch (err) {
      addToast('error', 'Failed to update rule');
    }
  };

  // Delete rule
  const deleteRule = async (ruleId: string) => {
    try {
      const res = await fetch(`/api/alerts/rules/${ruleId}`, { method: 'DELETE' });
      if (res.ok) {
        addToast('success', 'Rule deleted');
        fetchRules();
      }
    } catch (err) {
      addToast('error', 'Failed to delete rule');
    }
  };

  // Navigate to alert target
  const handleAlertClick = (alert: Alert) => {
    if (alert.target_type === 'run' && alert.target_id) {
      navigate(`/runs/${alert.target_id}`);
    } else if (alert.target_type === 'client' && alert.target_id) {
      navigate(`/clients/${alert.target_id}`);
    }
  };

  return (
    <div className="alerts-page">
      {/* Header */}
      <div className="page-header">
        <h2 className="page-title">Alerts</h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          {canOperate && (
            <button className="btn" onClick={() => setShowRulesModal(true)}>
              Manage Rules
            </button>
          )}
          {unacknowledgedCount > 0 && (
            <button
              className="btn btn-primary"
              onClick={() => setShowAckAllConfirm(true)}
            >
              Acknowledge All ({unacknowledgedCount})
            </button>
          )}
        </div>
      </div>

      {/* Filter tabs */}
      <div className="tabs" style={{ marginBottom: '16px' }}>
        <button
          className={`tab ${filter === 'unacknowledged' ? 'tab-active' : ''}`}
          onClick={() => setFilter('unacknowledged')}
        >
          Unacknowledged
          {unacknowledgedCount > 0 && (
            <span className="tab-badge">{unacknowledgedCount}</span>
          )}
        </button>
        <button
          className={`tab ${filter === 'all' ? 'tab-active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All Alerts
        </button>
      </div>

      {/* Alerts list */}
      {loading ? (
        <div className="loading">
          <div className="spinner" />
        </div>
      ) : alerts.length === 0 ? (
        <div className="empty-state">
          <h2>No alerts</h2>
          <p>
            {filter === 'unacknowledged'
              ? 'All alerts have been acknowledged.'
              : 'No alerts have been triggered yet.'}
          </p>
        </div>
      ) : (
        <div className="alert-list">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className="alert-item"
              style={{
                borderLeft: `4px solid ${severityColors[alert.severity] || 'var(--border-color)'}`,
                opacity: alert.acknowledged ? 0.6 : 1,
              }}
            >
              <div
                className="alert-content"
                onClick={() => handleAlertClick(alert)}
                style={{ cursor: alert.target_id ? 'pointer' : 'default' }}
              >
                <div className="alert-header">
                  <span
                    className="alert-severity"
                    style={{ color: severityColors[alert.severity] }}
                  >
                    {alert.severity.toUpperCase()}
                  </span>
                  <span className="alert-type">
                    {alertTypeLabels[alert.type] || alert.type}
                  </span>
                  <span className="alert-time">
                    {formatRelativeTime(alert.created_at)}
                  </span>
                </div>
                <div className="alert-title">{alert.title}</div>
                {alert.message && (
                  <div className="alert-message">{alert.message}</div>
                )}
              </div>
              {!alert.acknowledged && (
                <button
                  className="btn btn-sm"
                  onClick={() => acknowledgeAlert(alert.id)}
                  aria-label="Acknowledge alert"
                >
                  \u2713
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Rules Modal */}
      <Modal
        open={showRulesModal}
        onClose={() => setShowRulesModal(false)}
        title="Alert Rules"
        size="lg"
        footer={
          <>
            <button className="btn" onClick={() => setShowRulesModal(false)}>
              Close
            </button>
            {canOperate && (
              <button
                className="btn btn-primary"
                onClick={() => {
                  setShowRulesModal(false);
                  setShowAddRuleModal(true);
                }}
              >
                Add Rule
              </button>
            )}
          </>
        }
      >
        {rules.length === 0 ? (
          <div className="empty-state-small">
            No alert rules configured yet.
          </div>
        ) : (
          <div className="rules-list">
            {rules.map((rule) => (
              <div key={rule.id} className="rule-item">
                <div className="rule-info">
                  <div className="rule-name">{rule.name}</div>
                  <div className="rule-type">
                    {alertTypeLabels[rule.type] || rule.type}
                    {rule.config.timeoutMinutes && (
                      <span> ({rule.config.timeoutMinutes} min)</span>
                    )}
                  </div>
                </div>
                <div className="rule-actions">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={!!rule.enabled}
                      onChange={(e) => toggleRule(rule.id, e.target.checked)}
                    />
                    <span className="slider" />
                  </label>
                  {canOperate && (
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => deleteRule(rule.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* Add Rule Modal */}
      <Modal
        open={showAddRuleModal}
        onClose={() => setShowAddRuleModal(false)}
        title="Add Alert Rule"
        footer={
          <>
            <button className="btn" onClick={() => setShowAddRuleModal(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={createRule}>
              Create Rule
            </button>
          </>
        }
      >
        <div className="form-group">
          <label className="form-label">Rule Name</label>
          <input
            type="text"
            className="form-input"
            value={newRuleName}
            onChange={(e) => setNewRuleName(e.target.value)}
            placeholder="e.g., Notify on failures"
          />
        </div>

        <div className="form-group">
          <label className="form-label">Trigger Type</label>
          <select
            className="form-input"
            value={newRuleType}
            onChange={(e) => setNewRuleType(e.target.value)}
          >
            <option value="run_failed">When a run fails</option>
            <option value="waiting_approval_timeout">When approval times out</option>
            <option value="client_offline_active_runs">When client goes offline with active runs</option>
          </select>
        </div>

        {newRuleType === 'waiting_approval_timeout' && (
          <div className="form-group">
            <label className="form-label">Timeout (minutes)</label>
            <input
              type="number"
              className="form-input"
              value={newRuleTimeout}
              onChange={(e) => setNewRuleTimeout(parseInt(e.target.value) || 30)}
              min={1}
              max={1440}
            />
          </div>
        )}

        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>
          Note: V1 supports in-app alerts only. Email/SMS notifications will be added in future versions.
        </p>
      </Modal>

      {/* Acknowledge All Confirmation */}
      <ConfirmModal
        open={showAckAllConfirm}
        onClose={() => setShowAckAllConfirm(false)}
        onConfirm={acknowledgeAll}
        title="Acknowledge All Alerts"
        message={`Are you sure you want to acknowledge all ${unacknowledgedCount} unacknowledged alerts?`}
        confirmText="Acknowledge All"
      />
    </div>
  );
}

export default Alerts;
