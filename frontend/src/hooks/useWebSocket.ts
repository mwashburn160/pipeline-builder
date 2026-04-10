// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState, useCallback } from 'react';

interface UseWebSocketOptions {
  /** WebSocket URL (e.g., wss://localhost:8443/ws). */
  url: string;
  /** Auth token to send on connection. */
  token?: string;
  /** Organization ID for the connection. */
  orgId?: string;
  /** Auto-reconnect on disconnect (default: true). */
  reconnect?: boolean;
  /** Max reconnect attempts (default: 5). */
  maxRetries?: number;
  /** Message handler. */
  onMessage?: (data: Record<string, unknown>) => void;
}

interface UseWebSocketResult {
  connected: boolean;
  send: (type: string, data?: unknown) => void;
}

/**
 * React hook for WebSocket connections with auto-reconnect.
 * Works alongside SSE for backward compatibility.
 *
 * Requires the message service to have a WebSocket server running.
 * If WebSocket is unavailable, falls back gracefully (connected = false).
 */
export function useWebSocket({
  url,
  token,
  orgId,
  reconnect = true,
  maxRetries = 5,
  onMessage,
}: UseWebSocketOptions): UseWebSocketResult {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        if (!mountedRef.current) { ws.close(); return; }
        setConnected(true);
        retriesRef.current = 0;
        // Authenticate on connect
        if (token && orgId) {
          ws.send(JSON.stringify({ type: 'auth', token, orgId }));
        }
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const data = JSON.parse(event.data);
          onMessage?.(data);
        } catch { /* ignore parse errors */ }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setConnected(false);
        wsRef.current = null;
        if (reconnect && retriesRef.current < maxRetries) {
          retriesRef.current++;
          const delay = Math.min(1000 * Math.pow(2, retriesRef.current - 1), 30000);
          setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      wsRef.current = ws;
    } catch {
      setConnected(false);
    }
  }, [url, token, orgId, reconnect, maxRetries, onMessage]);

  useEffect(() => {
    mountedRef.current = true;
    if (token && orgId) connect();
    return () => {
      mountedRef.current = false;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect, token, orgId]);

  const send = useCallback((type: string, data?: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, data }));
    }
  }, []);

  return { connected, send };
}
