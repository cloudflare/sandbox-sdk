import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

export function useDesktop() {
  const [isRunning, setIsRunning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statusTimer = useRef<number>(0);
  const fetchingUrl = useRef(false);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await api.getStatus();
      const running = status.status === 'active' || status.status === 'partial';
      setIsRunning(running);

      if (!running) {
        setStreamUrl(null);
        fetchingUrl.current = false;
      }
    } catch {
      // Transient errors during polling are expected
    }
  }, []);

  // Fetch stream URL when desktop becomes running and we don't have one
  useEffect(() => {
    if (!isRunning || streamUrl || fetchingUrl.current) return;

    fetchingUrl.current = true;
    api
      .getStreamUrl()
      .then(({ url }) => setStreamUrl(url))
      .catch(() => {
        fetchingUrl.current = false;
      });
  }, [isRunning, streamUrl]);

  const start = async (resolution?: [number, number]) => {
    setError(null);
    setIsStarting(true);
    try {
      await api.startDesktop(resolution);
      await refreshStatus();
      // getDesktopStreamUrl waits for the platform to detect port 6080
      // (via the Containers runtime's getTcpPort polling) before returning.
      const { url } = await api.getStreamUrl();
      setStreamUrl(url);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start desktop');
    } finally {
      setIsStarting(false);
    }
  };

  const stop = async () => {
    setError(null);
    try {
      await api.stopDesktop();
      setStreamUrl(null);
      fetchingUrl.current = false;
      await refreshStatus();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to stop desktop');
    }
  };

  // Poll status every 3s
  useEffect(() => {
    refreshStatus();
    statusTimer.current = window.setInterval(refreshStatus, 3000);
    return () => clearInterval(statusTimer.current);
  }, [refreshStatus]);

  return { isRunning, isStarting, streamUrl, error, start, stop };
}
