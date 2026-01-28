import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

interface Toast {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
  duration?: number;
}

interface ToastContextType {
  toasts: Toast[];
  addToast: (type: Toast['type'], message: string, duration?: number) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: Toast['type'], message: string, duration = 4000) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(prev => [...prev, { id, type, message, duration }]);

    if (duration > 0) {
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, duration);
    }
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  );
}

function ToastContainer({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: string) => void }) {
  const typeConfig = {
    success: { borderColor: 'var(--accent-green)', icon: '\u2713' },
    error: { borderColor: 'var(--accent-red)', icon: '\u2717' },
    info: { borderColor: 'var(--accent-blue)', icon: '\u2139' },
    warning: { borderColor: 'var(--accent-yellow)', icon: '\u26A0' },
  };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '80px', // Above mobile nav
        right: '16px',
        left: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        zIndex: 1000,
        pointerEvents: 'none',
      }}
    >
      {toasts.map(toast => {
        const config = typeConfig[toast.type];
        return (
          <div
            key={toast.id}
            style={{
              marginLeft: 'auto',
              maxWidth: '400px',
              padding: '12px 16px',
              background: 'var(--bg-secondary)',
              border: `1px solid ${config.borderColor}`,
              borderRadius: '8px',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              animation: 'slideIn 0.3s ease',
              pointerEvents: 'auto',
            }}
            onClick={() => onRemove(toast.id)}
            role="alert"
          >
            <span style={{ color: config.borderColor, fontWeight: 'bold' }}>
              {config.icon}
            </span>
            <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>
              {toast.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default ToastProvider;
