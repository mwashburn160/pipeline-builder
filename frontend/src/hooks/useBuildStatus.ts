/**
 * Build status hook using Server-Sent Events (SSE).
 * Connects to the plugin service's SSE endpoint and streams build events in real time.
 * Includes automatic retry with exponential backoff on transient connection errors.
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { useSSE } from './useSSE';
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

  const url = useMemo(() => requestId ? `/api/plugin/logs/${requestId}` : null, [requestId]);

  const onMessage = useCallback((data: unknown): boolean | void => {
    const parsed = data as BuildEvent;

    setEvents((prev) => {
      const next = [...prev, parsed];
      return next.length > MAX_BUILD_EVENTS ? next.slice(-MAX_BUILD_EVENTS) : next;
    });

    switch (parsed.type) {
      case 'COMPLETED':
        setStatus('completed');
        return true; // close connection
      case 'ERROR':
        setStatus('failed');
        return true; // close connection
    }
  }, []);

  const onRetriesExhausted = useCallback(() => {
    setStatus((prev) => (prev === 'completed' ? prev : 'failed'));
  }, []);

  useSSE({
    url,
    maxRetries: BUILD_SSE_MAX_RETRIES,
    onMessage,
    onRetriesExhausted,
  });

  // Reset state when requestId changes
  useEffect(() => {
    if (requestId) {
      setStatus('building');
      setEvents([]);
    }
  }, [requestId]);

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;

  return { events, status, lastEvent };
}
