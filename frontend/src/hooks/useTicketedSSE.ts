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
 *
 * A mint refused for good — a 401 that is not the transient
 * SESSION_REFRESH_UNAVAILABLE, or a 403 — stops at once and calls `onGiveUp`:
 * retrying it would only hammer the ticket endpoint with the same refusal.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useSSE } from './useSSE';
import { MESSAGE_SSE_BASE_RETRY_DELAY_MS } from '@/lib/constants';
import { SESSION_REFRESH_UNAVAILABLE } from '@/lib/api/client/shared';
import { ApiError } from '@/lib/api/errors';

/** A ticket-mint failure no retry can fix: signed out, or not allowed. */
export function isNonRetryableTicketError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.statusCode === 403) return true;
  return err.statusCode === 401 && err.code !== SESSION_REFRESH_UNAVAILABLE;
}

const MAX_RECONNECT_DELAY_MS = 30_000;
/**
 * How long a connection must stay open before it counts as healthy and the
 * backoff/retry budget resets. Resetting on `onopen` alone let an endpoint that
 * accepts and immediately drops reconnect at the base delay forever (and a
 * bounded stream never exhaust `maxRetries`).
 */
export const SSE_STABLE_CONNECTION_MS = 10_000;

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
   * before giving up. The count resets once a connection has stayed up
   * for `SSE_STABLE_CONNECTION_MS`, and on a new `subscriptionKey`. Default: unlimited.
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
  // mint effect). Reset once a connection has stayed up (SSE_STABLE_CONNECTION_MS).
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Set when the consumer closed the stream or retries ran out. */
  const stoppedRef = useRef(false);

  const giveUp = useCallback(() => {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    clearTimeout(reconnectTimerRef.current);
    onGiveUpRef.current?.();
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (stoppedRef.current) return;
    const attempt = (reconnectAttemptRef.current += 1);
    if (attempt > maxRetriesRef.current) { giveUp(); return; }
    const delay = Math.min(MESSAGE_SSE_BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);
    reconnectTimerRef.current = setTimeout(() => setTicketKey((k) => k + 1), delay);
  }, [giveUp]);
  useEffect(() => () => clearTimeout(reconnectTimerRef.current), []);

  // A new subscription starts with a clean slate: full retry budget, not
  // stopped, and no reconnect pending for the previous key. (Declared before
  // the mint effect so it runs first in the same commit.)
  //
  // The previous key's stream is dropped HERE, not when the new ticket lands:
  // until then its EventSource was still open, so the old build's events were
  // appended to the new build's freshly reset log — and the old build's
  // terminal event marked the hook stopped, so the new ticket never connected.
  // `streamKeyRef` names the key the open stream belongs to, so an event
  // already queued for the old one is dropped too.
  const subscriptionKeyRef = useRef(subscriptionKey);
  const streamKeyRef = useRef<string | null>(null);
  useEffect(() => {
    subscriptionKeyRef.current = subscriptionKey;
    reconnectAttemptRef.current = 0;
    stoppedRef.current = false;
    clearTimeout(reconnectTimerRef.current);
    setUrl(null);
  }, [subscriptionKey]);

  useEffect(() => {
    if (!subscriptionKey) { setUrl(null); return; }
    let cancelled = false;
    getTicketRef.current(subscriptionKey)
      .then((ticket) => {
        if (cancelled || stoppedRef.current) return;
        streamKeyRef.current = subscriptionKey;
        setUrl(buildUrlRef.current(ticket, subscriptionKey));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setUrl(null);
        if (isNonRetryableTicketError(err)) giveUp();
        else scheduleReconnect();
      });
    return () => { cancelled = true; };
  }, [subscriptionKey, ticketKey, scheduleReconnect, giveUp]);

  const onMessage = useCallback((data: unknown): boolean => {
    if (streamKeyRef.current !== subscriptionKeyRef.current) return false;
    const close = onMessageRef.current(data) === true;
    if (close) {
      stoppedRef.current = true;
      clearTimeout(reconnectTimerRef.current);
      setUrl(null);
    }
    return close;
  }, []);
  const { connected, everConnected } = useSSE({ url, onMessage, onRetriesExhausted: scheduleReconnect });
  useEffect(() => {
    if (!connected) return;
    const stable = setTimeout(() => { reconnectAttemptRef.current = 0; }, SSE_STABLE_CONNECTION_MS);
    return () => clearTimeout(stable);
  }, [connected]);

  return { connected, everConnected };
}
