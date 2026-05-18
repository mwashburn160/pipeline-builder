// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { ObservabilityLogsResponse, ObservabilityLogsParams } from '@/types/observability';

const REFRESH_INTERVAL_MS = 30_000;

export type RangeKey = '1h' | '6h' | '24h';

interface State {
  data: ObservabilityLogsResponse | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Mirror of useObservabilityQuery for Loki-backed catalog queries.
 * Templated params (event/digest/actor) are passed through verbatim — the
 * backend sanitizes them server-side via substituteVars.
 */
export function useObservabilityLogs(
  key: string,
  range: RangeKey,
  opts: Omit<ObservabilityLogsParams, 'range'> = {},
) {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });
  const abortRef = useRef<AbortController | null>(null);
  // Stringify opts so the effect re-runs when any optional param changes
  // without re-running on every render (which would happen with an object dep).
  const optsKey = JSON.stringify(opts);

  const fetchOnce = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await api.observabilityLogs(key, range, opts, controller.signal);
      if (controller.signal.aborted) return;
      setState({ data: res.data ?? null, loading: false, error: null });
    } catch (err) {
      if (controller.signal.aborted) return;
      setState({ data: null, loading: false, error: err as Error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // optsKey above intentionally captures the opts identity so the callback
    // only changes when params change — listing `opts` would refire each render.
  }, [key, range, optsKey]);

  useEffect(() => {
    setState({ data: null, loading: true, error: null });
    void fetchOnce();
    const timer = setInterval(() => void fetchOnce(), REFRESH_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void fetchOnce();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      abortRef.current?.abort();
    };
  }, [fetchOnce]);

  return { ...state, refresh: fetchOnce };
}
