// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';

/** Default panel refresh cadence — Prometheus/Loki scrape intervals are 15-30s
 *  so any tighter than this would mostly return identical samples. */
const REFRESH_INTERVAL_MS = 30_000;

interface State<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Shared polling/abort/visibility plumbing for observability hooks.
 *
 * The fetcher receives an AbortSignal and returns the unwrapped data envelope.
 * `cacheKey` is the stringified dependency that determines when to re-bind the
 * effect — callers compose it from their own params (range + vars/opts).
 */
export function useObservabilityResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T | undefined>,
  cacheKey: string,
  intervalMs: number = REFRESH_INTERVAL_MS,
) {
  const [state, setState] = useState<State<T>>({ data: null, loading: true, error: null });
  const abortRef = useRef<AbortController | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const fetchOnce = useCallback(async () => {
    // Background tabs throttle timers and the data is stale anyway — skip
    // the request until the tab is visible again.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetcherRef.current(controller.signal);
      if (controller.signal.aborted) return;
      setState({ data: res ?? null, loading: false, error: null });
    } catch (err) {
      if (controller.signal.aborted) return;
      setState({ data: null, loading: false, error: err as Error });
    }
  }, []);

  useEffect(() => {
    setState({ data: null, loading: true, error: null });
    void fetchOnce();
    const timer = setInterval(() => void fetchOnce(), intervalMs);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void fetchOnce();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cacheKey captures the relevant deps; fetchOnce is stable
  }, [cacheKey, intervalMs]);

  return { ...state, refresh: fetchOnce };
}
