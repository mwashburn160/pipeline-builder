// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import type { Plan } from '@/types';

/**
 * Fetch the billing plan catalog into state. Fail-soft (stays empty on error).
 * Pass `enabled: false` to skip the fetch — e.g. when billing is disabled, so
 * callers don't request plans they'll never show. Shared by the signup and
 * onboarding plan pickers, which previously duplicated this effect.
 */
export function usePlans(enabled = true): { plans: Plan[]; loading: boolean } {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    api.getPlans()
      .then((res) => {
        if (!cancelled && res.success && res.data?.plans) setPlans(res.data.plans);
      })
      .catch(() => { /* fail-soft: an unreachable plans endpoint just hides the picker */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [enabled]);

  return { plans, loading };
}
