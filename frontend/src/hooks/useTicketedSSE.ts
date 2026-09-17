// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Base hook for a TICKETED SSE channel: exchange the JWT for a single-use ticket
 * (so the token never lands in an EventSource URL), open the stream, and
 * reconnect with a FRESH ticket + exponential backoff. Shared by
 * {@link useMessageNotifications}, {@link useExecutionStatusStream} and
 * {@link useBuildStatus} so the reconnect/backoff logic — the tricky part —
 * lives in one place.
 *
 * Reconnect fires on BOTH an EventSource error (via useSSE's onRetriesExhausted)
 * AND a failed ticket mint (a transient 5xx on the ticket endpoint), so a blip
 * can't kill the stream. By default it never gives up; a bounded stream (a
 * build log) passes `maxRetries` + `onGiveUp`. A consumer can also end the
 * stream from a message (return `true` from `onMessage`), which stops any
 * further reconnects until `subscriptionKey` changes.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useSSE } from './useSSE';
import { MESSAGE_SSE_BASE_RETRY_DELAY_MS } from '@/lib/constants';

const MAX_RECONNECT_DELAY_MS = 30_000;

export interface TicketedSSEOptions {
  /** Re-mint/reconnect key (e.g. orgId, requestId). `null` ⇒ stay disconnected. */
  subscriptionKey: string | null;
  /** Mint a fresh single-use ticket for `key` (the current subscriptionKey). */
  getTicket: (key: string) => Promise<string>;
  /** Build the EventSource URL from a minted ticket. */
  buildUrl: (ticket: string, key: string) => string;
  /**
   * Called for each SSE message payload. Return `true` to close the stream for
   * good (e.g. a build reached a terminal state) — no reconnect follows until
   * `subscriptionKey` changes.
   */
  onMessage: (data: unknown) => boolean | void;
  /**
   * Reconnect attempts (after a stream error or a failed ticket mint) allowed
   * before giving up. The count resets on every successful connect and on a
   * new `subscriptionKey`. Default: unlimited.
   */
  maxRetries?: number;
  /** Called once when `maxRetries` is exhausted and the hook stops reconnecting. */
  onGiveUp?: () => void;
}

export function useTicketedSSE(opts: TicketedSSEOptions): { connected: boolean; everConnected: boolean } {
  const { subscriptionKey } = opts;

  // Hold the callbacks in refs so a caller passing fresh closures each render
  // doesn't resubscribe the SSE — only `subscriptionKey`/reconnect drive that.
  const getTicketRef = useRef(opts.getTicket);
  const buildUrlRef = useRef(opts.buildUrl);
  const onMessageRef = useRef(opts.onMessage);
  const onGiveUpRef = useRef(opts.onGiveUp);
  const maxRetriesRef = useRef(opts.maxRetries ?? Infinity);
  useEffect(() => {
    getTicketRef.current = opts.getTicket;
    onMessageRef.current = opts.onMessage;
    buildUrlRef.current = opts.buildUrl;
    onGiveUpRef.current = opts.onGiveUp;
    maxRetriesRef.current = opts.maxRetries ?? Infinity;
  });

  const [url, setUrl] = useState<string | null>(null);
  const [ticketKey, setTicketKey] = useState(0);

  // No in-band retries (a consumed single-use ticket just 401s) — mint a fresh
  // ticket per reconnect with exponential backoff (bumping ticketKey re-runs the
  // mint effect). Reset on a successful connect.
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Set when the consumer closed the stream or retries ran out. */
  const stoppedRef = useRef(false);

  const scheduleReconnect = useCallback(() => {
    if (stoppedRef.current) return;
    const attempt = (reconnectAttemptRef.current += 1);
    if (attempt > maxRetriesRef.current) {
      stoppedRef.current = true;
      onGiveUpRef.current?.();
      return;
    }
    const delay = Math.min(MESSAGE_SSE_BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);
    reconnectTimerRef.current = setTimeout(() => setTicketKey((k) => k + 1), delay);
  }, []);
  useEffect(() => () => clearTimeout(reconnectTimerRef.current), []);

  // A new subscription starts with a clean slate: full retry budget, not
  // stopped, and no reconnect pending for the previous key. (Declared before
  // the mint effect so it runs first in the same commit.)
  useEffect(() => {
    reconnectAttemptRef.current = 0;
    stoppedRef.current = false;
    clearTimeout(reconnectTimerRef.current);
  }, [subscriptionKey]);

  useEffect(() => {
    if (!subscriptionKey) { setUrl(null); return; }
    let cancelled = false;
    getTicketRef.current(subscriptionKey)
      .then((ticket) => { if (!cancelled && !stoppedRef.current) setUrl(buildUrlRef.current(ticket, subscriptionKey)); })
      .catch(() => { if (!cancelled) { setUrl(null); scheduleReconnect(); } });
    return () => { cancelled = true; };
  }, [subscriptionKey, ticketKey, scheduleReconnect]);

  const onMessage = useCallback((data: unknown): boolean => {
    const close = onMessageRef.current(data) === true;
    if (close) {
      stoppedRef.current = true;
      clearTimeout(reconnectTimerRef.current);
      setUrl(null);
    }
    return close;
  }, []);
  const { connected, everConnected } = useSSE({ url, onMessage, onRetriesExhausted: scheduleReconnect });
  useEffect(() => { if (connected) reconnectAttemptRef.current = 0; }, [connected]);

  return { connected, everConnected };
}
