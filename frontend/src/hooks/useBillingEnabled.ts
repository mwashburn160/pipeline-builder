// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Whether the billing SERVICE is enabled in this deployment (`BILLING_ENABLED`),
 * as reported by the always-available `/api/billing/config` probe. This is
 * deployment config, not a per-user feature — so it's fetched ONCE and cached at
 * the module level for the session (shared across every `useBillingEnabled`
 * caller). Used to auto-hide the Billing nav when billing is off, rather than
 * showing a link that dead-ends at a 503.
 *
 * Defaults to `false` until known (and on any error), so the nav never flashes a
 * dead link before the probe resolves.
 */
let cached: boolean | undefined;
let inflight: Promise<boolean> | null = null;

// Resolves to the probe's `enabled` flag. THROWS on an unreachable/errored probe
// so the caller can distinguish a *definitive* answer (cache it) from a transient
// failure (don't cache — retry on the next mount). Caching a transient failure
// would hide Billing for the whole page-session even after the service recovers
// (e.g. the tab loaded while billing was mid-restart).
async function fetchBillingEnabled(): Promise<boolean> {
  const res = await api.getBillingConfig();
  return res.data?.enabled === true;
}

export function useBillingEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(cached ?? false);

  useEffect(() => {
    if (cached !== undefined) {
      setEnabled(cached);
      return;
    }
    let active = true;
    inflight = inflight ?? fetchBillingEnabled();
    void inflight
      .then((v) => {
        cached = v; // only a successful probe is memoised for the session
        if (active) setEnabled(v);
      })
      .catch(() => {
        // Transient failure: leave `cached` undefined so a later mount/navigation
        // retries; stay hidden for now rather than flash a link that may 502/503.
        if (active) setEnabled(false);
      })
      .finally(() => { inflight = null; });
    return () => { active = false; };
  }, []);

  return enabled;
}

/**
 * Tri-state variant: `true` (enabled) / `false` (definitively disabled) /
 * `undefined` (not yet known — probe in flight or failed). Callers that take an
 * IRREVERSIBLE action on the answer — e.g. the Billing page redirecting away when
 * billing is off — must use this and act only on the definitive `false`, never on
 * `undefined`, so the page doesn't bounce before the probe resolves. (The boolean
 * `useBillingEnabled` collapses unknown→false, which is right for hide/show but
 * wrong for a redirect.)
 */
export function useBillingEnabledState(): boolean | undefined {
  const [state, setState] = useState<boolean | undefined>(cached);

  useEffect(() => {
    if (cached !== undefined) {
      setState(cached);
      return;
    }
    let active = true;
    inflight = inflight ?? fetchBillingEnabled();
    void inflight
      .then((v) => {
        cached = v;
        if (active) setState(v);
      })
      .catch(() => {
        // Unknown (not disabled) — leave `cached` undefined so a later mount retries
        // and callers keep waiting rather than treating a blip as "disabled".
        if (active) setState(undefined);
      })
      .finally(() => { inflight = null; });
    return () => { active = false; };
  }, []);

  return state;
}
