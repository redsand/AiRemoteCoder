import { useState, useCallback, ReactNode } from 'react';

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

interface FilterSelectProps {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
  icon?: string;
}

export function FilterSelect({ label, value, options, onChange, icon }: FilterSelectProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label
        style={{
          fontSize: '11px',
          fontWeight: 500,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}
      >
        {label}
      </label>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        {icon && (
          <span
            style={{
              position: 'absolute',
              left: '10px',
              fontSize: '14px',
              pointerEvents: 'none',
            }}
          >
            {icon}
          </span>
        )}
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            appearance: 'none',
            padding: icon ? '8px 32px 8px 32px' : '8px 32px 8px 12px',
            fontSize: '13px',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            minWidth: '120px',
          }}
          aria-label={label}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
              {opt.count !== undefined ? ` (${opt.count})` : ''}
            </option>
          ))}
        </select>
        <span
          style={{
            position: 'absolute',
            right: '10px',
            pointerEvents: 'none',
            fontSize: '10px',
            color: 'var(--text-secondary)',
          }}
        >
          \u25BC
        </span>
      </div>
    </div>
  );
}

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  debounceMs?: number;
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
  debounceMs = 300,
}: SearchInputProps) {
  const [localValue, setLocalValue] = useState(value);

  const debouncedOnChange = useCallback(
    debounce((val: string) => onChange(val), debounceMs),
    [onChange, debounceMs]
  );

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: '200px', maxWidth: '300px' }}>
      <span
        style={{
          position: 'absolute',
          left: '12px',
          top: '50%',
          transform: 'translateY(-50%)',
          fontSize: '14px',
          color: 'var(--text-muted)',
          pointerEvents: 'none',
        }}
      >
        \uD83D\uDD0D
      </span>
      <input
        type="text"
        value={localValue}
        onChange={(e) => {
          setLocalValue(e.target.value);
          debouncedOnChange(e.target.value);
        }}
        placeholder={placeholder}
        style={{
          width: '100%',
          padding: '8px 12px 8px 36px',
          fontSize: '13px',
          background: 'var(--bg-tertiary)',
          border: '1px solid var(--border-color)',
          borderRadius: '6px',
          color: 'var(--text-primary)',
        }}
        aria-label={placeholder}
      />
      {localValue && (
        <button
          onClick={() => {
            setLocalValue('');
            onChange('');
          }}
          style={{
            position: 'absolute',
            right: '8px',
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            padding: '4px',
            fontSize: '14px',
          }}
          aria-label="Clear search"
        >
          \u00D7
        </button>
      )}
    </div>
  );
}

interface FilterBarProps {
  children: ReactNode;
  onReset?: () => void;
  hasActiveFilters?: boolean;
}

export function FilterBar({ children, onReset, hasActiveFilters }: FilterBarProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: '8px',
        padding: '12px 16px',
        marginBottom: '16px',
      }}
    >
      {/* Mobile toggle */}
      <div
        className="filter-bar-toggle"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'none', // Shown via media query in CSS
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          padding: '4px 0',
        }}
      >
        <span style={{ fontSize: '14px', fontWeight: 500 }}>
          Filters
          {hasActiveFilters && (
            <span
              style={{
                marginLeft: '8px',
                padding: '2px 6px',
                fontSize: '11px',
                background: 'var(--accent-blue)',
                color: 'white',
                borderRadius: '10px',
              }}
            >
              Active
            </span>
          )}
        </span>
        <span style={{ fontSize: '12px' }}>{expanded ? '\u25B2' : '\u25BC'}</span>
      </div>

      {/* Filter content */}
      <div
        className="filter-bar-content"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '12px',
          alignItems: 'flex-end',
        }}
        data-expanded={expanded}
      >
        {children}
        {hasActiveFilters && onReset && (
          <button
            onClick={onReset}
            style={{
              padding: '8px 12px',
              fontSize: '12px',
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            Reset filters
          </button>
        )}
      </div>
    </div>
  );
}

// Debounce utility
function debounce<T extends (...args: any[]) => any>(func: T, wait: number): T {
  let timeout: NodeJS.Timeout;
  return ((...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  }) as T;
}

export default FilterBar;
