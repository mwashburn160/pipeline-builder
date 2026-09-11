// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Base hook for a TICKETED per-org SSE channel: exchange the JWT for a single-use
 * ticket (so the token never lands in an EventSource URL), open the stream, and
 * reconnect with a FRESH ticket + exponential backoff. Shared by
 * {@link useMessageNotifications} and {@link useExecutionStatusStream} so the
 * reconnect/backoff logic — the tricky part — lives in one place.
 *
 * Reconnect fires on BOTH an EventSource error (via useSSE's onRetriesExhausted)
 * AND a failed ticket mint (a transient 5xx on the ticket endpoint), so a blip
 * can't kill the stream for the rest of the session.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useSSE } from './useSSE';
import { MESSAGE_SSE_BASE_RETRY_DELAY_MS } from '@/lib/constants';

export interface TicketedSSEOptions {
  /** Re-mint/reconnect key (e.g. orgId). `null` ⇒ stay disconnected. */
  subscriptionKey: string | null;
  /** Mint a fresh single-use ticket. */
  getTicket: () => Promise<string>;
  /** Build the EventSource URL from a minted ticket. */
  buildUrl: (ticket: string) => string;
  /** Called for each SSE message payload. */
  onMessage: (data: unknown) => void;
}

export function useTicketedSSE(opts: TicketedSSEOptions): { connected: boolean; everConnected: boolean } {
  const { subscriptionKey } = opts;

  // Hold the callbacks in refs so a caller passing fresh closures each render
  // doesn't resubscribe the SSE — only `subscriptionKey`/reconnect drive that.
  const getTicketRef = useRef(opts.getTicket);
  const buildUrlRef = useRef(opts.buildUrl);
  const onMessageRef = useRef(opts.onMessage);
  useEffect(() => { getTicketRef.current = opts.getTicket; onMessageRef.current = opts.onMessage; buildUrlRef.current = opts.buildUrl; });

  const [url, setUrl] = useState<string | null>(null);
  const [ticketKey, setTicketKey] = useState(0);

  // No in-band retries (a consumed single-use ticket just 401s) — mint a fresh
  // ticket per reconnect with exponential backoff (bumping ticketKey re-runs the
  // mint effect). Reset on a successful connect.
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const scheduleReconnect = useCallback(() => {
    const attempt = (reconnectAttemptRef.current += 1);
    const delay = Math.min(MESSAGE_SSE_BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), 30_000);
    reconnectTimerRef.current = setTimeout(() => setTicketKey((k) => k + 1), delay);
  }, []);
  useEffect(() => () => clearTimeout(reconnectTimerRef.current), []);

  useEffect(() => {
    if (!subscriptionKey) { setUrl(null); return; }
    let cancelled = false;
    getTicketRef.current()
      .then((ticket) => { if (!cancelled) setUrl(buildUrlRef.current(ticket)); })
      .catch(() => { if (!cancelled) { setUrl(null); scheduleReconnect(); } });
    return () => { cancelled = true; };
  }, [subscriptionKey, ticketKey, scheduleReconnect]);

  const onMessage = useCallback((data: unknown) => { onMessageRef.current(data); }, []);
  const { connected, everConnected } = useSSE({ url, maxRetries: 0, onMessage, onRetriesExhausted: scheduleReconnect });
  useEffect(() => { if (connected) reconnectAttemptRef.current = 0; }, [connected]);

  return { connected, everConnected };
}
