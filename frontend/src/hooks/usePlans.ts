// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react';
import { queries } from '@/lib/api-cache';
import { useQuery } from './useQuery';
import type { Plan } from '@/types';

/** Stable empty result — a new array each render would re-run consumers' effects. */
const EMPTY: Plan[] = [];

/**
 * Fetch the billing plan catalog. Fail-soft (stays empty on error).
 * Pass `enabled: false` to skip the fetch — e.g. when billing is disabled, so
 * callers don't request plans they'll never show. Shared by the signup and
 * onboarding plan pickers.
 *
 * Reads through the shared query cache, so the signup picker, the onboarding
 * picker and both billing pages resolve to ONE request for a catalog that does
 * not change within a session — and two of them mounting together join the same
 * in-flight request instead of issuing two.
 */
export function usePlans(enabled = true): { plans: Plan[]; loading: boolean } {
  const { data, loading, error } = useQuery(queries.plans(), { enabled });

  const plans = useMemo(
    // Fail-soft: an unreachable plans endpoint just hides the picker.
    () => (error || !data?.success ? EMPTY : data.data?.plans ?? EMPTY),
    [data, error],
  );

  return { plans, loading };
}
