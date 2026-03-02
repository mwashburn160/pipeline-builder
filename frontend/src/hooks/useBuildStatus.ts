/**
 * Build status polling hook using Server-Sent Events (SSE).
 * Connects to the plugin service's SSE endpoint and streams build events in real time.
 * Includes automatic retry with exponential backoff on transient connection errors.
 */
import { useState, useEffect, useRef } from 'react';
import { BUILD_SSE_MAX_RETRIES, MAX_BUILD_EVENTS } from '@/lib/constants';

/** Discriminator for SSE build event payloads. */
export type BuildEventType = 'INFO' | 'ERROR' | 'COMPLETED' | 'ROLLBACK';

/** A single build event received via SSE. */
export interface BuildEvent {
  /** ISO timestamp of when the event occurred. */
  ts: string;
  type: BuildEventType;
  message: string;
  /** Optional structured data attached to the event. */
  data?: Record<string, unknown>;
}

/** Lifecycle state of a plugin build. */
export type BuildStatus = 'idle' | 'building' | 'completed' | 'failed';

/**
 * Listens for SSE build events by requestId.
 * Opens an EventSource connection to the plugin service's SSE endpoint
 * and tracks build progress. Auto-closes on COMPLETED or final ERROR.
 * Retries up to 3 times with exponential backoff on transient network errors.
 *
 * @param requestId - The request ID returned by the 202 response, or null to stay idle
 * @returns Build event history, current status, and the most recent event
 */
export function useBuildStatus(requestId: string | null) {
  const [events, setEvents] = useState<BuildEvent[]>([]);
  const [status, setStatus] = useState<BuildStatus>('idle');
  const [reconnectKey, setReconnectKey] = useState(0);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Reset retry state when requestId changes
  useEffect(() => {
    retryCountRef.current = 0;
    setReconnectKey(0);
  }, [requestId]);

  useEffect(() => {
    if (!requestId) return;

    // Only reset state on first connect (not retries)
    if (retryCountRef.current === 0) {
      setStatus('building');
      setEvents([]);
    }

    const eventSource = new EventSource(`/api/plugin/logs/${requestId}`);

    eventSource.onmessage = (event) => {
      try {
        const parsed: BuildEvent = JSON.parse(event.data);
        // Reset retry count on any successful message
        retryCountRef.current = 0;

        setEvents((prev) => {
          const next = [...prev, parsed];
          return next.length > MAX_BUILD_EVENTS ? next.slice(-MAX_BUILD_EVENTS) : next;
        });

        switch (parsed.type) {
          case 'COMPLETED':
            setStatus('completed');
            eventSource.close();
            break;
          case 'ERROR':
            setStatus('failed');
            // Don't close — BullMQ may retry. Worker sends ERROR on final failure too.
            break;
        }
      } catch {
        // Ignore malformed SSE data
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      if (retryCountRef.current < BUILD_SSE_MAX_RETRIES) {
        retryCountRef.current++;
        const delay = 1000 * Math.pow(2, retryCountRef.current - 1);
        retryTimerRef.current = setTimeout(() => {
          setReconnectKey((k) => k + 1);
        }, delay);
      } else {
        setStatus((prev) => (prev === 'completed' ? prev : 'failed'));
      }
    };

    return () => {
      eventSource.close();
      clearTimeout(retryTimerRef.current);
    };
  }, [requestId, reconnectKey]);

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;

  return { events, status, lastEvent };
}
