import { Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { ToastProvider } from './components/ui';
import { Layout } from './components/Layout';
import {
  Dashboard,
  Runs,
  RunDetail,
  Clients,
  ClientDetailPage,
  Alerts,
  Settings,
} from './pages';
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
    return (
      <ToastProvider>
        <Setup onComplete={() => checkAuth()} />
      </ToastProvider>
    );
  }

  // Not authenticated
  if (!user && !authStatus?.cloudflareEnabled) {
    return (
      <ToastProvider>
        <Login onLogin={(u) => setUser(u)} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <div className="app">
        <Layout user={user} onLogout={handleLogout}>
          <Routes>
            {/* Dashboard */}
            <Route path="/" element={<Dashboard user={user} />} />

            {/* Runs */}
            <Route path="/runs" element={<Runs user={user} />} />
            <Route path="/runs/:runId" element={<RunDetail user={user} />} />

            {/* Clients */}
            <Route path="/clients" element={<Clients user={user} />} />
            <Route path="/clients/:clientId" element={<ClientDetailPage user={user} />} />

            {/* Alerts */}
            <Route path="/alerts" element={<Alerts user={user} />} />

            {/* Settings */}
            <Route path="/settings" element={<Settings user={user} onLogout={handleLogout} />} />

            {/* Fallback */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </div>
    </ToastProvider>
  );
}

export default App;
