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

async function fetchBillingEnabled(): Promise<boolean> {
  try {
    const res = await api.getBillingConfig();
    return res.data?.enabled === true;
  } catch {
    // Probe unreachable → treat as disabled (hide the link rather than show a
    // link that may 502/503).
    return false;
  }
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
    void inflight.then((v) => {
      cached = v;
      inflight = null;
      if (active) setEnabled(v);
    });
    return () => { active = false; };
  }, []);

  return enabled;
}
