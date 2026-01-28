import { useState, useEffect } from 'react';
import { useToast, Modal } from '../components/ui';

interface AuthStatus {
  authenticated: boolean;
  cfAccessEnabled: boolean;
  email?: string;
  user?: {
    id: string;
    username: string;
    role: string;
  };
  needsSetup: boolean;
}

interface Props {
  user: { id: string; username: string; role: string } | null;
  onLogout: () => void;
}

const allowedCommands = [
  'npm test',
  'npm run build',
  'npm run lint',
  'git diff',
  'git status',
  'git log --oneline -10',
  'ls -la',
  'pwd',
  'pytest',
  'cargo test',
];

export function Settings({ user, onLogout }: Props) {
  const { addToast } = useToast();

  // State
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  // UI preferences (in-memory for now)
  const [darkMode, setDarkMode] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [compactView, setCompactView] = useState(false);

  const isAdmin = user?.role === 'admin';
  const canOperate = user?.role === 'admin' || user?.role === 'operator';

  // Fetch auth status
  useEffect(() => {
    const fetchAuthStatus = async () => {
      try {
        const res = await fetch('/api/auth/status');
        if (res.ok) {
          setAuthStatus(await res.json());
        }
      } catch (err) {
        console.error('Failed to fetch auth status:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchAuthStatus();
  }, []);

  // Handle logout
  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      addToast('success', 'Logged out successfully');
      setShowLogoutConfirm(false);
      onLogout();
    } catch (err) {
      addToast('error', 'Failed to logout');
    }
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="settings-page">
      <h2 className="page-title">Settings</h2>

      {/* User Info */}
      <section className="settings-section">
        <h3 className="section-title">Account</h3>
        <div className="settings-card">
          <div className="settings-row">
            <span className="settings-label">Username</span>
            <span className="settings-value">{user?.username || 'Unknown'}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Role</span>
            <span
              className="settings-value"
              style={{
                textTransform: 'capitalize',
                color:
                  user?.role === 'admin'
                    ? 'var(--accent-purple)'
                    : user?.role === 'operator'
                    ? 'var(--accent-blue)'
                    : 'var(--text-secondary)',
              }}
            >
              {user?.role || 'Unknown'}
            </span>
          </div>
          {authStatus?.cfAccessEnabled && authStatus.email && (
            <div className="settings-row">
              <span className="settings-label">Cloudflare Access</span>
              <span className="settings-value">{authStatus.email}</span>
            </div>
          )}
          <div className="settings-row" style={{ borderBottom: 'none' }}>
            <button
              className="btn btn-danger"
              onClick={() => setShowLogoutConfirm(true)}
            >
              Logout
            </button>
          </div>
        </div>
      </section>

      {/* Authentication */}
      <section className="settings-section">
        <h3 className="section-title">Authentication</h3>
        <div className="settings-card">
          <div className="settings-row">
            <span className="settings-label">Cloudflare Access</span>
            <span
              className="settings-value"
              style={{
                color: authStatus?.cfAccessEnabled
                  ? 'var(--accent-green)'
                  : 'var(--text-muted)',
              }}
            >
              {authStatus?.cfAccessEnabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Local Auth</span>
            <span
              className="settings-value"
              style={{
                color: !authStatus?.cfAccessEnabled
                  ? 'var(--accent-green)'
                  : 'var(--text-muted)',
              }}
            >
              {!authStatus?.cfAccessEnabled ? 'Active' : 'Fallback Only'}
            </span>
          </div>
        </div>
        <p className="settings-hint">
          For production deployments, Cloudflare Access provides zero-trust authentication.
          Set <code>CF_ACCESS_TEAM</code> and <code>CF_ACCESS_AUD</code> environment variables.
        </p>
      </section>

      {/* UI Preferences */}
      <section className="settings-section">
        <h3 className="section-title">UI Preferences</h3>
        <div className="settings-card">
          <div className="settings-row">
            <span className="settings-label">Dark Mode</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={darkMode}
                onChange={(e) => setDarkMode(e.target.checked)}
              />
              <span className="slider" />
            </label>
          </div>
          <div className="settings-row">
            <span className="settings-label">Auto-scroll Logs</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              <span className="slider" />
            </label>
          </div>
          <div className="settings-row">
            <span className="settings-label">Compact View</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={compactView}
                onChange={(e) => setCompactView(e.target.checked)}
              />
              <span className="slider" />
            </label>
          </div>
        </div>
      </section>

      {/* Allowed Commands (Operator/Admin) */}
      {canOperate && (
        <section className="settings-section">
          <h3 className="section-title">Allowed Commands</h3>
          <div className="settings-card">
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
              These commands can be executed on connected clients:
            </p>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px',
              }}
            >
              {allowedCommands.map((cmd) => (
                <code
                  key={cmd}
                  style={{
                    padding: '4px 8px',
                    background: 'var(--bg-tertiary)',
                    borderRadius: '4px',
                    fontSize: '12px',
                  }}
                >
                  {cmd}
                </code>
              ))}
            </div>
          </div>
          <p className="settings-hint">
            Additional commands can be configured via the <code>EXTRA_ALLOWED_COMMANDS</code> environment variable.
          </p>
        </section>
      )}

      {/* Redaction Patterns (Admin) */}
      {isAdmin && (
        <section className="settings-section">
          <h3 className="section-title">Secret Redaction</h3>
          <div className="settings-card">
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
              These patterns are automatically redacted from logs:
            </p>
            <ul style={{ fontSize: '12px', fontFamily: 'monospace', paddingLeft: '20px', margin: 0 }}>
              <li>API keys (sk-*, ghp_*, ghs_*, npm_*)</li>
              <li>PEM private keys</li>
              <li>Bearer tokens</li>
              <li>Authorization headers</li>
            </ul>
          </div>
        </section>
      )}

      {/* Data Retention (Admin) */}
      {isAdmin && (
        <section className="settings-section">
          <h3 className="section-title">Data Retention</h3>
          <div className="settings-card">
            <div className="settings-row">
              <span className="settings-label">Runs & Events</span>
              <span className="settings-value">No automatic pruning</span>
            </div>
            <div className="settings-row">
              <span className="settings-label">Artifacts</span>
              <span className="settings-value">Stored in .data/artifacts/</span>
            </div>
            <div className="settings-row">
              <span className="settings-label">Audit Log</span>
              <span className="settings-value">Retained indefinitely</span>
            </div>
          </div>
          <p className="settings-hint">
            Configure retention settings via environment variables or manually prune old data.
          </p>
        </section>
      )}

      {/* System Info */}
      <section className="settings-section">
        <h3 className="section-title">System Information</h3>
        <div className="settings-card">
          <div className="settings-row">
            <span className="settings-label">Gateway Version</span>
            <span className="settings-value">1.0.0</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Data Directory</span>
            <span className="settings-value">.data/</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Database</span>
            <span className="settings-value">SQLite (WAL mode)</span>
          </div>
        </div>
      </section>

      {/* Logout Confirmation */}
      <Modal
        open={showLogoutConfirm}
        onClose={() => setShowLogoutConfirm(false)}
        title="Confirm Logout"
        footer={
          <>
            <button className="btn" onClick={() => setShowLogoutConfirm(false)}>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={handleLogout}>
              Logout
            </button>
          </>
        }
      >
        <p>Are you sure you want to logout?</p>
      </Modal>
    </div>
  );
}

export default Settings;
