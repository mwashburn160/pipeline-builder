/**
 * Build status polling hook using Server-Sent Events (SSE).
 * Connects to the plugin service's SSE endpoint and streams build events in real time.
 */
import { useState, useEffect } from 'react';

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
 *
 * @param requestId - The request ID returned by the 202 response, or null to stay idle
 * @returns Build event history, current status, and the most recent event
 */
export function useBuildStatus(requestId: string | null) {
  const [events, setEvents] = useState<BuildEvent[]>([]);
  const [status, setStatus] = useState<BuildStatus>('idle');

  useEffect(() => {
    if (!requestId) return;

    setStatus('building');
    setEvents([]);

    const eventSource = new EventSource(`/api/plugin/logs/${requestId}`);

    eventSource.onmessage = (event) => {
      try {
        const parsed: BuildEvent = JSON.parse(event.data);
        setEvents((prev) => {
          const next = [...prev, parsed];
          return next.length > 1000 ? next.slice(-1000) : next;
        });

        if (parsed.type === 'COMPLETED') {
          setStatus('completed');
          eventSource.close();
        } else if (parsed.type === 'ERROR') {
          setStatus('failed');
          // Don't close — BullMQ may retry. Worker sends ERROR on final failure too.
        }
      } catch {
        // Ignore malformed SSE data
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      setStatus((prev) => (prev === 'completed' ? prev : 'failed'));
    };

    return () => {
      eventSource.close();
    };
  }, [requestId]);

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;

  return { events, status, lastEvent };
}
