/**
 * useVncConnection - React hook for managing VNC connection lifecycle
 * Handles polling VNC status, initiating streams, and cleanup
 */

import { useState, useEffect, useCallback } from 'react';

export interface VncInfo {
  runId: string;
  available: boolean;
  status: 'disconnected' | 'pending' | 'active';
  clientConnected: boolean;
  viewerConnected: boolean;
  wsUrl: string;
  stats?: {
    createdAt: string;
    clientConnectedAt?: string;
    viewerConnectedAt?: string;
    bytesFromClient: number;
    bytesToClient: number;
    bytesFromViewer: number;
    bytesToViewer: number;
  };
}

export interface UseVncConnectionOptions {
  runId: string;
  pollInterval?: number;
  autoStart?: boolean;
}

export function useVncConnection({
  runId,
  pollInterval = 2000,
  autoStart = false
}: UseVncConnectionOptions) {
  const [vncAvailable, setVncAvailable] = useState(false);
  const [vncInfo, setVncInfo] = useState<VncInfo | null>(null);
  const [vncReady, setVncReady] = useState(false);
  const [vncError, setVncError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Poll VNC status
  const checkVncStatus = useCallback(async () => {
    try {
      const response = await fetch(`/api/runs/${runId}/vnc`);

      if (response.ok) {
        const data: VncInfo = await response.json();
        setVncInfo(data);
        setVncAvailable(data.available);
        setVncReady(data.status === 'active' && data.clientConnected && data.viewerConnected);
        setVncError(null);
      } else if (response.status === 404) {
        setVncAvailable(false);
        setVncError('Run not found or does not support VNC');
      } else if (response.status === 400) {
        setVncAvailable(false);
        setVncError('This run type does not support VNC access');
      } else {
        setVncError('Failed to check VNC status');
      }
    } catch (err) {
      setVncAvailable(false);
      setVncError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [runId]);

  // Start VNC streaming
  const startVnc = useCallback(async () => {
    setIsLoading(true);
    setVncError(null);

    try {
      const response = await fetch(`/api/runs/${runId}/vnc/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to start VNC');
      }

      const data = await response.json();
      console.log('VNC streaming command sent:', data);

      // Poll until ready
      let attempts = 0;
      const maxAttempts = 30;

      const waitForReady = async () => {
        while (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          await checkVncStatus();

          attempts++;

          if (vncReady) {
            setIsLoading(false);
            return;
          }
        }

        if (attempts >= maxAttempts) {
          setVncError('VNC streaming timeout - client did not connect');
          setIsLoading(false);
        }
      };

      waitForReady();
    } catch (err) {
      setVncError(err instanceof Error ? err.message : 'Failed to start VNC');
      setIsLoading(false);
    }
  }, [runId, checkVncStatus, vncReady]);

  // Stop VNC streaming
  const stopVnc = useCallback(async () => {
    try {
      const response = await fetch(`/api/runs/${runId}/vnc`, {
        method: 'DELETE'
      });

      if (response.ok) {
        setVncAvailable(false);
        setVncReady(false);
        await checkVncStatus();
      }
    } catch (err) {
      console.error('Failed to stop VNC:', err);
    }
  }, [runId, checkVncStatus]);

  // Poll VNC status periodically
  useEffect(() => {
    checkVncStatus();

    const interval = setInterval(checkVncStatus, pollInterval);

    return () => clearInterval(interval);
  }, [runId, pollInterval, checkVncStatus]);

  // Auto-start if enabled
  useEffect(() => {
    if (autoStart && vncAvailable && !vncReady && !isLoading) {
      startVnc();
    }
  }, [autoStart, vncAvailable, vncReady, isLoading, startVnc]);

  return {
    // State
    vncAvailable,
    vncInfo,
    vncReady,
    vncError,
    isLoading,

    // Methods
    startVnc,
    stopVnc,
    checkVncStatus
  };
}

export default useVncConnection;
