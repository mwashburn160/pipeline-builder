// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { ObservabilityQueryResponse } from '@/types/observability';

const REFRESH_INTERVAL_MS = 30_000;

export type RangeKey = '1h' | '6h' | '24h';

interface State {
  data: ObservabilityQueryResponse | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Fetches an observability metric query by catalog key. Re-polls every 30s
 * while the tab is visible; aborts the in-flight request on unmount or
 * range change so we don't write to a stale `setState`.
 *
 * The data shape is the raw envelope from the backend (samples for instant,
 * series for range). Panel components decide how to render it.
 */
export function useObservabilityQuery(key: string, range: RangeKey, vars?: { plugin?: string }) {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });
  const abortRef = useRef<AbortController | null>(null);
  // Stringify `vars` for the dep array — primitive keys keep React's
  // dependency comparator cheap and stable across re-renders.
  const varsKey = JSON.stringify(vars ?? {});

  const fetchOnce = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await api.observabilityQuery(key, range, controller.signal, vars);
      if (controller.signal.aborted) return;
      setState({ data: res.data ?? null, loading: false, error: null });
    } catch (err) {
      if (controller.signal.aborted) return;
      setState({ data: null, loading: false, error: err as Error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- vars tracked via varsKey
  }, [key, range, varsKey]);

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
