// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

/**
 * Aggregates the `degraded` flag reported by the many independent observability
 * panels on a dashboard into a single page-level signal. Each panel's data hook
 * ({@link useObservabilityResource}) reports its own degraded state keyed by its
 * cacheKey; the provider exposes `degraded = any panel degraded`, so a dashboard
 * can show ONE "monitoring backend unavailable" banner instead of a per-panel one.
 *
 * The default context is an inert no-op reporter, so panels used outside a
 * provider (e.g. a standalone StatPanel) work unchanged.
 */
interface ObservabilityHealth {
  /** A panel reports whether its latest fetch was a degraded (backend-unreachable) result. */
  report: (key: string, degraded: boolean) => void;
  /** True when at least one reporting panel is degraded. */
  degraded: boolean;
}

const ObservabilityHealthContext = createContext<ObservabilityHealth>({
  report: () => {},
  degraded: false,
});

export function ObservabilityHealthProvider({ children }: { children: ReactNode }) {
  // Per-panel degraded state, keyed by the panel's cacheKey. A ref (not state)
  // so a report doesn't re-render every panel — only the derived `degraded`
  // boolean is state, and only flips when the aggregate actually changes.
  const byKey = useRef<Map<string, boolean>>(new Map());
  const [degraded, setDegraded] = useState(false);

  const report = useCallback((key: string, isDegraded: boolean) => {
    const map = byKey.current;
    if (map.get(key) === isDegraded) return; // no change for this panel
    map.set(key, isDegraded);
    const anyDegraded = Array.from(map.values()).some(Boolean);
    setDegraded((prev) => (prev === anyDegraded ? prev : anyDegraded));
  }, []);

  return (
    <ObservabilityHealthContext.Provider value={{ report, degraded }}>
      {children}
    </ObservabilityHealthContext.Provider>
  );
}

/** Read the aggregate degraded signal — true when any panel's backend was unreachable. */
export function useObservabilityHealth(): boolean {
  return useContext(ObservabilityHealthContext).degraded;
}

/** The reporter a panel data-hook calls after each fetch. No-op outside a provider. */
export function useReportPanelHealth(): (key: string, degraded: boolean) => void {
  return useContext(ObservabilityHealthContext).report;
}
