import { ReactNode } from 'react';

interface ActionBarProps {
  children: ReactNode;
  visible?: boolean;
}

export function ActionBar({ children, visible = true }: ActionBarProps) {
  if (!visible) return null;

  return (
    <>
      {/* Spacer to prevent content from being hidden behind action bar */}
      <div style={{ height: '80px' }} />

      <div
        className="action-bar"
        style={{
          position: 'fixed',
          bottom: '56px', // Above bottom nav on mobile
          left: 0,
          right: 0,
          padding: '12px 16px',
          background: 'var(--bg-secondary)',
          borderTop: '1px solid var(--border-color)',
          display: 'flex',
          gap: '8px',
          justifyContent: 'center',
          alignItems: 'center',
          flexWrap: 'wrap',
          zIndex: 90,
          boxShadow: '0 -4px 12px rgba(0, 0, 0, 0.2)',
        }}
      >
        {children}
      </div>
    </>
  );
}

// Desktop-friendly action buttons group
interface ActionButtonProps {
  onClick: () => void;
  disabled?: boolean;
  variant?: 'default' | 'primary' | 'danger';
  icon?: string;
  children: ReactNode;
  fullWidth?: boolean;
}

export function ActionButton({
  onClick,
  disabled = false,
  variant = 'default',
  icon,
  children,
  fullWidth = false,
}: ActionButtonProps) {
  const variantStyles = {
    default: {
      background: 'var(--bg-tertiary)',
      borderColor: 'var(--border-color)',
      color: 'var(--text-primary)',
    },
    primary: {
      background: 'var(--accent-blue)',
      borderColor: 'var(--accent-blue)',
      color: 'white',
    },
    danger: {
      background: 'var(--accent-red)',
      borderColor: 'var(--accent-red)',
      color: 'white',
    },
  };

  const style = variantStyles[variant];

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        padding: '10px 16px',
        minWidth: '44px', // Touch target
        minHeight: '44px', // Touch target
        fontSize: '14px',
        fontWeight: 500,
        border: `1px solid ${style.borderColor}`,
        borderRadius: '8px',
        background: style.background,
        color: style.color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'all 0.15s ease',
        flex: fullWidth ? 1 : undefined,
      }}
      aria-disabled={disabled}
    >
      {icon && <span style={{ fontSize: '16px' }}>{icon}</span>}
      {children}
    </button>
  );
}

export default ActionBar;
