// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Build status hook using Server-Sent Events (SSE).
 * Streams a plugin build's events in real time over {@link useTicketedSSE},
 * which owns the single-use ticket exchange and the fresh-ticket reconnect with
 * exponential backoff. A build stream is bounded: it closes on a terminal event
 * and gives up (marking the build failed) after BUILD_SSE_MAX_RETRIES
 * consecutive failed reconnects or ticket mints.
 */
import { useState, useEffect } from 'react';
import { useTicketedSSE } from './useTicketedSSE';
import { BUILD_SSE_MAX_RETRIES, MAX_BUILD_EVENTS } from '@/lib/constants';
import api from '@/lib/api';
import { invalidate } from '@/lib/api-cache';

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
 * Whether an ERROR event ends the build. The worker attaches an explicit
 * `final` flag (authoritative: a permanent failure ends before the attempt
 * budget) plus `{ attemptsMade, maxAttempts }`; without `final`, an attempt
 * below the budget is retried. Events without those fields are terminal.
 */
export function isFinalErrorAttempt(event: BuildEvent): boolean {
  const final = event.data?.final;
  if (typeof final === 'boolean') return final;
  const attemptsMade = event.data?.attemptsMade;
  const maxAttempts = event.data?.maxAttempts;
  if (typeof attemptsMade !== 'number' || typeof maxAttempts !== 'number') return true;
  return attemptsMade >= maxAttempts;
}

/**
 * Listens for SSE build events by requestId and tracks build progress. Closes
 * the stream on COMPLETED or on the final attempt's ERROR (a retried attempt's
 * ERROR keeps the build 'building').
 *
 * @param requestId - The request ID returned by the 202 response, or null to stay idle
 * @returns Build event history, current status, and the most recent event
 */
export function useBuildStatus(requestId: string | null) {
  const [events, setEvents] = useState<BuildEvent[]>([]);
  const [status, setStatus] = useState<BuildStatus>('idle');

  // Reset state when a new build starts.
  useEffect(() => {
    if (requestId) {
      setStatus('building');
      setEvents([]);
    }
  }, [requestId]);

  useTicketedSSE({
    subscriptionKey: requestId && api.isAuthenticated() ? requestId : null,
    getTicket: (id) => api.getBuildLogTicket(id),
    buildUrl: (ticket, id) => `/api/plugins/logs/${id}?ticket=${encodeURIComponent(ticket)}`,
    onMessage: (data) => {
      const parsed = data as BuildEvent;
      setEvents((prev) => {
        const next = [...prev, parsed];
        return next.length > MAX_BUILD_EVENTS ? next.slice(-MAX_BUILD_EVENTS) : next;
      });
      switch (parsed.type) {
        case 'COMPLETED':
          setStatus('completed');
          invalidate.plugins();
          return true; // terminal — close the stream
        case 'ERROR':
          // The worker emits ERROR on every failed attempt. A non-final attempt
          // will be retried, so stay 'building' and keep listening; only the
          // final attempt (or a legacy event without attempt counts) is terminal.
          if (!isFinalErrorAttempt(parsed)) return false;
          setStatus('failed');
          return true; // terminal — close the stream
        default:
          return false;
      }
    },
    maxRetries: BUILD_SSE_MAX_RETRIES,
    // The stream is gone for good, so the outcome is unknown — surface it as a
    // failure rather than an eternal spinner (a completed build stays completed).
    onGiveUp: () => setStatus((prev) => (prev === 'completed' ? prev : 'failed')),
  });

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;

  return { events, status, lastEvent };
}
