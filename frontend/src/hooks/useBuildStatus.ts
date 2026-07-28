// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Build status hook using Server-Sent Events (SSE).
 * Connects to the plugin service's SSE endpoint and streams build events in real time.
 * Uses a short-lived single-use ticket exchange (so the JWT never appears in the
 * query string) and reconnects with a FRESH ticket on transient drops, with
 * exponential backoff, giving up after a bounded number of attempts.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { useSSE } from './useSSE';
import { BUILD_SSE_MAX_RETRIES, MESSAGE_SSE_BASE_RETRY_DELAY_MS, MAX_BUILD_EVENTS } from '@/lib/constants';
import { clearPluginCache } from './usePlugins';
import api from '@/lib/api';

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

  // Exchange the JWT for a single-use SSE ticket so the JWT never lands in the
  // stream URL. A fresh ticket is minted for each connection attempt (tickets
  // are single-use), and again on each reconnect (bump ticketKey below).
  const [url, setUrl] = useState<string | null>(null);
  const [ticketKey, setTicketKey] = useState(0);

  useEffect(() => {
    if (!requestId || !api.isAuthenticated()) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    api.getBuildLogTicket(requestId)
      .then((ticket) => {
        if (!cancelled) setUrl(`/api/plugin/logs/${requestId}?ticket=${encodeURIComponent(ticket)}`);
      })
      .catch(() => {
        if (!cancelled) {
          setUrl(null);
          setStatus((prev) => (prev === 'completed' ? prev : 'failed'));
        }
      });
    return () => { cancelled = true; };
  }, [requestId, ticketKey]);

  const onMessage = useCallback((data: unknown): boolean | void => {
    const parsed = data as BuildEvent;

    setEvents((prev) => {
      const next = [...prev, parsed];
      return next.length > MAX_BUILD_EVENTS ? next.slice(-MAX_BUILD_EVENTS) : next;
    });

    switch (parsed.type) {
      case 'COMPLETED':
        setStatus('completed');
        clearPluginCache();
        return true; // close connection
      case 'ERROR':
        setStatus('failed');
        return true; // close connection
    }
  }, []);

  // Each SSE attempt needs a FRESH single-use ticket, so we do NO in-band retries
  // (maxRetries: 0 below) — retrying a consumed ticket just 401s. Instead we mint
  // a fresh ticket per reconnect (bump ticketKey → the ticket effect refetches)
  // with exponential backoff, giving up after BUILD_SSE_MAX_RETRIES attempts and
  // marking the build failed. The counter resets on a successful message/connect.
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onRetriesExhausted = useCallback(() => {
    const attempt = (reconnectAttemptRef.current += 1);
    if (attempt > BUILD_SSE_MAX_RETRIES) {
      setStatus((prev) => (prev === 'completed' ? prev : 'failed'));
      return;
    }
    const delay = Math.min(MESSAGE_SSE_BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), 30_000);
    reconnectTimerRef.current = setTimeout(() => setTicketKey((k) => k + 1), delay);
  }, []);
  useEffect(() => () => clearTimeout(reconnectTimerRef.current), []);

  const { connected } = useSSE({
    url,
    maxRetries: 0, // fresh ticket per reconnect (see onRetriesExhausted), not stale in-band retries
    onMessage,
    onRetriesExhausted,
  });

  // Reset the reconnect backoff once a connection succeeds.
  useEffect(() => { if (connected) reconnectAttemptRef.current = 0; }, [connected]);

  // Reset state when requestId changes
  useEffect(() => {
    if (requestId) {
      setStatus('building');
      setEvents([]);
      reconnectAttemptRef.current = 0;
    }
  }, [requestId]);

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;

  return { events, status, lastEvent };
}
