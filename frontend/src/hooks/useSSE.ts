/**
 * Generic SSE (Server-Sent Events) connection hook with exponential backoff retry.
 * Extracts the common retry/reconnect pattern used by useBuildStatus and useMessageNotifications.
 */
import { useState, useEffect, useRef } from 'react';

export interface UseSSEOptions {
  /** URL to connect to, or null to stay disconnected. */
  url: string | null;
  /** Maximum reconnection attempts before giving up. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (delay = base * 2^(attempt-1)). */
  baseRetryDelayMs?: number;
  /** Called for each parsed SSE message. Return true to close the connection. */
  onMessage: (data: unknown) => boolean | void;
  /** Called when all retry attempts are exhausted. */
  onRetriesExhausted?: () => void;
}

export interface UseSSEResult {
  /** Whether the EventSource is currently connected. */
  connected: boolean;
}

/**
 * Opens an EventSource to `url` and dispatches parsed JSON messages to `onMessage`.
 * Automatically retries with exponential backoff on connection errors.
 * Reconnects from scratch when `url` changes.
 */
export function useSSE(options: UseSSEOptions): UseSSEResult {
  const { url, maxRetries = 3, baseRetryDelayMs = 1000, onMessage, onRetriesExhausted } = options;

  const [connected, setConnected] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onMessageRef = useRef(onMessage);
  const onRetriesExhaustedRef = useRef(onRetriesExhausted);

  // Keep callback refs current without triggering reconnects
  onMessageRef.current = onMessage;
  onRetriesExhaustedRef.current = onRetriesExhausted;

  // Reset retry state when url changes
  useEffect(() => {
    retryCountRef.current = 0;
    setReconnectKey(0);
  }, [url]);

  useEffect(() => {
    if (!url) return;

    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      setConnected(true);
      retryCountRef.current = 0;
    };

    eventSource.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        retryCountRef.current = 0;
        const shouldClose = onMessageRef.current(parsed);
        if (shouldClose) eventSource.close();
      } catch {
        // Ignore malformed SSE data
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      setConnected(false);

      if (retryCountRef.current < maxRetries) {
        retryCountRef.current++;
        const delay = baseRetryDelayMs * Math.pow(2, retryCountRef.current - 1);
        retryTimerRef.current = setTimeout(() => {
          setReconnectKey((k) => k + 1);
        }, delay);
      } else {
        onRetriesExhaustedRef.current?.();
      }
    };

    return () => {
      eventSource.close();
      clearTimeout(retryTimerRef.current);
      setConnected(false);
    };
  }, [url, reconnectKey, maxRetries, baseRetryDelayMs]);

  return { connected };
}
