import { ReactNode, useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

interface LayoutProps {
  user: { id: string; username: string; role: string } | null;
  onLogout: () => void;
  children: ReactNode;
}

interface NavItem {
  path: string;
  label: string;
  icon: string;
  activeIcon: string;
}

const navItems: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: '\uD83C\uDFE0', activeIcon: '\uD83C\uDFE0' },
  { path: '/runs', label: 'Runs', icon: '\uD83D\uDCCB', activeIcon: '\uD83D\uDCCB' },
  { path: '/clients', label: 'Clients', icon: '\uD83D\uDCBB', activeIcon: '\uD83D\uDCBB' },
  { path: '/alerts', label: 'Alerts', icon: '\uD83D\uDD14', activeIcon: '\uD83D\uDD14' },
  { path: '/settings', label: 'Settings', icon: '\u2699\uFE0F', activeIcon: '\u2699\uFE0F' },
];

export function Layout({ user, onLogout, children }: LayoutProps) {
  const location = useLocation();
  const [alertCount, setAlertCount] = useState(0);

  // Fetch unacknowledged alert count
  useEffect(() => {
    const fetchAlertCount = async () => {
      try {
        const res = await fetch('/api/alerts/stats');
        if (res.ok) {
          const data = await res.json();
          setAlertCount(data.unacknowledged || 0);
        }
      } catch (err) {
        // Ignore
      }
    };

    fetchAlertCount();
    const interval = setInterval(fetchAlertCount, 30000);
    return () => clearInterval(interval);
  }, []);

  // Get page title based on route
  const getPageTitle = () => {
    const path = location.pathname;
    if (path === '/') return 'Dashboard';
    if (path.startsWith('/runs/')) return 'Run Details';
    if (path === '/runs') return 'Runs';
    if (path.startsWith('/clients/')) return 'Client Details';
    if (path === '/clients') return 'Clients';
    if (path === '/alerts') return 'Alerts';
    if (path === '/settings') return 'Settings';
    return 'Connect-Back Gateway';
  };

  return (
    <div className="layout">
      {/* Top header - Desktop */}
      <header className="header header-desktop">
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <h1 style={{ fontSize: '18px', fontWeight: 600 }}>
            <NavLink to="/" style={{ color: 'inherit', textDecoration: 'none' }}>
              Connect-Back Gateway
            </NavLink>
          </h1>

          {/* Desktop nav */}
          <nav className="desktop-nav">
            {navItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) =>
                  `nav-link ${isActive ? 'nav-link-active' : ''}`
                }
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
                {item.path === '/alerts' && alertCount > 0 && (
                  <span className="nav-badge">{alertCount}</span>
                )}
              </NavLink>
            ))}
          </nav>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {user && (
            <>
              <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                {user.username}
                <span
                  style={{
                    marginLeft: '6px',
                    padding: '2px 6px',
                    fontSize: '10px',
                    background: 'var(--bg-tertiary)',
                    borderRadius: '4px',
                    textTransform: 'uppercase',
                  }}
                >
                  {user.role}
                </span>
              </span>
              <button className="btn btn-sm" onClick={onLogout}>
                Logout
              </button>
            </>
          )}
        </div>
      </header>

      {/* Top header - Mobile */}
      <header className="header header-mobile">
        <h1 style={{ fontSize: '16px', fontWeight: 600 }}>
          {getPageTitle()}
        </h1>
        {user && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span
              style={{
                padding: '2px 6px',
                fontSize: '10px',
                background: 'var(--bg-tertiary)',
                borderRadius: '4px',
                textTransform: 'uppercase',
              }}
            >
              {user.role}
            </span>
          </div>
        )}
      </header>

      {/* Main content */}
      <main className="main">
        {children}
      </main>

      {/* Bottom navigation - Mobile */}
      <nav className="bottom-nav">
        {navItems.map((item) => {
          const isActive = item.path === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(item.path);

          return (
            <NavLink
              key={item.path}
              to={item.path}
              className="bottom-nav-item"
              style={{
                color: isActive ? 'var(--accent-blue)' : 'var(--text-secondary)',
              }}
            >
              <span style={{ fontSize: '20px', marginBottom: '2px' }}>
                {isActive ? item.activeIcon : item.icon}
              </span>
              <span style={{ fontSize: '10px' }}>{item.label}</span>
              {item.path === '/alerts' && alertCount > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: '4px',
                    right: 'calc(50% - 16px)',
                    width: '16px',
                    height: '16px',
                    background: 'var(--accent-red)',
                    color: 'white',
                    fontSize: '10px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {alertCount > 9 ? '9+' : alertCount}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}

export default Layout;
