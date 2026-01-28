import { useState } from 'react';

interface Props {
  onComplete: () => void;
}

function Setup({ onComplete }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [enableTotp, setEnableTotp] = useState(true);
  const [totpUri, setTotpUri] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 12) {
      setError('Password must be at least 12 characters');
      return;
    }

    setLoading(true);

    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          enableTotp
        })
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Setup failed');
        return;
      }

      if (data.totpUri) {
        setTotpUri(data.totpUri);
      } else {
        onComplete();
      }
    } catch (err) {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  }

  if (totpUri) {
    return (
      <div className="login-container">
        <div className="card login-card">
          <h1 className="login-title">Setup Complete</h1>

          <div style={{ marginBottom: '24px' }}>
            <p style={{ marginBottom: '12px', color: 'var(--text-secondary)' }}>
              Scan this QR code with your authenticator app:
            </p>
            <div style={{
              background: 'white',
              padding: '16px',
              borderRadius: '8px',
              textAlign: 'center'
            }}>
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(totpUri)}`}
                alt="TOTP QR Code"
                style={{ maxWidth: '100%' }}
              />
            </div>
            <p style={{
              marginTop: '12px',
              fontSize: '12px',
              color: 'var(--text-muted)',
              wordBreak: 'break-all'
            }}>
              Manual entry: {totpUri}
            </p>
          </div>

          <button
            className="btn btn-primary"
            style={{ width: '100%' }}
            onClick={onComplete}
          >
            Continue to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="card login-card">
        <h1 className="login-title">Initial Setup</h1>
        <p style={{ marginBottom: '24px', color: 'var(--text-secondary)', textAlign: 'center' }}>
          Create your admin account
        </p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Username</label>
            <input
              type="text"
              className="form-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
              maxLength={50}
              pattern="[a-zA-Z0-9_-]+"
              autoComplete="username"
              autoFocus
            />
          </div>

          <div className="form-group">
            <label className="form-label">Password (min 12 characters)</label>
            <input
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={12}
              autoComplete="new-password"
            />
          </div>

          <div className="form-group">
            <label className="form-label">Confirm Password</label>
            <input
              type="password"
              className="form-input"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>

          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={enableTotp}
                onChange={(e) => setEnableTotp(e.target.checked)}
              />
              <span className="form-label" style={{ margin: 0 }}>
                Enable TOTP two-factor authentication (recommended)
              </span>
            </label>
          </div>

          {error && (
            <div style={{ color: 'var(--accent-red)', marginBottom: '16px', fontSize: '14px' }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%' }}
            disabled={loading}
          >
            {loading ? 'Creating...' : 'Create Admin Account'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default Setup;
