import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  StatusPill,
  ConnectionIndicator,
  LiveLogViewer,
  Modal,
  ConfirmModal,
  useToast,
  type LogEvent,
} from '../components/ui';
import { VncViewer } from '../components/VncViewer';
import { PendingRunnerPanel } from '../components/runs/PendingRunnerPanel';
import { XTermConsole } from '../components/runs/XTermConsole';
import { useVncConnection } from '../hooks/useVncConnection';
import { summarizeRunActivity } from '../features/runs/activity';
import { buildRunChangeReport } from '../features/runs/changes';
import { loadAllRunEvents } from '../features/runs/event-replay';
import { shouldPollPendingRun } from '../features/runs/refresh';
import { buildRunConnectivitySummary } from '../features/runs/connectivity';
import type { McpActiveSession } from '../features/mcp/types';

interface RunMetadata {
  mcpRunnerId?: string | null;
  mcpSessionId?: string | null;
  [key: string]: unknown;
}

interface Run {
  id: string;
  status: string;
  label: string | null;
  command: string | null;
  repo_path: string | null;
  repo_name: string | null;
  waiting_approval: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  error_message: string | null;
  artifacts: Artifact[];
  commands: Command[];
  assistUrl: string | null;
  duration: number | null;
  claimed_by?: string | null;
  claimed_at?: number | null;
  worker_type?: string | null;
  metadata?: RunMetadata | null;
  task_preview?: string | null;
  event_cwd?: string | null;
}

interface Artifact {
  id: string;
  name: string;
  type: string;
  size: number;
  created_at: number;
}

interface Command {
  id: string;
  command: string;
  arguments?: string | null;
  status: string;
  created_at: number;
  acked_at: number | null;
  result: string | null;
  error: string | null;
}

interface Props {
  user: { id: string; username: string; role: string } | null;
}

const ALLOWED_COMMANDS = [
  'npm test',
  'npm run build',
  'npm run lint',
  'git diff',
  'git status',
  'git log --oneline -10',
  // Directory navigation
  'cd',
  'ls',
  'ls -la',
  'ls -l',
  'ls -a',
  'll',
  'dir',
  'pwd',
];

type Tab = 'log' | 'timeline' | 'changes' | 'artifacts' | 'commands' | 'setup' | 'vnc' | 'console';

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

export function RunDetail({ user }: Props) {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { addToast } = useToast();

  // State
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [activeMcpSessions, setActiveMcpSessions] = useState<McpActiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('log');

  // Prompt waiting state
  const [promptWaiting, setPromptWaiting] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [keyboardInput, setKeyboardInput] = useState('');
  const [keyboardHistory, setKeyboardHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [sendLoading, setSendLoading] = useState(false);

  // Modals
  const [showCommandModal, setShowCommandModal] = useState(false);
  const [selectedCommand, setSelectedCommand] = useState('');
  const [showPromptModal, setShowPromptModal] = useState(false);
  const [promptInput, setPromptInput] = useState('');
  const [promptHistory, setPromptHistory] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`promptHistory_${runId}`) || '[]'); } catch { return []; }
  });
  const [reviewedPrompt, setReviewedPrompt] = useState<string | null>(null);
  const [reviewReasoning, setReviewReasoning] = useState<string | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<'original' | 'improved'>('improved');
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [showReleaseConfirm, setShowReleaseConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [commandLoading, setCommandLoading] = useState(false);
  const [promptLoading, setPromptLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  // Orchestrator settings
  const [orchestratorSettings, setOrchestratorSettings] = useState<{
    enabled: boolean;
    provider: 'ollama' | 'anthropic' | 'zencoder';
    model: string;
    ollamaHost: string;
    anthropicApiKey?: string;
    zencoderAccessCode?: string;
    zencoderSecretKey?: string;
  } | null>(null);
  const [orchSaving, setOrchSaving] = useState(false);
  const [userApiKeys, setUserApiKeys] = useState<{
    hasAnthropicApiKey: boolean;
    hasZencoderAccessCode: boolean;
    hasZencoderSecretKey: boolean;
  } | null>(null);

  // Detect mobile/responsive changes
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const lastEventId = useRef(0);
  const reconnectTimeout = useRef<NodeJS.Timeout>();
  const keyboardInputRef = useRef<HTMLInputElement>(null);

  const canOperate = user?.role === 'admin' || user?.role === 'operator';
  const canDelete = user?.role === 'admin';
  const isActive = run?.status === 'running';
  const isVncRun = run?.worker_type === 'vnc';

  const {
    vncInfo,
    vncAvailable,
    vncReady,
    vncError,
    isLoading: vncLoading,
    startVnc,
    stopVnc,
  } = useVncConnection({
    runId: runId || '',
    pollInterval: 2000,
    autoStart: false,
  });
  const isPending = run?.status === 'pending';
  const changedFiles = buildRunChangeReport(events);

  // Fetch run details
  const fetchRun = useCallback(async () => {
    try {
      const res = await fetch(`/api/runs/${runId}`);
      if (res.ok) {
        const data = await res.json();
        setRun(data);
      } else if (res.status === 404) {
        navigate('/runs', { replace: true });
        addToast('error', 'Run not found');
      }
    } catch (err) {
      console.error('Failed to fetch run:', err);
    } finally {
      setLoading(false);
    }
  }, [runId, navigate, addToast]);

  // Fetch events
  const fetchEvents = useCallback(async () => {
    try {
      if (!runId) return;
      const allEvents = await loadAllRunEvents(runId);
      setEvents(allEvents);
      if (allEvents.length > 0) {
        lastEventId.current = allEvents[allEvents.length - 1].id;
      }
    } catch (err) {
      console.error('Failed to fetch events:', err);
    }
  }, [runId]);

  const fetchMcpSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/mcp/sessions');
      if (res.ok) {
        const data = await res.json();
        setActiveMcpSessions(Array.isArray(data.sessions) ? data.sessions : []);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchOrchestratorSettings = useCallback(async () => {
    if (!runId) return;
    try {
      const [orchRes, keysRes] = await Promise.all([
        fetch(`/api/runs/${runId}/orchestrator`),
        fetch('/api/auth/me/api-keys'),
      ]);
      if (orchRes.ok) setOrchestratorSettings(await orchRes.json());
      if (keysRes.ok) setUserApiKeys(await keysRes.json());
    } catch { /* ignore */ }
  }, [runId]);

  const saveOrchestratorSettings = useCallback(async (updates: Partial<typeof orchestratorSettings>) => {
    if (!runId) return;
    setOrchSaving(true);
    try {
      const res = await fetch(`/api/runs/${runId}/orchestrator`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (res.ok) setOrchestratorSettings(await res.json());
    } catch { /* ignore */ } finally {
      setOrchSaving(false);
    }
  }, [runId, orchestratorSettings]);

  // Connect WebSocket
  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      setConnected(true);
      setReconnecting(false);
      ws.send(JSON.stringify({ type: 'subscribe', runId }));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        switch (data.type) {
          case 'event':
            setEvents(prev => [
              ...prev,
              {
                id: data.eventId,
                type: data.eventType,
                data: data.data,
                timestamp: data.timestamp,
              },
            ]);
            lastEventId.current = data.eventId;

            // Handle prompt events
            if (data.eventType === 'prompt_waiting') {
              setPromptWaiting(true);
              setPromptText(data.data);
              // Focus keyboard input
              setTimeout(() => keyboardInputRef.current?.focus(), 100);
            } else if (data.eventType === 'prompt_resolved') {
              setPromptWaiting(false);
              setPromptText('');
            }
            break;

          case 'command_completed':
          case 'artifact_uploaded':
            fetchRun();
            break;
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setReconnecting(true);
      // Reconnect with backoff
      reconnectTimeout.current = setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
      setConnected(false);
    };

    wsRef.current = ws;
  }, [runId, fetchRun]);

  // Initial fetch and WebSocket setup
  useEffect(() => {
    fetchRun();
    fetchEvents();
    fetchMcpSessions();
    fetchOrchestratorSettings();
    connectWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
    };
  }, [runId]);

  useEffect(() => {
    if (!shouldPollPendingRun(run?.status)) {
      return;
    }

    const interval = setInterval(() => {
      fetchRun();
    }, 3000);

    return () => clearInterval(interval);
  }, [fetchRun, run?.status]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchMcpSessions();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchMcpSessions]);

  // Auto-switch to VNC tab for VNC runs once run data loads
  useEffect(() => {
    if (isVncRun) {
      setActiveTab('vnc');
    }
  }, [isVncRun]);

  // Request browser notification permission once
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Fire browser notification when run finishes
  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevStatusRef.current;
    const curr = run?.status ?? null;
    if (prev && prev !== curr && (curr === 'done' || curr === 'failed')) {
      if ('Notification' in window && Notification.permission === 'granted') {
        const title = curr === 'done' ? `✅ Run ${runId} completed` : `❌ Run ${runId} failed`;
        const body = run?.label || run?.command?.slice(0, 80) || '';
        new Notification(title, { body, icon: '/favicon.ico' });
      }
    }
    prevStatusRef.current = curr;
  }, [run?.status, run?.label, run?.command, runId]);

  // Send command
  const sendCommand = async () => {
    if (!selectedCommand) return;

    setCommandLoading(true);
    try {
      const res = await fetch(`/api/runs/${runId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: selectedCommand }),
      });
      if (res.ok) {
        addToast('success', 'Command queued');
        setShowCommandModal(false);
        setSelectedCommand('');
        fetchRun();
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to send command');
      }
    } catch (err) {
      addToast('error', 'Failed to send command');
    } finally {
      setCommandLoading(false);
    }
  };

  // Send prompt/input
  const sendPrompt = async () => {
    const textToSend = reviewedPrompt && selectedVersion === 'improved' ? reviewedPrompt : promptInput;
    if (!textToSend.trim()) return;

    setPromptLoading(true);
    try {
      const res = await fetch(`/api/runs/${runId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: textToSend + '\n', escape: false }),
      });
      if (res.ok) {
        addToast('success', 'Prompt sent');
        setShowPromptModal(false);
        const saved = [textToSend, ...promptHistory.filter(p => p !== textToSend)].slice(0, 10);
        setPromptHistory(saved);
        localStorage.setItem(`promptHistory_${runId}`, JSON.stringify(saved));
        setPromptInput('');
        setReviewedPrompt(null);
        setReviewReasoning(null);
        setSelectedVersion('improved');
        fetchRun();
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to send prompt');
      }
    } catch (err) {
      addToast('error', 'Failed to send prompt');
    } finally {
      setPromptLoading(false);
    }
  };

  const reviewPrompt = async () => {
    if (!promptInput.trim()) return;
    setReviewLoading(true);
    try {
      const res = await fetch('/api/prompt-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: promptInput }),
      });
      if (res.ok) {
        const data = await res.json();
        setReviewedPrompt(data.improved);
        setReviewReasoning(data.reasoning);
        setSelectedVersion('improved');
      } else {
        addToast('error', 'Prompt review unavailable');
      }
    } catch {
      addToast('error', 'Prompt review unavailable');
    } finally {
      setReviewLoading(false);
    }
  };

  // Stop run
  const stopRun = async () => {
    try {
      const res = await fetch(`/api/runs/${runId}/stop`, { method: 'POST' });
      if (res.ok) {
        addToast('success', 'Stop requested');
        setShowStopConfirm(false);
        fetchRun();
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to stop run');
      }
    } catch (err) {
      addToast('error', 'Failed to stop run');
    }
  };

  // Delete run
  const deleteRun = async () => {
    setDeleteLoading(true);
    try {
      const res = await fetch(`/api/runs/${runId}`, { method: 'DELETE' });
      if (res.ok) {
        addToast('success', 'Run deleted successfully');
        setShowDeleteConfirm(false);
        navigate('/runs', { replace: true });
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to delete run');
      }
    } catch (err) {
      addToast('error', 'Failed to delete run');
    } finally {
      setDeleteLoading(false);
    }
  };

  // Release claim
  const releaseRun = async () => {
    try {
      const res = await fetch(`/api/runs/${runId}/release`, { method: 'POST' });
      if (res.ok) {
        addToast('success', 'Claim released');
        setShowReleaseConfirm(false);
        fetchRun();
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to release claim');
      }
    } catch (err) {
      addToast('error', 'Failed to release claim');
    }
  };

  // Send keyboard input
  const sendKeyboardInput = async () => {
    if (!keyboardInput.trim()) return;

    setSendLoading(true);
    const input = keyboardInput + '\n'; // Always append newline

    try {
      const res = await fetch(`/api/runs/${runId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, escape: false }),
      });
      if (res.ok) {
        // Add to history
        setKeyboardHistory(prev => [...prev, keyboardInput].slice(-50));
        setHistoryIndex(-1);
        setKeyboardInput('');
        addToast('success', 'Input sent');
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to send input');
      }
    } catch (err) {
      addToast('error', 'Failed to send input');
    } finally {
      setSendLoading(false);
      keyboardInputRef.current?.focus();
    }
  };

  // Handle keyboard history (up/down arrows)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const newIndex = Math.min(historyIndex + 1, keyboardHistory.length - 1);
      if (newIndex >= 0 && keyboardHistory[keyboardHistory.length - 1 - newIndex]) {
        setHistoryIndex(newIndex);
        setKeyboardInput(keyboardHistory[keyboardHistory.length - 1 - newIndex]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const newIndex = Math.max(historyIndex - 1, -1);
      setHistoryIndex(newIndex);
      if (newIndex === -1) {
        setKeyboardInput('');
      } else if (keyboardHistory[keyboardHistory.length - 1 - newIndex]) {
        setKeyboardInput(keyboardHistory[keyboardHistory.length - 1 - newIndex]);
      }
    }
  };

  // Quick response shortcuts
  const sendQuickResponse = async (response: 'y' | 'n' | 'yes' | 'no' | 'enter') => {
    const input = response === 'enter' ? '\n' : response + '\n';
    try {
      const res = await fetch(`/api/runs/${runId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, escape: false }),
      });
      if (res.ok) {
        addToast('success', `Sent: ${response}`);
      } else {
        const error = await res.json();
        addToast('error', error.error || 'Failed to send input');
      }
    } catch (err) {
      addToast('error', 'Failed to send input');
    }
    keyboardInputRef.current?.focus();
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="empty-state">
        <h2>Run not found</h2>
        <Link to="/runs" className="btn">
          Back to runs
        </Link>
      </div>
    );
  }

  const displayTitle = run.label || run.command?.slice(0, 60) || run.task_preview?.slice(0, 80) || `Run ${run.id}`;
  const repoPath = run.repo_path || run.event_cwd;
  const repoDisplay = repoPath
    ? repoPath.replace(/\\/g, '/').replace(/\/$/, '').split('/').slice(-2).join('/')
    : null;
  const pendingCommandCount = run.commands.filter((command) => command.status !== 'completed').length;
  const activity = summarizeRunActivity(run.status, events, pendingCommandCount);
  const connectivity = buildRunConnectivitySummary(run, activeMcpSessions, connected, reconnecting);
  const activityTone = activity.tone === 'error'
    ? { border: 'var(--accent-red)', bg: 'rgba(248, 81, 73, 0.12)', text: 'var(--accent-red)' }
    : activity.tone === 'success'
      ? { border: 'var(--accent-green)', bg: 'rgba(59, 185, 80, 0.12)', text: 'var(--accent-green)' }
      : activity.tone === 'warning'
        ? { border: 'var(--accent-yellow)', bg: 'rgba(210, 153, 34, 0.12)', text: 'var(--accent-yellow)' }
        : activity.tone === 'info'
          ? { border: 'var(--accent-blue)', bg: 'rgba(47, 129, 247, 0.12)', text: 'var(--accent-blue)' }
          : { border: 'var(--border-color)', bg: 'var(--bg-secondary)', text: 'var(--text-primary)' };

  return (
    <div className="run-detail">
      {/* Header with Action Buttons in Top Right */}
      <div className="run-header">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <Link to="/runs" className="btn btn-sm">
              ← Back
            </Link>
            <StatusPill status={run.status as any} />
            <ConnectionIndicator connected={connected} reconnecting={reconnecting} label="Stream" />
          </div>

          {/* Action Buttons - Top Right */}
          {canOperate && (isActive || canDelete || (isPending && run?.claimed_by)) && !isMobile && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {isActive && (
                <>
                  <button
                    className="btn btn-sm"
                    onClick={() => setShowStopConfirm(true)}
                    style={{ background: 'var(--accent-red)', color: 'white' }}
                    title="Stop the running process"
                  >
                    ⏹ Stop
                  </button>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => setShowPromptModal(true)}
                    title="Send a prompt to the process"
                  >
                    💬 Send Prompt
                  </button>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => setShowCommandModal(true)}
                    title="Run a command"
                  >
                    ▶ Command
                  </button>
                </>
              )}
              {isPending && run?.claimed_by && (
                <button
                  className="btn btn-sm"
                  onClick={() => setShowReleaseConfirm(true)}
                  style={{ background: 'var(--accent-yellow)', color: 'white' }}
                  title="Release the claim so another runner can pick it up"
                >
                  ↩ Release Claim
                </button>
              )}
              <button
                className="btn btn-sm"
                onClick={() => navigate(`/runs?clone=${runId}`)}
                title="Clone this run"
              >
                ⧉ Clone
              </button>
              {canDelete && (
                <button
                  className="btn btn-sm"
                  onClick={() => setShowDeleteConfirm(true)}
                  style={{ background: 'var(--accent-red)', color: 'white' }}
                  title="Delete this run"
                >
                  🗑 Delete
                </button>
              )}
            </div>
          )}

          {/* Mobile: Dropdown menu */}
          {canOperate && (isActive || canDelete || (isPending && run?.claimed_by)) && isMobile && (
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => setShowActionMenu(!showActionMenu)}
                title="Action menu"
              >
                ⋮
              </button>
              {showActionMenu && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    minWidth: '140px',
                    zIndex: 1000,
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
                    marginTop: '4px',
                  }}
                >
                  {isActive && (
                    <>
                      <button
                        onClick={() => {
                          setShowStopConfirm(true);
                          setShowActionMenu(false);
                        }}
                        style={{
                          display: 'block',
                          width: '100%',
                          padding: '10px 12px',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          textAlign: 'left',
                          color: 'var(--text-primary)',
                          fontSize: '13px',
                          borderBottom: '1px solid var(--border-color)',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                      >
                        ⏹ Stop
                      </button>
                      <button
                        onClick={() => {
                          setShowPromptModal(true);
                          setShowActionMenu(false);
                        }}
                        style={{
                          display: 'block',
                          width: '100%',
                          padding: '10px 12px',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          textAlign: 'left',
                          color: 'var(--text-primary)',
                          fontSize: '13px',
                          borderBottom: '1px solid var(--border-color)',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                      >
                        💬 Prompt
                      </button>
                      <button
                        onClick={() => {
                          setShowCommandModal(true);
                          setShowActionMenu(false);
                        }}
                        style={{
                          display: 'block',
                          width: '100%',
                          padding: '10px 12px',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          textAlign: 'left',
                          color: 'var(--text-primary)',
                          fontSize: '13px',
                          borderBottom: '1px solid var(--border-color)',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                      >
                        ▶ Command
                      </button>
                    </>
                  )}
                  {isPending && run?.claimed_by && (
                    <button
                      onClick={() => {
                        setShowReleaseConfirm(true);
                        setShowActionMenu(false);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        padding: '10px 12px',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        color: 'var(--text-primary)',
                        fontSize: '13px',
                        borderBottom: canDelete ? '1px solid var(--border-color)' : 'none',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                    >
                      ↩ Release Claim
                    </button>
                  )}
                  {canDelete && (
                    <button
                      onClick={() => {
                        setShowDeleteConfirm(true);
                        setShowActionMenu(false);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        padding: '10px 12px',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        color: 'var(--accent-red)',
                        fontSize: '13px',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                    >
                      🗑 Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {repoDisplay && (
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span>📁</span>
            <Link to={`/runs?repo=${encodeURIComponent(repoPath!)}`} style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>
              {repoDisplay}
            </Link>
          </div>
        )}

        <h1 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>
          {displayTitle}
        </h1>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '16px',
            fontSize: '13px',
            color: 'var(--text-secondary)',
          }}
        >
          <span>
            <strong>ID:</strong> <code>{run.id}</code>
          </span>
          {run.duration && (
            <span>
              <strong>Duration:</strong> {formatDuration(run.duration)}
            </span>
          )}
          {run.claimed_by && (() => {
            const cb = run.claimed_by!;
            const claimedAt = run.claimed_at ? ` · ${formatTime(run.claimed_at)}` : '';
            let display: string;
            if (cb.startsWith('mcp-runner:') || cb.startsWith('mcp:')) {
              const parts = cb.split(':');
              const shortId = parts[parts.length - 1]?.slice(-6) ?? '';
              display = `MCP ···${shortId}${claimedAt}`;
            } else {
              const short = cb.length > 20 ? `${cb.slice(0, 8)}···${cb.slice(-6)}` : cb;
              display = `${short}${claimedAt}`;
            }
            return (
              <span title={cb}>
                <strong>Claimed By:</strong> {display}
              </span>
            );
          })()}
        </div>
      </div>

      {/* Assist Session Banner */}
      {run.assistUrl && (
        <div
          style={{
            padding: '12px 16px',
            background: 'rgba(59, 185, 80, 0.1)',
            border: '1px solid var(--accent-green)',
            borderRadius: '8px',
            marginBottom: '16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span style={{ fontSize: '16px' }}>🔗</span>
            <strong style={{ color: 'var(--accent-green)' }}>Assist Session Active</strong>
          </div>
          <a
            href={run.assistUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontFamily: 'monospace',
              fontSize: '13px',
              color: 'var(--accent-blue)',
              wordBreak: 'break-all',
            }}
          >
            {run.assistUrl}
          </a>
        </div>
      )}

      <div
        style={{
          padding: '14px 16px',
          background: activityTone.bg,
          border: `1px solid ${activityTone.border}`,
          borderRadius: '8px',
          marginBottom: '16px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: activityTone.text }}>
              Current Activity
            </div>
            <div style={{ fontSize: '16px', fontWeight: 600, marginTop: '4px' }}>
              {activity.title}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              {activity.detail}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ minWidth: '120px' }}>
              <div style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Pending Commands</div>
              <div style={{ fontSize: '18px', fontWeight: 700 }}>{pendingCommandCount}</div>
            </div>
            <div style={{ minWidth: '160px' }}>
              <div style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Last Event</div>
              <div style={{ fontSize: '13px', fontWeight: 600 }}>{events.length > 0 ? formatTime(events[events.length - 1].timestamp) : 'No events yet'}</div>
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          padding: '14px 16px',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-color)',
          borderRadius: '8px',
          marginBottom: '16px',
        }}
      >
        <div style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '10px' }}>
          Connection Status
        </div>
        <div style={{ display: 'grid', gap: '10px' }}>
          {connectivity.map((entry) => {
            const tone = entry.status === 'connected'
              ? { color: 'var(--accent-green)', icon: '●', label: 'Connected' }
              : entry.status === 'disconnected'
                ? { color: 'var(--accent-red)', icon: '○', label: 'Offline' }
                : { color: 'var(--accent-yellow)', icon: '◌', label: 'Unknown' };
            return (
              <div key={entry.label} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>{entry.label}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{entry.detail}</div>
                </div>
                <div style={{ color: tone.color, fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {tone.icon} {tone.label}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Prompt Waiting Banner */}
      {promptWaiting && (
        <div
          style={{
            padding: '12px 16px',
            background: 'rgba(163, 113, 247, 0.15)',
            border: '1px solid var(--accent-purple)',
            borderRadius: '8px',
            marginBottom: '16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <span style={{ fontSize: '16px' }}>🔔</span>
            <strong style={{ color: 'var(--accent-purple)' }}>Waiting for your input</strong>
          </div>

          {/* Quick response buttons */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <button
              className="btn btn-sm"
              onClick={() => sendQuickResponse('y')}
              style={{ background: 'var(--accent-green)', color: 'white' }}
            >
              Yes (y)
            </button>
            <button
              className="btn btn-sm"
              onClick={() => sendQuickResponse('n')}
              style={{ background: 'var(--accent-red)', color: 'white' }}
            >
              No (n)
            </button>
            <button
              className="btn btn-sm"
              onClick={() => sendQuickResponse('yes')}
            >
              Yes (full)
            </button>
            <button
              className="btn btn-sm"
              onClick={() => sendQuickResponse('no')}
            >
              No (full)
            </button>
            <button
              className="btn btn-sm"
              onClick={() => sendQuickResponse('enter')}
            >
              Enter
            </button>
          </div>

          {/* Keyboard input */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              ref={keyboardInputRef}
              type="text"
              value={keyboardInput}
              onChange={(e) => setKeyboardInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your response and press Enter..."
              className="form-input"
              style={{ flex: 1 }}
              disabled={sendLoading}
            />
            <button
              className="btn btn-primary"
              onClick={sendKeyboardInput}
              disabled={sendLoading || !keyboardInput.trim()}
            >
              {sendLoading ? 'Sending...' : 'Send'}
            </button>
          </div>

          {/* Show recent prompt text if available */}
          {promptText && (
            <div
              style={{
                marginTop: '8px',
                padding: '8px',
                background: 'var(--bg-tertiary)',
                borderRadius: '4px',
                fontSize: '12px',
                fontFamily: 'monospace',
                color: 'var(--text-secondary)',
              }}
            >
              {promptText.slice(-200)}
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="tabs">
        <button
          className={`tab ${activeTab === 'log' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('log')}
        >
          Live Log
        </button>
        <button
          className={`tab ${activeTab === 'timeline' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('timeline')}
        >
          Timeline
        </button>
        <button
          className={`tab ${activeTab === 'changes' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('changes')}
        >
          Changes
          {changedFiles.length > 0 && (
            <span className="tab-badge">{changedFiles.length}</span>
          )}
        </button>
        <button
          className={`tab ${activeTab === 'artifacts' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('artifacts')}
        >
          Artifacts
          {run.artifacts.length > 0 && (
            <span className="tab-badge">{run.artifacts.length}</span>
          )}
        </button>
        <button
          className={`tab ${activeTab === 'commands' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('commands')}
        >
          Commands
          {run.commands.length > 0 && (
            <span className="tab-badge">{run.commands.length}</span>
          )}
        </button>
        <button
          className={`tab ${activeTab === 'setup' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('setup')}
        >
          Setup
        </button>
        <button
          className={`tab ${activeTab === 'console' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('console')}
        >
          Console
        </button>
        <button
            className={`tab ${activeTab === 'vnc' ? 'tab-active' : ''}`}
            onClick={() => setActiveTab('vnc')}
          >
            VNC
            {vncReady && (
              <span className="tab-badge" title="VNC Ready">●</span>
            )}
          </button>
      </div>

      {/* Tab content */}
      <div className="tab-content">
        {activeTab === 'log' && (
          <LiveLogViewer events={events} maxHeight="calc(100vh - 400px)" />
        )}

        {activeTab === 'timeline' && (
          <TimelineView events={events} />
        )}

        {activeTab === 'changes' && (
          <ChangesView events={events} run={run} onApprove={(r) => sendQuickResponse(r as 'y' | 'n' | 'yes' | 'no' | 'enter')} />
        )}

        {activeTab === 'artifacts' && (
          <ArtifactsList artifacts={run.artifacts} />
        )}

        {activeTab === 'commands' && (
          <CommandsList commands={run.commands} />
        )}

        {activeTab === 'console' && runId && (
          <XTermConsole runId={runId} />
        )}

        {activeTab === 'setup' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <PendingRunnerPanel
              workerType={run.worker_type}
              runnerId={typeof run.metadata?.mcpRunnerId === 'string' ? run.metadata.mcpRunnerId : null}
            />
            {/* Orchestrator settings */}
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '14px' }}>Auto-Pilot Orchestrator</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    Automatically answer simple agent prompts using a local LLM
                  </div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {orchestratorSettings?.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <div
                    onClick={() => canOperate && saveOrchestratorSettings({ enabled: !orchestratorSettings?.enabled })}
                    style={{
                      width: '36px', height: '20px', borderRadius: '10px', cursor: canOperate ? 'pointer' : 'not-allowed',
                      background: orchestratorSettings?.enabled ? 'var(--accent-green)' : 'var(--bg-tertiary)',
                      border: '1px solid var(--border-color)',
                      position: 'relative', transition: 'background 0.2s',
                    }}
                  >
                    <div style={{
                      position: 'absolute', top: '2px',
                      left: orchestratorSettings?.enabled ? '18px' : '2px',
                      width: '14px', height: '14px', borderRadius: '50%',
                      background: 'white', transition: 'left 0.2s',
                    }} />
                  </div>
                </label>
              </div>
              {orchestratorSettings && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <div style={{ flex: '0 0 auto' }}>
                      <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>Provider</label>
                      <select
                        className="input"
                        style={{ fontSize: '12px', padding: '4px 8px' }}
                        value={orchestratorSettings.provider}
                        disabled={!canOperate || orchSaving}
                        onChange={e => saveOrchestratorSettings({ provider: e.target.value as 'ollama' | 'anthropic' | 'zencoder' })}
                      >
                        <option value="ollama">Ollama (local)</option>
                        <option value="anthropic">Anthropic Claude</option>
                        <option value="zencoder">Zencoder</option>
                      </select>
                    </div>
                    <div style={{ flex: 1, minWidth: '160px' }}>
                      <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>Model</label>
                      <input
                        className="input"
                        style={{ fontSize: '12px', padding: '4px 8px', width: '100%' }}
                        value={orchestratorSettings.model}
                        disabled={!canOperate || orchSaving}
                        placeholder={orchestratorSettings.provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'glm-5:cloud'}
                        onBlur={e => saveOrchestratorSettings({ model: e.target.value })}
                        onChange={e => setOrchestratorSettings(s => s ? { ...s, model: e.target.value } : s)}
                      />
                    </div>
                    {orchestratorSettings.provider === 'ollama' && (
                      <div style={{ flex: 1, minWidth: '200px' }}>
                        <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>Ollama Host</label>
                        <input
                          className="input"
                          style={{ fontSize: '12px', padding: '4px 8px', width: '100%' }}
                          value={orchestratorSettings.ollamaHost}
                          disabled={!canOperate || orchSaving}
                          placeholder="http://localhost:11434"
                          onBlur={e => saveOrchestratorSettings({ ollamaHost: e.target.value })}
                          onChange={e => setOrchestratorSettings(s => s ? { ...s, ollamaHost: e.target.value } : s)}
                        />
                      </div>
                    )}
                  </div>
                  {orchestratorSettings.provider === 'anthropic' && (
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: '200px' }}>
                        <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                          Anthropic API Key {userApiKeys?.hasAnthropicApiKey && <span style={{ color: 'var(--accent-green)' }}>✓ saved in profile</span>}
                        </label>
                        <input
                          className="input"
                          type="password"
                          style={{ fontSize: '12px', padding: '4px 8px', width: '100%' }}
                          value={orchestratorSettings.anthropicApiKey ?? ''}
                          disabled={!canOperate || orchSaving}
                          placeholder={userApiKeys?.hasAnthropicApiKey ? 'Using saved profile key' : 'sk-ant-...'}
                          onBlur={e => e.target.value && saveOrchestratorSettings({ anthropicApiKey: e.target.value })}
                          onChange={e => setOrchestratorSettings(s => s ? { ...s, anthropicApiKey: e.target.value } : s)}
                        />
                      </div>
                    </div>
                  )}
                  {orchestratorSettings.provider === 'zencoder' && (
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: '180px' }}>
                        <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                          Access Code {userApiKeys?.hasZencoderAccessCode && <span style={{ color: 'var(--accent-green)' }}>✓ saved</span>}
                        </label>
                        <input
                          className="input"
                          style={{ fontSize: '12px', padding: '4px 8px', width: '100%' }}
                          value={orchestratorSettings.zencoderAccessCode ?? ''}
                          disabled={!canOperate || orchSaving}
                          placeholder={userApiKeys?.hasZencoderAccessCode ? 'Using saved key' : 'Access code'}
                          onBlur={e => e.target.value && saveOrchestratorSettings({ zencoderAccessCode: e.target.value })}
                          onChange={e => setOrchestratorSettings(s => s ? { ...s, zencoderAccessCode: e.target.value } : s)}
                        />
                      </div>
                      <div style={{ flex: 1, minWidth: '180px' }}>
                        <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                          Secret Key {userApiKeys?.hasZencoderSecretKey && <span style={{ color: 'var(--accent-green)' }}>✓ saved</span>}
                        </label>
                        <input
                          className="input"
                          type="password"
                          style={{ fontSize: '12px', padding: '4px 8px', width: '100%' }}
                          value={orchestratorSettings.zencoderSecretKey ?? ''}
                          disabled={!canOperate || orchSaving}
                          placeholder={userApiKeys?.hasZencoderSecretKey ? 'Using saved key' : 'Secret key'}
                          onBlur={e => e.target.value && saveOrchestratorSettings({ zencoderSecretKey: e.target.value })}
                          onChange={e => setOrchestratorSettings(s => s ? { ...s, zencoderSecretKey: e.target.value } : s)}
                        />
                      </div>
                    </div>
                  )}
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: '4px' }}>
                    <strong>How it works:</strong> When the AI agent pauses for input, the orchestrator classifies the prompt.
                    Simple confirmations (install package, continue?) are answered automatically with confidence ≥ 85%.
                    Destructive or ambiguous prompts are escalated to you.
                  </div>
                </div>
              )}
              {orchSaving && <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '6px' }}>Saving...</div>}
            </div>
          </div>
        )}

        {activeTab === 'vnc' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ padding: '12px', background: 'var(--bg-tertiary)', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                {vncReady ? '● VNC Connected' : '○ VNC Not Connected'}
                {vncInfo?.stats?.clientConnectedAt && (
                  <span style={{ marginLeft: '8px' }}>
                    Since: {new Date(vncInfo.stats.clientConnectedAt).toLocaleString()}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                {!vncReady ? (
                  <button className="btn btn-primary" onClick={() => startVnc()} disabled={vncLoading}>
                    {vncLoading ? 'Starting…' : 'Start VNC Streaming'}
                  </button>
                ) : (
                  <button className="btn" onClick={() => stopVnc()}>Stop VNC</button>
                )}
              </div>
            </div>
            {vncError && (
              <div style={{ padding: '10px 12px', background: 'rgba(248,81,73,0.12)', border: '1px solid var(--accent-red)', borderRadius: '6px', fontSize: '12px', color: 'var(--accent-red)' }}>
                {vncError}
              </div>
            )}
            <VncViewer
              runId={run.id}
              autoConnect={activeTab === 'vnc' && (vncAvailable || vncInfo?.status === 'pending')}
              onConnect={() => {}}
              onDisconnect={() => {}}
            />
          </div>
        )}
      </div>

      {/* Prompt Modal */}
      <Modal
        open={showPromptModal}
        onClose={() => {
          setShowPromptModal(false);
          setReviewedPrompt(null);
          setReviewReasoning(null);
          setSelectedVersion('improved');
        }}
        title="Send Prompt"
        footer={
          <>
            <button className="btn" onClick={() => {
              setShowPromptModal(false);
              setReviewedPrompt(null);
              setReviewReasoning(null);
              setSelectedVersion('improved');
            }}>
              Cancel
            </button>
            {!reviewedPrompt && (
              <button
                className="btn"
                onClick={reviewPrompt}
                disabled={!promptInput.trim() || reviewLoading || promptLoading}
                style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)', border: '1px solid var(--accent-blue)' }}
              >
                {reviewLoading ? '⏳ Reviewing...' : '✨ Review & Improve'}
              </button>
            )}
            <button
              className="btn btn-primary"
              onClick={sendPrompt}
              disabled={!promptInput.trim() || promptLoading}
            >
              {promptLoading ? 'Sending...' : reviewedPrompt ? `Send ${selectedVersion === 'improved' ? 'Improved' : 'Original'}` : 'Send Prompt'}
            </button>
          </>
        }
      >
        {promptHistory.length > 0 && (
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Recent</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {promptHistory.map((h, i) => (
                <button key={i} className="btn btn-sm" onClick={() => { setPromptInput(h); setReviewedPrompt(null); setReviewReasoning(null); }}
                  style={{ fontSize: '11px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: 'var(--bg-tertiary)' }}
                  title={h}
                >
                  {h.slice(0, 40)}{h.length > 40 ? '…' : ''}
                </button>
              ))}
            </div>
          </div>
        )}
        <div style={{ marginBottom: '16px' }}>
          <label className="form-label">Your Prompt</label>
          <textarea
            value={promptInput}
            onChange={(e) => { setPromptInput(e.target.value); setReviewedPrompt(null); setReviewReasoning(null); }}
            placeholder="Enter your prompt or command to send to the running process..."
            className="form-input"
            style={{ minHeight: '100px', fontFamily: 'monospace', fontSize: '13px' }}
            disabled={promptLoading || reviewLoading}
          />
        </div>

        {reviewedPrompt && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {reviewReasoning && (
              <div style={{ padding: '8px 12px', background: 'rgba(47, 129, 247, 0.08)', border: '1px solid var(--accent-blue)', borderRadius: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                <strong style={{ color: 'var(--accent-blue)' }}>✨ What changed: </strong>{reviewReasoning}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div
                onClick={() => setSelectedVersion('original')}
                style={{ cursor: 'pointer', borderRadius: '6px', border: `2px solid ${selectedVersion === 'original' ? 'var(--accent-blue)' : 'var(--border-color)'}`, background: selectedVersion === 'original' ? 'rgba(47, 129, 247, 0.06)' : 'var(--bg-tertiary)', padding: '10px', transition: 'all 0.15s' }}
              >
                <div style={{ fontSize: '11px', fontWeight: 700, color: selectedVersion === 'original' ? 'var(--accent-blue)' : 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Original</div>
                <div style={{ fontSize: '12px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: 'var(--text-primary)', maxHeight: '120px', overflowY: 'auto' }}>{promptInput}</div>
              </div>
              <div
                onClick={() => setSelectedVersion('improved')}
                style={{ cursor: 'pointer', borderRadius: '6px', border: `2px solid ${selectedVersion === 'improved' ? 'var(--accent-blue)' : 'var(--border-color)'}`, background: selectedVersion === 'improved' ? 'rgba(47, 129, 247, 0.06)' : 'var(--bg-tertiary)', padding: '10px', transition: 'all 0.15s' }}
              >
                <div style={{ fontSize: '11px', fontWeight: 700, color: selectedVersion === 'improved' ? 'var(--accent-blue)' : 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>✨ Improved</div>
                <div style={{ fontSize: '12px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: 'var(--text-primary)', maxHeight: '120px', overflowY: 'auto' }}>{reviewedPrompt}</div>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Command Modal */}
      <Modal
        open={showCommandModal}
        onClose={() => setShowCommandModal(false)}
        title="Run Command"
        footer={
          <>
            <button className="btn" onClick={() => setShowCommandModal(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={sendCommand}
              disabled={!selectedCommand || commandLoading}
            >
              {commandLoading ? 'Sending...' : 'Run Command'}
            </button>
          </>
        }
      >
        <div style={{ marginBottom: '16px' }}>
          <label className="form-label">Select Command</label>
          <select
            value={selectedCommand}
            onChange={(e) => setSelectedCommand(e.target.value)}
            className="form-input"
            style={{ cursor: 'pointer' }}
          >
            <option value="">Choose a command...</option>
            {ALLOWED_COMMANDS.map((cmd) => (
              <option key={cmd} value={cmd}>
                {cmd}
              </option>
            ))}
          </select>
        </div>
        {selectedCommand && (
          <div
            style={{
              padding: '12px',
              background: 'var(--bg-tertiary)',
              borderRadius: '6px',
              fontFamily: 'monospace',
              fontSize: '13px',
            }}
          >
            <code>{selectedCommand}</code>
          </div>
        )}
      </Modal>

      {/* Stop Confirmation */}
      <ConfirmModal
        open={showStopConfirm}
        onClose={() => setShowStopConfirm(false)}
        onConfirm={stopRun}
        title="Stop Run"
        message="Are you sure you want to stop this run? This will send a stop signal to the running process."
        confirmText="Stop Run"
        danger
      />

      {/* Release Confirmation */}
      <ConfirmModal
        open={showReleaseConfirm}
        onClose={() => setShowReleaseConfirm(false)}
        onConfirm={releaseRun}
        title="Release Claim"
        message="Release this claim so another runner can pick it up?"
        confirmText="Release"
        danger
      />

      {/* Delete Confirmation */}
      <ConfirmModal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={deleteRun}
        title="Delete Run"
        message="Are you sure you want to delete this run? This action cannot be undone. All logs, artifacts, and data associated with this run will be permanently deleted."
        confirmText={deleteLoading ? 'Deleting...' : 'Delete Run'}
        danger
      />
    </div>
  );
}

// Timeline View
function TimelineView({ events }: { events: LogEvent[] }) {
  // Group events by step_id or time buckets
  const groupedEvents: { [key: string]: LogEvent[] } = {};

  events.forEach((event) => {
    const key = event.step_id || `time-${Math.floor(event.timestamp / 60)}`;
    if (!groupedEvents[key]) {
      groupedEvents[key] = [];
    }
    groupedEvents[key].push(event);
  });

  const groups = Object.entries(groupedEvents).sort((a, b) => {
    const aTime = a[1][0]?.timestamp || 0;
    const bTime = b[1][0]?.timestamp || 0;
    return aTime - bTime;
  });

  if (groups.length === 0) {
    return (
      <div className="empty-state-small">
        No timeline events yet.
      </div>
    );
  }

  return (
    <div className="timeline">
      {groups.map(([key, groupEvents]) => {
        const firstEvent = groupEvents[0];
        const lastEvent = groupEvents[groupEvents.length - 1];
        const hasErrors = groupEvents.some(e => e.type === 'stderr' || e.type === 'error');

        return (
          <TimelineGroup
            key={key}
            stepId={key}
            events={groupEvents}
            startTime={firstEvent.timestamp}
            endTime={lastEvent.timestamp}
            hasErrors={hasErrors}
          />
        );
      })}
    </div>
  );
}

function TimelineGroup({
  stepId: _stepId,
  events,
  startTime,
  endTime: _endTime,
  hasErrors,
}: {
  stepId: string;
  events: LogEvent[];
  startTime: number;
  endTime: number;
  hasErrors: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="timeline-group"
      style={{
        borderLeft: `3px solid ${hasErrors ? 'var(--accent-red)' : 'var(--border-color)'}`,
        paddingLeft: '16px',
        marginBottom: '12px',
      }}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          cursor: 'pointer',
          padding: '8px 0',
        }}
      >
        <span style={{ fontSize: '12px' }}>{expanded ? '▼' : '▶'}</span>
        <span style={{ fontSize: '13px', fontWeight: 500 }}>
          {formatTime(startTime)}
        </span>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {events.length} events
        </span>
        {hasErrors && (
          <span
            style={{
              padding: '2px 6px',
              fontSize: '10px',
              background: 'rgba(248, 81, 73, 0.15)',
              color: 'var(--accent-red)',
              borderRadius: '4px',
            }}
          >
            errors
          </span>
        )}
      </div>

      {expanded && (
        <div style={{ marginTop: '8px' }}>
          {events.slice(0, 20).map((event) => (
            <div
              key={event.id}
              style={{
                padding: '4px 8px',
                fontSize: '12px',
                fontFamily: 'monospace',
                color:
                  event.type === 'stderr'
                    ? 'var(--accent-red)'
                    : event.type === 'marker'
                    ? 'var(--accent-purple)'
                    : 'var(--text-secondary)',
              }}
            >
              {event.data.slice(0, 100)}
              {event.data.length > 100 && '...'}
            </div>
          ))}
          {events.length > 20 && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '4px 8px' }}>
              +{events.length - 20} more events
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Artifacts List
function ArtifactPreview({ artifact }: { artifact: Artifact }) {
  const [expanded, setExpanded] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const ext = artifact.name.split('.').pop()?.toLowerCase() ?? '';
  const isImage = ['png','jpg','jpeg','gif','svg','webp','bmp'].includes(ext);
  const isText = ['txt','md','log','json','yaml','yml','toml','ts','tsx','js','jsx','py','sh','css','html','xml','csv','env'].includes(ext);

  const loadText = async () => {
    if (textContent !== null) { setExpanded(e => !e); return; }
    setLoadingPreview(true);
    try {
      const res = await fetch(`/api/artifacts/${artifact.id}`);
      const text = await res.text();
      setTextContent(text.slice(0, 8000) + (text.length > 8000 ? '\n… (truncated)' : ''));
      setExpanded(true);
    } catch { setTextContent('Failed to load preview.'); setExpanded(true); }
    finally { setLoadingPreview(false); }
  };

  return (
    <li className="artifact-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <div>
          <span className="artifact-name">{artifact.name}</span>
          <span className="artifact-meta">
            {artifact.type} • {formatBytes(artifact.size)} • {formatTime(artifact.created_at)}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {(isImage || isText) && (
            <button className="btn btn-sm" onClick={isImage ? () => setExpanded(e => !e) : loadText} disabled={loadingPreview}>
              {loadingPreview ? '…' : expanded ? 'Hide' : 'Preview'}
            </button>
          )}
          <a href={`/api/artifacts/${artifact.id}`} className="btn btn-sm" download>Download</a>
        </div>
      </div>
      {expanded && isImage && (
        <img src={`/api/artifacts/${artifact.id}`} alt={artifact.name} style={{ maxWidth: '100%', maxHeight: '400px', borderRadius: '6px', border: '1px solid var(--border-color)' }} />
      )}
      {expanded && isText && textContent !== null && (
        <pre style={{ margin: 0, padding: '12px', background: 'var(--bg-tertiary)', borderRadius: '6px', fontSize: '12px', fontFamily: 'monospace', overflowX: 'auto', maxHeight: '400px', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {ext === 'json' ? (() => { try { return JSON.stringify(JSON.parse(textContent), null, 2); } catch { return textContent; } })() : textContent}
        </pre>
      )}
    </li>
  );
}

function ArtifactsList({ artifacts }: { artifacts: Artifact[] }) {
  if (artifacts.length === 0) {
    return (
      <div className="empty-state-small">
        No artifacts uploaded yet.
      </div>
    );
  }

  return (
    <ul className="artifact-list">
      {artifacts.map((artifact) => (
        <ArtifactPreview key={artifact.id} artifact={artifact} />
      ))}
    </ul>
  );
}

// Commands List
function CommandsList({ commands }: { commands: Command[] }) {
  if (commands.length === 0) {
    return (
      <div className="empty-state-small">
        No commands sent yet.
      </div>
    );
  }

  return (
    <div className="commands-list">
      {commands.map((cmd) => (
        <div key={cmd.id} className="command-item">
          <div className="command-header">
            <code className="command-text">
              {cmd.command === '__EXEC__'
                ? (cmd.arguments ?? cmd.command)
                : cmd.command === '__INPUT__'
                  ? (cmd.arguments ?? cmd.command)
                  : cmd.command}
            </code>
            <StatusPill
              status={cmd.status === 'completed' ? 'done' : 'pending'}
              size="sm"
            >
              {cmd.status}
            </StatusPill>
          </div>
          <div className="command-meta">
            Queued: {formatTime(cmd.created_at)}
            {cmd.acked_at && ` • Completed: ${formatTime(cmd.acked_at)}`}
          </div>
          {cmd.result && (
            <pre className="command-result">{cmd.result}</pre>
          )}
          {cmd.error && (
            <pre className="command-error">{cmd.error}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

function tokenizeLine(line: string, ext: string): React.ReactNode {
  const stripped = line.slice(1); // remove +/-/space prefix
  const prefix = line[0];

  // Basic token patterns per language
  const STRING = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  const COMMENT_LINE = /(?:\/\/|#).*$/;
  const COMMENT_BLOCK = /\/\*[\s\S]*?\*\//g;
  const KEYWORD_MAP: Record<string, string[]> = {
    ts: ['const','let','var','function','return','import','export','from','class','interface','type','if','else','for','while','async','await','new','null','undefined','true','false','extends','implements'],
    js: ['const','let','var','function','return','import','export','from','class','if','else','for','while','async','await','new','null','undefined','true','false'],
    py: ['def','class','return','import','from','if','elif','else','for','while','in','not','and','or','True','False','None','with','as','try','except','finally','raise','yield','lambda'],
    css: ['@import','@media','@keyframes','@font-face'],
  };
  const lang = ['ts','tsx'].includes(ext) ? 'ts' : ['js','jsx'].includes(ext) ? 'js' : ext === 'py' ? 'py' : ext === 'css' || ext === 'scss' ? 'css' : '';
  const keywords = lang ? (KEYWORD_MAP[lang] ?? []) : [];

  if (!stripped) return <>{prefix}</>;

  const parts: React.ReactNode[] = [];
  let remaining = stripped;
  let key = 0;

  // Simple pass: highlight strings and keywords
  const segments = remaining.split(/(\s+)/);
  parts.push(<span key={key++} style={{ opacity: 0.5 }}>{prefix}</span>);
  for (const seg of segments) {
    if (keywords.includes(seg.trim())) {
      parts.push(<span key={key++} style={{ color: 'var(--accent-purple)' }}>{seg}</span>);
    } else if (/^(["'`])/.test(seg)) {
      parts.push(<span key={key++} style={{ color: 'var(--accent-yellow)' }}>{seg}</span>);
    } else if (/^\d+$/.test(seg.trim()) && seg.trim()) {
      parts.push(<span key={key++} style={{ color: 'var(--accent-blue)' }}>{seg}</span>);
    } else {
      parts.push(<span key={key++}>{seg}</span>);
    }
  }
  void STRING; void COMMENT_LINE; void COMMENT_BLOCK; // suppress unused warnings
  return <>{parts}</>;
}

function DiffLines({ diff, ext, sideBySide }: { diff: string; ext: string; sideBySide: boolean }) {
  const lines = diff.split('\n');
  const [collapsedHunks, setCollapsedHunks] = useState<Set<number>>(new Set());

  if (!sideBySide) {
    const hunkIndices: number[] = [];
    lines.forEach((l, i) => { if (l.startsWith('@@')) hunkIndices.push(i); });

    return (
      <pre style={{ margin: 0, padding: '12px', fontFamily: "'Monaco','Menlo','Ubuntu Mono',monospace", fontSize: '12px', lineHeight: '1.5', overflowX: 'auto' }}>
        {lines.map((line, i) => {
          const hunkStart = [...hunkIndices].reverse().findIndex((h: number) => h <= i);
          const resolvedHunkStart = hunkStart === -1 ? -1 : hunkIndices.length - 1 - hunkStart;
          const hunkIdx = hunkIndices[resolvedHunkStart] ?? -1;
          const isHunkHeader = line.startsWith('@@');
          const isCollapsed = hunkIdx >= 0 && collapsedHunks.has(hunkIdx) && !isHunkHeader;
          if (isCollapsed) return null;
          const isAdd = line.startsWith('+') && !line.startsWith('+++');
          const isDel = line.startsWith('-') && !line.startsWith('---');
          return (
            <div key={i}
              onClick={isHunkHeader ? () => setCollapsedHunks(prev => { const s = new Set(prev); s.has(i) ? s.delete(i) : s.add(i); return s; }) : undefined}
              style={{ color: isAdd ? 'var(--accent-green)' : isDel ? 'var(--accent-red)' : line.startsWith('@@') ? 'var(--accent-purple)' : 'var(--text-primary)', background: isAdd ? 'rgba(59,185,80,0.08)' : isDel ? 'rgba(248,81,73,0.08)' : 'transparent', cursor: isHunkHeader ? 'pointer' : 'default', userSelect: isHunkHeader ? 'none' : 'text' }}
            >
              {isHunkHeader ? <span title="Click to collapse/expand">{collapsedHunks.has(i) ? '▶' : '▼'} {line}</span> : tokenizeLine(line, ext)}
            </div>
          );
        })}
      </pre>
    );
  }

  // Side-by-side
  const leftLines: { line: string; type: 'del' | 'ctx' }[] = [];
  const rightLines: { line: string; type: 'add' | 'ctx' }[] = [];
  for (const line of lines) {
    if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) {
      leftLines.push({ line, type: 'ctx' });
      rightLines.push({ line, type: 'ctx' });
    } else if (line.startsWith('+')) {
      leftLines.push({ line: '', type: 'ctx' });
      rightLines.push({ line, type: 'add' });
    } else if (line.startsWith('-')) {
      leftLines.push({ line, type: 'del' });
      rightLines.push({ line: '', type: 'ctx' });
    } else {
      leftLines.push({ line, type: 'ctx' });
      rightLines.push({ line, type: 'ctx' });
    }
  }
  const cellStyle = (type: string): React.CSSProperties => ({
    fontFamily: "'Monaco','Menlo','Ubuntu Mono',monospace",
    fontSize: '12px',
    lineHeight: '1.5',
    padding: '0 8px',
    whiteSpace: 'pre',
    background: type === 'add' ? 'rgba(59,185,80,0.08)' : type === 'del' ? 'rgba(248,81,73,0.08)' : 'transparent',
    color: type === 'add' ? 'var(--accent-green)' : type === 'del' ? 'var(--accent-red)' : 'var(--text-primary)',
    width: '50%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  });
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <tbody>
          {leftLines.map((l, i) => (
            <tr key={i}>
              <td style={cellStyle(l.type)}>{l.line || ' '}</td>
              <td style={{ width: '1px', background: 'var(--border-color)' }} />
              <td style={cellStyle(rightLines[i]?.type ?? 'ctx')}>{rightLines[i]?.line || ' '}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChangesView({ events, run, onApprove }: { events: LogEvent[]; run: Run | null; onApprove?: (resp: 'y' | 'n' | 'yes' | 'no' | 'enter') => void }) {
  const files = buildRunChangeReport(events);
  const [selectedPath, setSelectedPath] = useState<string | null>(files[0]?.path ?? null);
  const [sideBySide, setSideBySide] = useState(false);
  const needsApproval = run?.waiting_approval === 1;

  useEffect(() => {
    if (!files.some((entry) => entry.path === selectedPath)) {
      setSelectedPath(files[0]?.path ?? null);
    }
  }, [files, selectedPath]);

  if (files.length === 0) {
    return (
      <div className="empty-state-small">
        No file changes captured yet.
      </div>
    );
  }

  const selected = files.find((entry) => entry.path === selectedPath) ?? files[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
    {needsApproval && onApprove && (
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', background: 'rgba(163, 113, 247, 0.12)', border: '1px solid var(--accent-purple)', borderRadius: '8px' }}>
        <span style={{ flex: 1, fontWeight: 600, color: 'var(--accent-purple)' }}>🔔 AI is requesting approval for these changes</span>
        <button className="btn btn-sm" onClick={() => onApprove('n')} style={{ background: 'var(--accent-red)', color: 'white' }}>✗ Reject</button>
        <button className="btn btn-sm" onClick={() => onApprove('y')} style={{ background: 'var(--accent-green)', color: 'white' }}>✓ Approve</button>
      </div>
    )}
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '280px minmax(0, 1fr)',
        gap: '12px',
        minHeight: '480px',
      }}
    >
      <div
        style={{
          border: '1px solid var(--border-color)',
          borderRadius: '8px',
          overflow: 'hidden',
          background: 'var(--bg-secondary)',
        }}
      >
        {files.map((file) => (
          <button
            key={file.path}
            onClick={() => setSelectedPath(file.path)}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '10px 12px',
              border: 'none',
              borderBottom: '1px solid var(--border-color)',
              background: file.path === selected.path ? 'rgba(88, 166, 255, 0.12)' : 'transparent',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              fontFamily: 'monospace',
              fontSize: '12px',
            }}
          >
            <div>{file.path}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Updated {new Date(file.updatedAt * 1000).toLocaleTimeString()}
              </div>
              <div style={{ display: 'flex', gap: '8px', fontSize: '11px', fontWeight: 700 }}>
                <span style={{ color: 'var(--accent-green)' }}>+{file.additions}</span>
                <span style={{ color: 'var(--accent-red)' }}>-{file.deletions}</span>
              </div>
            </div>
          </button>
        ))}
      </div>

      <div
        style={{
          border: '1px solid var(--border-color)',
          borderRadius: '8px',
          overflow: 'auto',
          background: 'var(--bg-primary)',
        }}
      >
        <div style={{ padding: '12px', borderBottom: '1px solid var(--border-color)', fontWeight: 600 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontFamily: 'monospace', fontSize: '13px' }}>{selected.path}</span>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--accent-green)' }}>+{selected.additions}</span>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--accent-red)' }}>-{selected.deletions}</span>
              <button className="btn btn-sm" onClick={() => setSideBySide(s => !s)} style={{ fontSize: '11px', padding: '2px 8px' }}>
                {sideBySide ? 'Unified' : 'Side-by-side'}
              </button>
            </div>
          </div>
        </div>
        {selected.diff ? (
          <DiffLines diff={selected.diff} ext={selected.path.split('.').pop() ?? ''} sideBySide={sideBySide} />
        ) : (
          <div style={{ padding: '16px', color: 'var(--text-muted)' }}>
            Diff not available yet for this file.
          </div>
        )}
      </div>
    </div>
    </div>
  );
}

export default RunDetail;
