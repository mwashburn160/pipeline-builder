// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import type { AskAvailability } from '@/lib/api/domains/ask';
import type { AskUiMode } from '@/types';

/**
 * Whether the Ask agent can answer right now (`GET /ask-agent/availability`),
 * or null until (or unless) the probe says.
 *
 * Which surface this drawer is: the agent, or help topics.
 *
 * Two independent reasons to show topics instead of the question box, and the
 * user should not have to discover either by asking a question that fails:
 *   * ASK_UI_MODE=help-topics — this deployment never offers the agent;
 *   * the agent is on but cannot answer — its self-hosted model is outside its
 *     business-hours window, or no provider is configured at all.
 *
 * The probe is skipped entirely in help-topics mode: nothing would act on the
 * answer, and the route is gated on an entitlement this surface does not need.
 *
 * FAILS OPEN. A probe that errors (a boot-window 502, a nginx hiccup) leaves
 * the agent on offer rather than hiding it — the assistant may well work, and
 * if the turn does fail the server's own 503 explains why. The opposite
 * default would let one transient error silently replace the product.
 */
export function useAskAvailability(askUiMode: AskUiMode): AskAvailability | null {
  const [availability, setAvailability] = useState<AskAvailability | null>(null);
  useEffect(() => {
    if (askUiMode === 'help-topics') return;
    let alive = true;
    // Inside an async IIFE so a SYNCHRONOUS throw is caught too, not just a
    // rejected promise: a client missing this method would otherwise throw
    // straight out of the effect and take the whole panel down with it.
    void (async () => {
      try {
        const res = await api.getAskAvailability();
        if (alive && res.success && res.data) setAvailability(res.data);
      } catch { /* fail open — see above */ }
    })();
    return () => { alive = false; };
  }, [askUiMode]);
  return availability;
}
