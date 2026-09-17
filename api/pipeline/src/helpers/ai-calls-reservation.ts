// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { decrementQuota, getServiceAuthHeader, reserveQuota, sendQuotaReserveDenied } from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import type { Response } from 'express';

/** The reserved `aiCalls` slot, handed to the guarded body. */
export interface AiCallsSlot {
  /**
   * Record that the AI provider has been reached (e.g. the first streamed
   * partial arrived). From here on a failure KEEPS the slot — the external $
   * cost was incurred.
   */
  markProviderContacted(): void;
  /**
   * Give the slot back NOW, regardless of provider contact — for paths that
   * decide explicitly (repo analysis failed before any LLM call, or the client
   * aborted and never consumed the output). Idempotent: refunds at most once.
   */
  refund(): void;
}

/**
 * Reserve one `aiCalls` slot, run `body`, and settle the slot by ONE rule:
 *
 *   keep the slot once the provider was contacted; refund only if it never was.
 *
 * - Reservation denied → answers 429/503 via `sendQuotaReserveDenied`; `body`
 *   never runs.
 * - `body` resolves → the slot is kept (unless `body` called `slot.refund()`).
 * - `body` throws → refunded unless the provider was contacted — either marked
 *   via `slot.markProviderContacted()` or signalled by the error itself carrying
 *   `providerContacted === true` (`AIEmptyOutputError`: the round-trip completed
 *   but produced nothing usable). Then `onError` answers the request.
 *
 * The S2S quota calls authenticate with a minted service token, never the
 * end-user bearer: the quota `/increment` endpoint rejects non-service principals.
 */
export async function withAiCallsReservation(
  args: {
    quotaService: QuotaService;
    orgId: string;
    res: Response;
    logWarn: (message: string, data?: unknown) => void;
  },
  body: (slot: AiCallsSlot) => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  const { quotaService, orgId, res, logWarn } = args;
  const serviceAuth = getServiceAuthHeader({ serviceName: 'pipeline', orgId, role: 'member' });

  // Reserve atomically BEFORE any LLM work: two concurrent generates at the
  // limit can't both burn a call.
  const reservation = await reserveQuota(quotaService, orgId, 'aiCalls', serviceAuth);
  if (reservation.exceeded) {
    sendQuotaReserveDenied(res, 'aiCalls', reservation);
    return;
  }

  let providerContacted = false;
  let refunded = false;
  const slot: AiCallsSlot = {
    markProviderContacted: () => { providerContacted = true; },
    refund: () => {
      if (refunded) return;
      refunded = true;
      // Pass the reserved resetAt so a period rollover doesn't get double-charged.
      decrementQuota(quotaService, orgId, 'aiCalls', serviceAuth, logWarn, 1, reservation.quota.resetAt);
    },
  };

  try {
    await body(slot);
  } catch (error) {
    const errorSaysContacted = (error as { providerContacted?: unknown } | null)?.providerContacted === true;
    if (!providerContacted && !errorSaysContacted) slot.refund();
    onError(error);
  }
}
