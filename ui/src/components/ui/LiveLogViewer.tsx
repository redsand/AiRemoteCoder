import { useState, useRef, useEffect, useCallback } from 'react';

export interface LogEvent {
  id: number;
  type: 'stdout' | 'stderr' | 'marker' | 'info' | 'error' | 'assist' | 'prompt_waiting' | 'prompt_resolved';
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

// Color mapping for event types
const typeColors: Record<string, string> = {
  stdout: 'var(--text-primary)',
  stderr: 'var(--accent-red)',
  marker: 'var(--accent-purple)',
  info: 'var(--accent-blue)',
  error: 'var(--accent-red)',
  assist: 'var(--accent-green)',
  prompt_waiting: 'var(--accent-purple)',
  prompt_resolved: 'var(--accent-green)',
};

export function LiveLogViewer({
  events,
  autoScroll = true,
  onAutoScrollChange,
  maxHeight = '60vh',
  searchTerm,
}: LiveLogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [localAutoScroll, setLocalAutoScroll] = useState(autoScroll);
  const [copyFeedback, setCopyFeedback] = useState(false);

  // Sanitize content - remove control characters and carriage returns
  const sanitizeContent = (text: string): string => {
    return text
      .replace(/\r/g, '') // Remove carriage returns
      .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, ''); // Remove other control chars
  };

  // Split multi-line stdout/stderr events into individual lines
  const processedEvents = events.flatMap((event) => {
    if (event.type === 'stdout' || event.type === 'stderr') {
      const lines = sanitizeContent(event.data).split('\n').filter(line => line !== '');
      return lines.map((line, idx) => ({
        ...event,
        data: line,
        id: event.id + idx * 0.1, // Keep related events grouped
      }));
    }
    return [{ ...event, data: sanitizeContent(event.data) }];
  });

  // Filter by search term
  const filteredEvents = searchTerm
    ? processedEvents.filter(e =>
        e.data.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : processedEvents;

  // Handle scroll
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;

    const { scrollHeight, scrollTop, clientHeight } = containerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;

    if (!isAtBottom && localAutoScroll) {
      setLocalAutoScroll(false);
      onAutoScrollChange?.(false);
    }
  }, [localAutoScroll, onAutoScrollChange]);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (!localAutoScroll || !contentRef.current) return;

    // Use requestAnimationFrame to ensure layout is complete
    const animationId = requestAnimationFrame(() => {
      if (containerRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }
    });

    return () => cancelAnimationFrame(animationId);
  }, [filteredEvents.length, localAutoScroll]);

  const toggleAutoScroll = () => {
    const newValue = !localAutoScroll;
    setLocalAutoScroll(newValue);
    onAutoScrollChange?.(newValue);

    if (newValue && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  };

  // Copy log to clipboard
  const copyToClipboard = async () => {
    const allText = filteredEvents
      .map((event) => event.data)
      .join('\n');

    try {
      await navigator.clipboard.writeText(allText);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const errorCount = filteredEvents.filter(e =>
    e.type === 'stderr' || e.type === 'error' || /error|failed|exception/i.test(e.data)
  ).length;

  return (
    <div
      className="log-viewer"
      style={{
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-color)',
        borderRadius: '8px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
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
          {errorCount > 0 && (
            <span
              style={{
                padding: '4px 8px',
                fontSize: '11px',
                background: 'rgba(248, 81, 73, 0.15)',
                borderRadius: '4px',
                color: 'var(--accent-red)',
              }}
            >
              {errorCount} errors
            </span>
          )}

          <button
            onClick={copyToClipboard}
            style={{
              padding: '4px 8px',
              fontSize: '11px',
              background: copyFeedback ? 'rgba(59, 185, 80, 0.15)' : 'var(--bg-tertiary)',
              border: 'none',
              borderRadius: '4px',
              color: copyFeedback ? 'var(--accent-green)' : 'var(--text-secondary)',
              cursor: 'pointer',
              transition: 'all 0.3s ease',
            }}
            title="Copy all log output to clipboard"
          >
            {copyFeedback ? '✓ Copied' : '📋 Copy'}
          </button>

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
            title={localAutoScroll ? 'Disable auto-scroll' : 'Enable auto-scroll'}
          >
            Auto-scroll: {localAutoScroll ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* Log content */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          maxHeight: maxHeight,
          overflowY: 'auto',
          overflowX: 'hidden',
          fontFamily: "'Monaco', 'Menlo', 'Ubuntu Mono', monospace",
          fontSize: '13px',
          lineHeight: '1.5',
        }}
      >
        <div ref={contentRef} style={{ padding: '12px' }}>
          {filteredEvents.length === 0 ? (
            <div
              style={{
                padding: '24px',
                textAlign: 'center',
                color: 'var(--text-muted)',
                fontStyle: 'italic',
              }}
            >
              {events.length === 0 ? 'Waiting for output...' : 'No matching lines found'}
            </div>
          ) : (
            filteredEvents.map((event) => (
              <LogLine key={event.id} event={event} searchTerm={searchTerm} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

interface LogLineProps {
  event: LogEvent;
  searchTerm?: string;
}

function LogLine({ event, searchTerm }: LogLineProps) {
  const color = typeColors[event.type] || 'var(--text-primary)';
  const isMarker = event.type === 'marker';
  const isAssist = event.type === 'assist';
  const isError = event.type === 'stderr' || event.type === 'error' || /error|failed/i.test(event.data);

  let content = event.data;

  if (isMarker) {
    try {
      const data = JSON.parse(event.data);
      content = `▶ ${data.event?.toUpperCase() || event.data}`;
    } catch {
      content = `▶ ${event.data}`;
    }
  } else if (isAssist) {
    try {
      const data = JSON.parse(event.data);
      content = `🔗 Assist: ${data.url || event.data}`;
    } catch {
      content = `🔗 ${event.data}`;
    }
  }

  // Highlight search term
  if (searchTerm && content.toLowerCase().includes(searchTerm.toLowerCase())) {
    const regex = new RegExp(`(${escapeRegExp(searchTerm)})`, 'gi');
    const parts = content.split(regex);

    return (
      <div
        style={{
          padding: '4px 8px',
          color,
          fontWeight: isMarker || isAssist ? 600 : 400,
          background: isError ? 'rgba(248, 81, 73, 0.05)' : undefined,
          marginBottom: '2px',
        }}
      >
        {parts.map((part, idx) =>
          part.toLowerCase() === searchTerm.toLowerCase() ? (
            <mark
              key={idx}
              style={{
                background: 'rgba(210, 153, 34, 0.4)',
                padding: '0 2px',
                borderRadius: '2px',
              }}
            >
              {part}
            </mark>
          ) : (
            part
          )
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        padding: '4px 8px',
        color,
        fontWeight: isMarker || isAssist ? 600 : 400,
        background: isError ? 'rgba(248, 81, 73, 0.05)' : undefined,
        marginBottom: '2px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {content}
    </div>
  );
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default LiveLogViewer;
