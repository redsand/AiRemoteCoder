import { Routes, Route, Link, Navigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import RunList from './components/RunList';
import RunDetail from './components/RunDetail';
import Login from './components/Login';
import Setup from './components/Setup';

interface User {
  id: string;
  username: string;
  role: string;
}

interface AuthStatus {
  setupRequired: boolean;
  cloudflareEnabled: boolean;
  localAuthEnabled: boolean;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      // First check auth status
      const statusRes = await fetch('/api/auth/status');
      const status = await statusRes.json();
      setAuthStatus(status);

      // Try to get current user
      const meRes = await fetch('/api/auth/me');
      if (meRes.ok) {
        const data = await meRes.json();
        setUser(data.user);
      }
    } catch (err) {
      console.error('Auth check failed:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
  }

  if (loading) {
    return (
      <div className="app">
        <div className="loading">
          <div className="spinner" />
        </div>
      </div>
    );
  }

  // Setup required
  if (authStatus?.setupRequired) {
    return <Setup onComplete={() => checkAuth()} />;
  }

  // Not authenticated
  if (!user && !authStatus?.cloudflareEnabled) {
    return <Login onLogin={(u) => setUser(u)} />;
  }

  return (
    <div className="app">
      <header className="header">
        <h1>
          <Link to="/">Claude Code Monitor</Link>
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {user && (
            <>
              <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                {user.username}
              </span>
              <button className="btn btn-sm" onClick={handleLogout}>
                Logout
              </button>
            </>
          )}
        </div>
      </header>

      <main className="main">
        <Routes>
          <Route path="/" element={<RunList user={user} />} />
          <Route path="/runs/:runId" element={<RunDetail user={user} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
