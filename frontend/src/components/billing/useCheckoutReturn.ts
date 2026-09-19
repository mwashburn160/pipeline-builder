// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import { useToast } from '@/components/ui/Toast';
import { queries } from '@/lib/api-cache';
import { runQuery } from '@/lib/query-cache';

/** Polls for the webhook-provisioned subscription this many times after a Checkout return. */
const ACTIVATION_POLLS = 6;
const ACTIVATION_POLL_STEP_MS = 1500;

/**
 * Handle a return from hosted Checkout (`?checkout=success|cancelled`).
 *
 * The subscription is provisioned ASYNCHRONOUSLY by the webhook, so on success
 * this polls a few times (with backoff) until it appears — a single immediate
 * refetch usually races the webhook and shows the user as un-subscribed — then
 * calls `onActivated`. The query param is stripped so a reload won't re-toast.
 */
export function useCheckoutReturn(onActivated: () => Promise<void> | void): void {
  const router = useRouter();
  const toast = useToast();
  const onActivatedRef = useRef(onActivated);
  onActivatedRef.current = onActivated;

  useEffect(() => {
    const outcome = Array.isArray(router.query.checkout) ? router.query.checkout[0] : router.query.checkout;
    if (!outcome) return;
    let cancelled = false;
    if (outcome === 'success') {
      toast.success('Checkout complete — activating your subscription…');
      void (async () => {
        for (let i = 0; i < ACTIVATION_POLLS && !cancelled; i++) {
          // Forced: this loop is waiting for the webhook to provision the
          // subscription, so a cached "not yet" would spin out the whole poll.
          const res = await runQuery(queries.subscription(), { force: true }).catch(() => null);
          if (res?.success && res.data?.subscription) break;
          await new Promise((r) => setTimeout(r, ACTIVATION_POLL_STEP_MS * (i + 1)));
        }
        if (!cancelled) await onActivatedRef.current();
      })();
    } else if (outcome === 'cancelled') {
      toast.info('Checkout cancelled — no changes were made.');
    }
    const { checkout: _omit, ...rest } = router.query;
    void router.replace({ query: rest }, undefined, { shallow: true });
    return () => { cancelled = true; };
  }, [router.query.checkout]); // eslint-disable-line react-hooks/exhaustive-deps
}
