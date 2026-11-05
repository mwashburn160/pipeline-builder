// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import api from '@/lib/api';
import { useUnmountedRef } from '@/hooks/useUnmountedRef';
import type { Bundle, BillingInterval, CrossoverVerdict } from '@/types';

/**
 * The two pieces of commercial context the quota page needs to say what a limit
 * COSTS (F2) and whether the account's spend already argues for a tier move
 * (F3) — docs/plans/sales-agent.md.
 *
 * Both are INFORMATION rather than solicitation, which is why this is read
 * unconditionally rather than behind an offers switch: a catalogue price and
 * arithmetic over the account's own subscription raise no consent question that
 * a billing notice does not already raise.
 *
 * FAILS OPEN to empty, in both halves and independently. A page about running
 * out of quota must render whether or not billing could be reached — the price
 * line and the comparison card simply do not appear. Read once per mount, not
 * polled: neither the catalogue nor a subscription changes while someone looks
 * at a quota page.
 */
export function useSalesContext(): {
  bundles: Bundle[];
  interval: BillingInterval;
  crossover: CrossoverVerdict | null;
  refresh: () => void;
} {
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [interval, setInterval] = useState<BillingInterval>('monthly');
  const [crossover, setCrossover] = useState<CrossoverVerdict | null>(null);
  const unmountedRef = useUnmountedRef();

  const refresh = useCallback(() => {
    // Separate IIFEs so one failing read cannot take the other's result with
    // it — a missing catalogue should not also hide the comparison.
    void (async () => {
      try {
        const res = await api.getBundles();
        if (unmountedRef.current) return;
        setBundles(res.data?.bundles ?? []);
      } catch { /* fail open — see above */ }
    })();
    void (async () => {
      try {
        const res = await api.getCrossover();
        if (unmountedRef.current) return;
        const verdict = res.data?.crossover ?? null;
        setCrossover(verdict);
        // The interval the account is actually billed at, so the pack price on a
        // quota card is quoted in the same period as their bill rather than
        // always monthly.
        if (verdict) setInterval(verdict.interval);
      } catch { /* fail open — see above */ }
    })();
  }, [unmountedRef]);

  useEffect(() => { refresh(); }, [refresh]);

  return { bundles, interval, crossover, refresh };
}
