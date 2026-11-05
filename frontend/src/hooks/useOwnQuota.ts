// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import { useUnmountedRef } from '@/hooks/useUnmountedRef';
import type { DisplayedQuotaType, QuotaSummary, QuotaTier } from '@/types';

/** One of the caller's own quotas, plus the tier it was read on. */
export interface OwnQuota {
  summary: QuotaSummary;
  /** The org's tier — a trial allowance and a tier gate both need it. */
  tier?: QuotaTier;
}

/**
 * The org's own quota of one type for a surface that is about to spend it: read
 * ONCE when the surface opens and again each time an operation settles (`busy`
 * going true → false), so the "N left" line tracks what was just spent.
 *
 * Deliberately not polled — QuotaBanner already polls the same endpoint for the
 * page-wide notice, and a surface only needs to be right at the moment someone
 * is about to press the button.
 *
 * FAILS OPEN to `null` (nothing shown, nothing blocked): a quota read that
 * fails must not lock a control the server would have served. That rule is the
 * reason this is shared rather than written twice — the AI surfaces and the
 * build surfaces have to fail open the SAME way, and two copies of a fail-open
 * path is how one of them ends up failing closed.
 */
export function useOwnQuota(type: DisplayedQuotaType, busy = false): { quota: OwnQuota | null; refresh: () => void } {
  const [quota, setQuota] = useState<OwnQuota | null>(null);
  const unmountedRef = useUnmountedRef();

  const refresh = useCallback(() => {
    // An async IIFE, so a SYNCHRONOUS throw (a client missing the method) is
    // caught as well as a rejected promise.
    void (async () => {
      try {
        const q = (await api.getOwnQuotas()).data?.quota;
        if (unmountedRef.current) return;
        const summary = q?.quotas?.[type];
        setQuota(summary ? { summary, tier: q?.tier } : null);
      } catch { /* fail open — see above */ }
    })();
  }, [type, unmountedRef]);

  useEffect(() => { refresh(); }, [refresh]);

  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) refresh();
    wasBusy.current = busy;
  }, [busy, refresh]);

  return { quota, refresh };
}
