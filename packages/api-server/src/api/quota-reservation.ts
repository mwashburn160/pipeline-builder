// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  decrementQuota,
  getServiceAuthHeader,
  reserveQuota,
  sendQuotaReserveDenied,
  serviceIdentity,
  type QuotaReserveResult,
  type QuotaService,
  type QuotaType,
} from '@pipeline-builder/api-core';
import type { Response } from 'express';

/** The reserved quota slot, handed to the guarded body. */
export interface QuotaSlot {
  /** Minted service token the reservation used — reuse it for the body's own S2S calls. */
  readonly serviceAuth: string;
  readonly reservation: QuotaReserveResult;
  /**
   * The reserved resource has been consumed (e.g. the AI provider started
   * responding). From here on a failure KEEPS the slot — the cost was incurred.
   */
  markConsumed(): void;
  /** Give the slot back now. Idempotent: refunds at most once. */
  refund(): void;
}

export interface QuotaReservationOptions {
  quotaService: QuotaService;
  orgId: string;
  type: QuotaType;
  /** Signer of the quota service token. Defaults to this process (`SERVICE_NAME`). */
  serviceName?: string;
  logWarn: (message: string, data?: unknown) => void;
  /** When set, a denied reservation is answered on it (429, or 503 when unconfirmable). */
  res?: Response;
}

export type QuotaReservationOutcome<T> =
  | { status: 'denied'; reservation: QuotaReserveResult }
  | { status: 'done'; value: T }
  /** Only with an `onError` handler: the body threw and the handler answered. */
  | { status: 'failed'; error: unknown };

/**
 * Reserve one quota slot, run `body`, and settle the slot by ONE rule:
 * keep it once the resource was consumed; refund it if the body fails first.
 *
 * - Denied → `{ status: 'denied' }` (answered on `res` when given); `body` never runs.
 * - `body` resolves → the slot is kept (unless `body` called `slot.refund()`).
 * - `body` throws → refunded unless consumed — marked via `slot.markConsumed()`
 *   or signalled by the error itself carrying `providerContacted === true`
 *   (an AI round-trip that completed but produced nothing usable). The error is
 *   then passed to `onError`, or rethrown when there is none.
 *
 * The reserve and refund authenticate with a minted service token, never the
 * end-user bearer: the quota increment endpoint rejects user principals.
 */
export async function withQuotaReservation<T>(
  opts: QuotaReservationOptions,
  body: (slot: QuotaSlot) => Promise<T>,
  onError?: (error: unknown) => void | Promise<void>,
): Promise<QuotaReservationOutcome<T>> {
  const { quotaService, orgId, type, logWarn } = opts;
  const serviceAuth = getServiceAuthHeader({ serviceName: opts.serviceName ?? serviceIdentity(), orgId, role: 'member' });

  // Reserve atomically BEFORE any work: two concurrent requests at the limit
  // can't both pass.
  const reservation = await reserveQuota(quotaService, orgId, type, serviceAuth);
  if (reservation.exceeded) {
    if (opts.res) sendQuotaReserveDenied(opts.res, type, reservation);
    return { status: 'denied', reservation };
  }

  let consumed = false;
  let refunded = false;
  const slot: QuotaSlot = {
    serviceAuth,
    reservation,
    markConsumed: () => { consumed = true; },
    refund: () => {
      if (refunded) return;
      refunded = true;
      // The reserved resetAt keeps a period rollover from being double-charged.
      decrementQuota(quotaService, orgId, type, serviceAuth, logWarn, 1, reservation.quota.resetAt);
    },
  };

  try {
    return { status: 'done', value: await body(slot) };
  } catch (error) {
    const errorSaysConsumed = (error as { providerContacted?: unknown } | null)?.providerContacted === true;
    if (!consumed && !errorSaysConsumed) slot.refund();
    if (!onError) throw error;
    await onError(error);
    return { status: 'failed', error };
  }
}
