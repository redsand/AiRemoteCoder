import { useState, useRef, useEffect, useCallback, useMemo } from 'react';

export interface LogEvent {
  id: number;
  type: 'stdout' | 'stderr' | 'marker' | 'info' | 'error' | 'assist';
  data: string;
  timestamp: number;
  step_id?: string;
}

interface LiveLogViewerProps {
  events: LogEvent[];
  autoScroll?: boolean;
  onAutoScrollChange?: (enabled: boolean) => void;
  maxHeight?: string;
  searchTerm?: string;
}

const LINE_HEIGHT = 24;
const BUFFER_SIZE = 20;

// Color mapping for event types
const typeColors: Record<string, string> = {
  stdout: 'var(--text-primary)',
  stderr: 'var(--accent-red)',
  marker: 'var(--accent-purple)',
  info: 'var(--accent-blue)',
  error: 'var(--accent-red)',
  assist: 'var(--accent-green)',
};

export function LiveLogViewer({
  events,
  autoScroll = true,
  onAutoScrollChange,
  maxHeight = '60vh',
  searchTerm,
}: LiveLogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [localAutoScroll, setLocalAutoScroll] = useState(autoScroll);

  // Process events - collapse consecutive similar lines
  const processedEvents = useMemo(() => {
    const result: (LogEvent & { collapsed?: number; isError?: boolean })[] = [];
    let lastLine = '';
    let collapseCount = 0;

    for (const event of events) {
      // Detect errors
      const isError = event.type === 'stderr' ||
        event.type === 'error' ||
        /error|exception|failed|fatal/i.test(event.data);

      // Collapse repeated lines
      if (event.data === lastLine && event.type === 'stdout') {
        collapseCount++;
        if (result.length > 0) {
          result[result.length - 1].collapsed = collapseCount;
        }
        continue;
      }

      lastLine = event.data;
      collapseCount = 1;
      result.push({ ...event, isError });
    }

    return result;
  }, [events]);

  // Filter events by search term
  const filteredEvents = useMemo(() => {
    if (!searchTerm) return processedEvents;
    const term = searchTerm.toLowerCase();
    return processedEvents.filter(e => e.data.toLowerCase().includes(term));
  }, [processedEvents, searchTerm]);

  // Virtualization
  const totalHeight = filteredEvents.length * LINE_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - BUFFER_SIZE);
  const endIndex = Math.min(
    filteredEvents.length,
    Math.ceil((scrollTop + containerHeight) / LINE_HEIGHT) + BUFFER_SIZE
  );
  const visibleEvents = filteredEvents.slice(startIndex, endIndex);
  const offsetY = startIndex * LINE_HEIGHT;

  // Handle scroll
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    setScrollTop(scrollTop);

    // Check if user scrolled up manually
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    if (!isAtBottom && localAutoScroll) {
      setLocalAutoScroll(false);
      onAutoScrollChange?.(false);
    } else if (isAtBottom && !localAutoScroll) {
      setLocalAutoScroll(true);
      onAutoScrollChange?.(true);
    }
  }, [localAutoScroll, onAutoScrollChange]);

  // Update container height on resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (localAutoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filteredEvents.length, localAutoScroll]);

  // Find error indices for "jump to errors"
  const errorIndices = useMemo(() => {
    return filteredEvents
      .map((e, i) => e.isError ? i : -1)
      .filter(i => i !== -1);
  }, [filteredEvents]);

  const jumpToError = (index: number) => {
    if (containerRef.current && errorIndices[index] !== undefined) {
      containerRef.current.scrollTop = errorIndices[index] * LINE_HEIGHT;
      setLocalAutoScroll(false);
      onAutoScrollChange?.(false);
    }
  };

  const toggleAutoScroll = () => {
    const newValue = !localAutoScroll;
    setLocalAutoScroll(newValue);
    onAutoScrollChange?.(newValue);
    if (newValue && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  };

  return (
    <div
      className="log-viewer"
      style={{
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-color)',
        borderRadius: '8px',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border-color)',
          gap: '8px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '13px', fontWeight: 500 }}>Log Output</span>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {filteredEvents.length} lines
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {errorIndices.length > 0 && (
            <button
              onClick={() => jumpToError(0)}
              style={{
                padding: '4px 8px',
                fontSize: '11px',
                background: 'rgba(248, 81, 73, 0.15)',
                border: 'none',
                borderRadius: '4px',
                color: 'var(--accent-red)',
                cursor: 'pointer',
              }}
              aria-label={`Jump to errors (${errorIndices.length} found)`}
            >
              {errorIndices.length} errors
            </button>
          )}

          <button
            onClick={toggleAutoScroll}
            style={{
              padding: '4px 8px',
              fontSize: '11px',
              background: localAutoScroll ? 'rgba(59, 185, 80, 0.15)' : 'var(--bg-tertiary)',
              border: 'none',
              borderRadius: '4px',
              color: localAutoScroll ? 'var(--accent-green)' : 'var(--text-secondary)',
              cursor: 'pointer',
            }}
            aria-label={`Auto-scroll ${localAutoScroll ? 'enabled' : 'disabled'}`}
            aria-pressed={localAutoScroll}
          >
            Auto-scroll: {localAutoScroll ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* Log content with virtualization */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          height: maxHeight,
          maxHeight: maxHeight,
          overflowY: 'auto',
          overflowX: 'hidden',
          position: 'relative',
        }}
      >
        {/* Virtual scroll spacer */}
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              top: offsetY,
              left: 0,
              right: 0,
              fontFamily: "'Monaco', 'Menlo', 'Ubuntu Mono', monospace",
              fontSize: '13px',
              lineHeight: `${LINE_HEIGHT}px`,
            }}
          >
            {visibleEvents.length === 0 ? (
              <div
                style={{
                  padding: '24px',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontStyle: 'italic',
                }}
              >
                {events.length === 0
                  ? 'Waiting for output...'
                  : 'No matching lines found'}
              </div>
            ) : (
              visibleEvents.map((event, i) => (
                <LogLine
                  key={event.id}
                  event={event}
                  index={startIndex + i}
                  searchTerm={searchTerm}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface LogLineProps {
  event: LogEvent & { collapsed?: number; isError?: boolean };
  index: number;
  searchTerm?: string;
}

function LogLine({ event, index, searchTerm }: LogLineProps) {
  const color = typeColors[event.type] || 'var(--text-primary)';
  const isMarker = event.type === 'marker';
  const isAssist = event.type === 'assist';

  // Format marker content
  let content = event.data;
  if (isMarker) {
    try {
      const data = JSON.parse(event.data);
      content = `\u25B6 ${data.event?.toUpperCase() || event.data}`;
    } catch {
      content = `\u25B6 ${event.data}`;
    }
  } else if (isAssist) {
    try {
      const data = JSON.parse(event.data);
      content = `\uD83D\uDD17 Assist: ${data.url || event.data}`;
    } catch {
      content = `\uD83D\uDD17 ${event.data}`;
    }
  }

  // Highlight search term
  if (searchTerm && content.toLowerCase().includes(searchTerm.toLowerCase())) {
    const parts = content.split(new RegExp(`(${escapeRegExp(searchTerm)})`, 'gi'));
    content = parts.map((part) =>
      part.toLowerCase() === searchTerm.toLowerCase()
        ? `<mark style="background: rgba(210, 153, 34, 0.4); padding: 0 2px;">${part}</mark>`
        : part
    ).join('');
  }

  return (
    <div
      style={{
        display: 'flex',
        padding: '0 12px',
        height: LINE_HEIGHT,
        alignItems: 'center',
        color,
        fontWeight: isMarker || isAssist ? 600 : 400,
        background: event.isError ? 'rgba(248, 81, 73, 0.05)' : undefined,
      }}
    >
      <span
        style={{
          width: '48px',
          color: 'var(--text-muted)',
          fontSize: '11px',
          userSelect: 'none',
          flexShrink: 0,
        }}
      >
        {index + 1}
      </span>
      <span
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          flex: 1,
        }}
        dangerouslySetInnerHTML={searchTerm ? { __html: content } : undefined}
      >
        {!searchTerm ? content : undefined}
      </span>
      {event.collapsed && event.collapsed > 1 && (
        <span
          style={{
            marginLeft: '8px',
            padding: '2px 6px',
            fontSize: '10px',
            background: 'var(--bg-tertiary)',
            borderRadius: '3px',
            color: 'var(--text-muted)',
          }}
        >
          \u00D7{event.collapsed}
        </span>
      )}
    </div>
  );
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default LiveLogViewer;
