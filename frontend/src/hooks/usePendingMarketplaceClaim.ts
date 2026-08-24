// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';

/** Handle carrying a resolved AWS Marketplace registration across the sign-up /
 *  sign-in hop (set on the fulfillment page, consumed on the dashboard). */
const MARKETPLACE_REF_KEY = 'pb_marketplace_ref';

/** Persist the ref across an auth navigation. Writes BOTH sessionStorage and a
 *  short-lived cookie: sessionStorage covers the normal same-tab hop, and the
 *  cookie is the fallback when storage is blocked/unavailable (private mode,
 *  strict settings) — otherwise a brand-new purchaser's linkage would be lost
 *  silently after they sign up (AWS billing them for nothing). Returns whether at
 *  least one channel succeeded. */
export function stashMarketplaceRef(registrationRef: string, planName: string | null): boolean {
  const payload = JSON.stringify({ registrationRef, planName });
  let ok = false;
  try { sessionStorage.setItem(MARKETPLACE_REF_KEY, payload); ok = true; } catch { /* storage blocked */ }
  try {
    // 30-min cookie (matches the pending-registration TTL); not httpOnly so the
    // dashboard hook can read it, path=/ so it survives the auth navigation.
    document.cookie = `${MARKETPLACE_REF_KEY}=${encodeURIComponent(payload)}; path=/; max-age=1800; samesite=lax`;
    ok = true;
  } catch { /* cookies blocked too */ }
  return ok;
}

function readCookie(name: string): string | null {
  const m = typeof document !== 'undefined' ? document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`)) : null;
  return m ? decodeURIComponent(m[1]) : null;
}

/** Read the stashed ref from either channel (sessionStorage first, cookie fallback). */
export function readMarketplaceRef(): { registrationRef: string; planName: string | null } | null {
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(MARKETPLACE_REF_KEY); } catch { /* blocked */ }
  if (!raw) raw = readCookie(MARKETPLACE_REF_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { registrationRef?: string; planName?: string | null };
    return p.registrationRef ? { registrationRef: p.registrationRef, planName: p.planName ?? null } : null;
  } catch { return null; }
}

/** Clear the stashed ref from both channels. */
export function clearMarketplaceRef(): void {
  try { sessionStorage.removeItem(MARKETPLACE_REF_KEY); } catch { /* ignore */ }
  try { document.cookie = `${MARKETPLACE_REF_KEY}=; path=/; max-age=0`; } catch { /* ignore */ }
}

/**
 * Finish an in-flight AWS Marketplace registration once the purchaser is signed
 * in. A new purchaser resolves their token on `/marketplace/register`, stashes
 * the single-use `registrationRef`, then signs up / signs in — landing here.
 * This binds it to their now-active org.
 *
 * Retry semantics: a `ran` ref prevents re-firing within a single mount (no
 * loop). The stash is cleared only on a DEFINITIVE outcome — success, or a
 * server rejection (4xx/409/410, e.g. already-linked). A TRANSIENT failure
 * (network / thrown error) leaves the stash intact so a later dashboard visit
 * retries instead of silently dropping the linkage.
 */
export function usePendingMarketplaceClaim(): void {
  const { isAuthenticated, isInitialized } = useAuth();
  const toast = useToast();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current || !isInitialized || !isAuthenticated) return;
    const stashed = readMarketplaceRef();
    if (!stashed) return;

    ran.current = true; // loop guard for this mount

    api.claimMarketplaceRegistration(stashed.registrationRef)
      .then((res) => {
        if (res.success) {
          clearMarketplaceRef();
          toast.success('AWS Marketplace subscription linked to your organization');
        } else {
          // Definitive server rejection (e.g. already linked / org already has a
          // subscription) — retrying won't help, so consume the stash.
          clearMarketplaceRef();
          toast.error(res.message || 'Could not link your AWS Marketplace subscription');
        }
      })
      .catch((e) => {
        // Transient (network/5xx): keep the stash so a later visit retries.
        toast.error(formatError(e));
      });
  }, [isAuthenticated, isInitialized, toast]);
}
