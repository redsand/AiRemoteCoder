import { useState, useRef, useEffect, useCallback } from 'react';

export interface LogEvent {
  id: number;
  type: 'stdout' | 'stderr' | 'marker' | 'info' | 'error' | 'assist' | 'prompt_waiting' | 'prompt_resolved' | 'tool_use';
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

export interface DisplayEvent {
  id: number;
  type: LogEvent['type'];
  data: string;
  timestamp: number;
  step_id?: string;
}

export interface FormattedLogEvent {
  content: string;
  emphasis: 'default' | 'info' | 'tool' | 'success' | 'warning' | 'error';
}

function commandExecutionLabel(item: any): string {
  const command = typeof item?.command === 'string' ? item.command.trim() : '';
  if (command) {
    return command.length > 80 ? `${command.slice(0, 77)}...` : command;
  }
  return 'commandExecution';
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
  tool_use: 'var(--accent-blue)',
};

function sanitizeContent(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
}

export function condenseLogEvents(events: LogEvent[]): DisplayEvent[] {
  const condensed: DisplayEvent[] = [];
  let buffer: DisplayEvent | null = null;
  let lineOffset = 0;

  const flushBuffer = () => {
    if (!buffer) return;
    const lines = sanitizeContent(buffer.data).split('\n').filter((line) => line !== '');
    if (lines.length === 0) {
      buffer = null;
      return;
    }
    lines.forEach((line, index) => {
      condensed.push({
        ...buffer!,
        id: buffer!.id + (index * 0.001),
        data: line,
      });
    });
    buffer = null;
  };

  for (const event of events) {
    if (event.type === 'stdout' || event.type === 'stderr') {
      if (buffer && buffer.type === event.type) {
        buffer.data += sanitizeContent(event.data);
      } else {
        flushBuffer();
        buffer = { ...event, data: sanitizeContent(event.data) };
      }
      continue;
    }

    flushBuffer();
    condensed.push({ ...event, data: sanitizeContent(event.data), id: event.id + (lineOffset * 0.001) });
    lineOffset += 1;
  }

  flushBuffer();
  return condensed;
}

export function formatLogEventDisplay(event: LogEvent | DisplayEvent): FormattedLogEvent {
  if (event.type === 'marker') {
    try {
      const data = JSON.parse(event.data);
      return {
        content: `▶ ${data.event?.toUpperCase() || event.data}`,
        emphasis: data.event === 'finished' ? 'success' : 'info',
      };
    } catch {
      return { content: `▶ ${event.data}`, emphasis: 'info' };
    }
  }

  if (event.type === 'assist') {
    try {
      const data = JSON.parse(event.data);
      return { content: `Assist session: ${data.url || event.data}`, emphasis: 'success' };
    } catch {
      return { content: `Assist session: ${event.data}`, emphasis: 'success' };
    }
  }

  if (event.type === 'tool_use') {
    try {
      const data = JSON.parse(event.data);
      if (data.phase === 'pre') {
        return { content: `Tool call started: ${data.tool}`, emphasis: 'tool' };
      }
      return { content: `Tool call finished: ${data.tool}`, emphasis: 'success' };
    } catch {
      return { content: event.data, emphasis: 'tool' };
    }
  }

  if (event.type === 'info') {
    try {
      const payload = JSON.parse(event.data);
      const method = payload?.method;
      const params = payload?.params ?? {};
      const item = params?.item ?? {};
      if (method === 'turn/started') {
        return { content: 'Codex turn started', emphasis: 'info' };
      }
      if (method === 'turn/completed') {
        return {
          content: params?.turn?.status === 'failed' ? 'Codex turn failed' : 'Codex turn completed',
          emphasis: params?.turn?.status === 'failed' ? 'error' : 'success',
        };
      }
      if (method === 'thread/status/changed') {
        const statusType = params?.status?.type;
        if (typeof statusType === 'string' && statusType.length > 0) {
          return {
            content: `Codex thread ${statusType}`,
            emphasis: statusType === 'errored' ? 'error' : 'info',
          };
        }
        return { content: 'Codex thread status changed', emphasis: 'info' };
      }
      if (method === 'item/started' && item?.type === 'commandExecution') {
        return { content: `Tool call started: ${commandExecutionLabel(item)}`, emphasis: 'tool' };
      }
      if (method === 'item/completed' && item?.type === 'commandExecution') {
        return {
          content: item?.status === 'failed'
            ? `Tool call failed: ${commandExecutionLabel(item)}`
            : `Tool call finished: ${commandExecutionLabel(item)}`,
          emphasis: item?.status === 'failed' ? 'error' : 'success',
        };
      }
      if (method === 'item/started' && item?.type === 'reasoning') {
        return { content: 'Codex is reasoning', emphasis: 'info' };
      }
      if (method === 'item/started' && item?.type === 'userMessage') {
        return { content: 'Prompt delivered to Codex', emphasis: 'info' };
      }
      if (method === 'item/completed' && item?.type === 'reasoning') {
        return { content: 'Codex reasoning step finished', emphasis: 'default' };
      }
      if (method === 'item/completed' && item?.type === 'userMessage') {
        return { content: 'Prompt accepted by Codex', emphasis: 'success' };
      }
      if (method === 'item/started' && item?.type === 'agentMessage') {
        return { content: 'Codex is composing a response', emphasis: 'info' };
      }
      if (method === 'item/completed' && item?.type === 'agentMessage') {
        return { content: 'Codex response segment finished', emphasis: 'success' };
      }
      if (method === 'thread/started') {
        return { content: 'Codex thread started', emphasis: 'info' };
      }
      if (method === 'account/rateLimits/updated') {
        return { content: 'Codex rate limits updated', emphasis: 'default' };
      }
      if (method === 'thread/tokenUsage/updated') {
        return { content: 'Codex token usage updated', emphasis: 'default' };
      }
    } catch {
      // fall through
    }
  }

  if (event.type === 'stderr' || event.type === 'error' || /error|failed/i.test(event.data)) {
    return { content: event.data, emphasis: 'error' };
  }

  return { content: event.data, emphasis: 'default' };
}

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
  const processedEvents = condenseLogEvents(events);

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
  const formatted = formatLogEventDisplay(event);
  const content = formatted.content;
  const isError = formatted.emphasis === 'error';
  const color = formatted.emphasis === 'success'
    ? 'var(--accent-green)'
    : formatted.emphasis === 'tool'
      ? 'var(--accent-blue)'
      : formatted.emphasis === 'info'
        ? 'var(--accent-purple)'
        : formatted.emphasis === 'warning'
          ? 'var(--accent-yellow)'
          : (typeColors[event.type] || 'var(--text-primary)');

  // Highlight search term
  if (searchTerm && content.toLowerCase().includes(searchTerm.toLowerCase())) {
    const regex = new RegExp(`(${escapeRegExp(searchTerm)})`, 'gi');
    const parts = content.split(regex);

    return (
      <div
        style={{
        padding: '4px 8px',
        color,
        fontWeight: formatted.emphasis === 'info' || formatted.emphasis === 'tool' || formatted.emphasis === 'success' ? 600 : 400,
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
        fontWeight: formatted.emphasis === 'info' || formatted.emphasis === 'tool' || formatted.emphasis === 'success' ? 600 : 400,
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
