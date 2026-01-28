import { useState } from 'react';

interface Props {
  onLogin: (user: { id: string; username: string; role: string }) => void;
}

function Login({ onLogin }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          totpCode: totpCode || undefined
        })
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.totpRequired) {
          setNeedsTotp(true);
        } else {
          setError(data.error || 'Login failed');
        }
        return;
      }

      onLogin(data.user);
    } catch (err) {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-container">
      <div className="card login-card">
        <h1 className="login-title">Claude Code Monitor</h1>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Username</label>
            <input
              type="text"
              className="form-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
              autoFocus
            />
          </div>

          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>

          {needsTotp && (
            <div className="form-group">
              <label className="form-label">TOTP Code</label>
              <input
                type="text"
                className="form-input"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="6-digit code"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
              />
            </div>
          )}

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
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default Login;
