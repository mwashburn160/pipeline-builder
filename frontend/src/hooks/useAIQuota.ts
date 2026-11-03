// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import { useUnmountedRef } from '@/hooks/useUnmountedRef';
import type { QuotaSummary, QuotaTier } from '@/types';

/** The caller's org `aiCalls` quota, as {@link useAIQuota} reads it. */
export interface AIQuota {
  summary: QuotaSummary;
  /** The org's tier — a trial tier labels its allowance as such. */
  tier?: QuotaTier;
}

/**
 * The org's `aiCalls` quota for an AI surface: read ONCE when the surface opens
 * and again each time a generation settles (`busy` going true → false), so the
 * "N AI calls left" line tracks the calls just spent.
 *
 * Deliberately not polled — QuotaBanner already polls the same endpoint for the
 * page-wide notice, and a surface only needs to be right at the moment someone
 * is about to press Generate.
 *
 * FAILS OPEN to `null` (nothing shown, nothing blocked): a quota read that
 * fails must not lock an AI control the server would have served.
 */
export function useAIQuota(busy = false): { quota: AIQuota | null; refresh: () => void } {
  const [quota, setQuota] = useState<AIQuota | null>(null);
  const unmountedRef = useUnmountedRef();

  const refresh = useCallback(() => {
    // An async IIFE, so a SYNCHRONOUS throw (a client missing the method) is
    // caught as well as a rejected promise.
    void (async () => {
      try {
        const q = (await api.getOwnQuotas()).data?.quota;
        if (unmountedRef.current) return;
        setQuota(q?.quotas?.aiCalls ? { summary: q.quotas.aiCalls, tier: q.tier } : null);
      } catch { /* fail open — see above */ }
    })();
  }, [unmountedRef]);

  useEffect(() => { refresh(); }, [refresh]);

  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) refresh();
    wasBusy.current = busy;
  }, [busy, refresh]);

  return { quota, refresh };
}
