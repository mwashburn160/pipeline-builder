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
/** The payment providers the deployment can run. */
export type BillingProvider = 'stripe' | 'aws-marketplace' | 'stub';

let cached: boolean | undefined;
let cachedProvider: BillingProvider | undefined;
let inflight: Promise<boolean> | null = null;

// Resolves to the probe's `enabled` flag. THROWS on an unreachable/errored probe
// so the caller can distinguish a *definitive* answer (cache it) from a transient
// failure (don't cache — retry). Caching a transient failure would hide Billing
// for the whole page-session even after the service recovers (e.g. the tab loaded
// while billing was mid-restart / mid-boot).
async function fetchBillingEnabled(): Promise<boolean> {
  const res = await api.getBillingConfig();
  // Cache the provider from the same probe so `useBillingProvider` needn't refetch.
  const p = res.data?.provider;
  if (p === 'stripe' || p === 'aws-marketplace' || p === 'stub') cachedProvider = p;
  return res.data?.enabled === true;
}

/**
 * The billing provider for this deployment (`stripe` | `aws-marketplace` | `stub`)
 * from the `/config` probe, or `undefined` until known. Lets the billing UI choose
 * the right subscribe flow — Stripe redirects to hosted Checkout to collect a card,
 * `stub` creates the subscription directly (no card).
 */
export function useBillingProvider(): BillingProvider | undefined {
  const [provider, setProvider] = useState<BillingProvider | undefined>(cachedProvider);
  useEffect(() => subscribeBillingEnabled(() => setProvider(cachedProvider)), []);
  return provider;
}

/**
 * Kick off the deployment-config probe and drive `onState` through its lifecycle:
 * `undefined` (unknown — in flight or transiently failed) → `true|false` (the
 * definitive, memoised answer). On a transient failure (billing unreachable/errored
 * — e.g. a 502 while the service is still booting) it RETRIES with bounded
 * exponential backoff instead of giving up.
 *
 * This retry is load-bearing: the Sidebar lives in the persistent app-router
 * layout, so its `useBillingEnabled` effect mounts ONCE and never re-runs on SPA
 * navigation. Without a retry, a single probe that lands in billing's boot window
 * (nginx 502 — and `core.request` throws on 502, it only auto-retries 503) would
 * hide the Billing + Discounts nav for the entire session until a hard reload.
 * That was the observed "billing sidebar not showing in local/docker" bug, where
 * every service boots together and billing has a ~60–90s cold-start window.
 *
 * Returns a cancel fn for the caller's effect cleanup.
 */
function subscribeBillingEnabled(onState: (v: boolean | undefined) => void): () => void {
  if (cached !== undefined) {
    onState(cached);
    return () => {};
  }

  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;

  const run = () => {
    inflight = inflight ?? fetchBillingEnabled();
    void inflight
      .then((v) => {
        cached = v; // only a definitive answer is memoised for the session
        if (active) onState(v);
      })
      .catch(() => {
        if (!active) return;
        // Transient/unknown — don't cache, surface as "not yet known", and retry
        // with capped backoff (1s, 2s, 4s … max 30s) until billing answers.
        onState(undefined);
        const delay = Math.min(30_000, 1_000 * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(run, delay);
      })
      .finally(() => { inflight = null; });
  };
  run();

  return () => { active = false; if (timer) clearTimeout(timer); };
}

export function useBillingEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(cached ?? false);
  // Collapse unknown→false: right for hide/show (don't flash a link before the
  // probe resolves), while the retry inside `subscribeBillingEnabled` guarantees
  // a mid-boot failure eventually flips it true rather than sticking at false.
  useEffect(() => subscribeBillingEnabled((v) => setEnabled(v === true)), []);
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
  // Same retrying probe; the tri-state caller keeps `undefined` (unknown) during
  // retries and acts only on a definitive `false`, so a mid-boot blip never
  // bounces the Billing page before billing has actually answered.
  useEffect(() => subscribeBillingEnabled(setState), []);
  return state;
}
