// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Generic SSE (Server-Sent Events) connection hook.
 *
 * On a connection error it closes the stream and hands control to
 * `onRetriesExhausted` — it does NOT reconnect in-band. Both streams in this
 * app are TICKETED (a single-use ticket is exchanged for the stream), so
 * replaying the same URL would just 401; reconnecting means minting a fresh
 * ticket, which only the consumer can do. The old `maxRetries` /
 * `baseRetryDelayMs` backoff branch was therefore dead code — both consumers
 * passed `maxRetries: 0` — and actively wrong for anything that enabled it.
 */
import { useState, useEffect, useRef } from 'react';

export interface UseSSEOptions {
  /** URL to connect to, or null to stay disconnected. */
  url: string | null;
  /** Called for each parsed SSE message. Return true to close the connection. */
  onMessage: (data: unknown) => boolean | void;
  /** Called when the connection errors out. The consumer owns reconnection
   *  (mint a fresh ticket, then change `url`). */
  onRetriesExhausted?: () => void;
}

export interface UseSSEResult {
  /** Whether the EventSource is currently connected. */
  connected: boolean;
  /**
   * Whether the connection has ever successfully opened during this hook's
   * lifetime. Lets consumers distinguish the benign initial handshake
   * (`connected=false, everConnected=false`) from a genuine drop after a
   * healthy connection (`connected=false, everConnected=true`) so a
   * "reconnecting" indicator only shows for real outages.
   */
  everConnected: boolean;
}

/**
 * Opens an EventSource to `url` and dispatches parsed JSON messages to `onMessage`.
 * On error it closes and calls `onRetriesExhausted`; reconnects from scratch
 * when `url` changes.
 */
export function useSSE(options: UseSSEOptions): UseSSEResult {
  const { url, onMessage, onRetriesExhausted } = options;

  const [connected, setConnected] = useState(false);
  // Set once on the first successful onopen and never reset for the hook's
  // lifetime — this is a "have we ever been live" signal, so it must survive
  // reconnects (which change `url` as fresh tickets are minted).
  const [everConnected, setEverConnected] = useState(false);
  const onMessageRef = useRef(onMessage);
  const onRetriesExhaustedRef = useRef(onRetriesExhausted);

  // Keep callback refs current without triggering reconnects
  onMessageRef.current = onMessage;
  onRetriesExhaustedRef.current = onRetriesExhausted;

  useEffect(() => {
    if (!url) return;

    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      setConnected(true);
      setEverConnected(true);
    };

    eventSource.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const shouldClose = onMessageRef.current(parsed);
        if (shouldClose) eventSource.close();
      } catch {
        // Ignore malformed SSE data
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      setConnected(false);

      onRetriesExhaustedRef.current?.();
    };

    return () => {
      eventSource.close();
      setConnected(false);
    };
  }, [url]);

  return { connected, everConnected };
}
