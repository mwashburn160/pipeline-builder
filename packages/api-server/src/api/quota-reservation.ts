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
  type QuotaUsageAttribution,
} from '@pipeline-builder/api-core';
import type { Response } from 'express';

/** The reserved quota slot, handed to the guarded body. */
export interface QuotaSlot {
  /** Minted service token the reservation used — reuse it for the body's own S2S calls. */
  readonly serviceAuth: string;
  readonly reservation: QuotaReserveResult;
  /**
   * The reserved resource has been consumed. From here on a failure KEEPS the
   * slot — the cost was incurred.
   *
   * For an AI call that moment is when the request is SENT to the provider, not
   * when it answers: a provider bills the tokens it processed for a call that is
   * then aborted, times out or errors mid-generation. So an AI caller marks the
   * slot consumed immediately before it sends, and only a failure BEFORE the send
   * (model resolution, prompt building, a precondition) is refunded.
   */
  markConsumed(): void;
  /** True once {@link markConsumed} was called — the slot will be kept. */
  isConsumed(): boolean;
  /**
   * Give the slot back now. Idempotent: refunds at most once — and a NO-OP once
   * {@link markConsumed} was called. A sent provider call is never refunded,
   * whatever path (a client abort, a timeout, a later failure, an empty answer)
   * asks for it afterwards; callers need no "was the provider contacted" guard
   * of their own around `refund()`.
   */
  refund(): void;
}

export interface QuotaReservationOptions {
  quotaService: QuotaService;
  orgId: string;
  type: QuotaType;
  /** Units to reserve (default 1) — e.g. an AI model's weight. Refunds give back the same amount. */
  amount?: number;
  /**
   * Usage-ledger attribution for the reserve AND its refund. Defaults to the
   * ambient request context (principal + request id, no route) — pass it
   * explicitly to record the route, the feature and the model.
   */
  attribution?: QuotaUsageAttribution;
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

/** What {@link reserveQuotaSlot} hands back: a live slot, or the denial. */
export type QuotaSlotReservation =
  | { status: 'denied'; reservation: QuotaReserveResult }
  | { status: 'reserved'; slot: QuotaSlot };

/**
 * Reserve one slot (of `amount` units) and return its handle, WITHOUT running
 * anything. The primitive under {@link withQuotaReservation}, for a caller whose
 * gated work does not fit one callback — e.g. a tool inside an agent turn that
 * settles its own slot. The caller owns settlement: `markConsumed()` once the
 * resource is spent (an AI call: when the request is sent), `refund()` on every
 * path that fails before that.
 *
 * Denied → `{ status: 'denied' }`, answered on `res` when given.
 */
export async function reserveQuotaSlot(opts: QuotaReservationOptions): Promise<QuotaSlotReservation> {
  const { quotaService, orgId, type, logWarn, attribution } = opts;
  const amount = opts.amount ?? 1;
  const serviceAuth = getServiceAuthHeader({ serviceName: opts.serviceName ?? serviceIdentity(), orgId, role: 'member' });

  // Reserve atomically BEFORE any work: two concurrent requests at the limit
  // can't both pass. Attribution defaults to the ambient request context
  // (principal + request id) inside the quota client.
  const reservation = await reserveQuota(quotaService, orgId, type, serviceAuth, amount, attribution);
  if (reservation.exceeded) {
    if (opts.res) sendQuotaReserveDenied(opts.res, type, reservation);
    return { status: 'denied', reservation };
  }

  let consumed = false;
  let refunded = false;
  // A fail-open pass (QUOTA_RESERVE_FAIL_OPEN, quota service unreachable)
  // reserved NOTHING, so a refund must not decrement a unit never counted.
  const reservedUnits = reservation.failOpen !== true;
  const slot: QuotaSlot = {
    serviceAuth,
    reservation,
    markConsumed: () => { consumed = true; },
    isConsumed: () => consumed,
    refund: () => {
      if (refunded || consumed) return;
      refunded = true;
      if (!reservedUnits) return;
      // The reserved resetAt keeps a period rollover from being double-charged.
      decrementQuota(quotaService, orgId, type, serviceAuth, logWarn, amount, reservation.quota.resetAt, attribution);
    },
  };
  return { status: 'reserved', slot };
}

/**
 * Run `body` against a reserved slot and settle it by ONE rule: keep it once
 * the resource was consumed; refund it if the body fails first. Shared by
 * {@link withQuotaReservation} and api-server's AI reservation.
 */
export async function runWithSlot<T, S extends QuotaSlot>(
  slot: S,
  body: (slot: S) => Promise<T>,
  onError?: (error: unknown) => void | Promise<void>,
): Promise<QuotaReservationOutcome<T>> {
  try {
    return { status: 'done', value: await body(slot) };
  } catch (error) {
    // `refund()` is itself a no-op once the slot was marked consumed — the ONE
    // signal that the resource was spent. Nothing on the error is consulted.
    slot.refund();
    if (!onError) throw error;
    await onError(error);
    return { status: 'failed', error };
  }
}

/**
 * Reserve one quota slot, run `body`, and settle the slot by ONE rule:
 * keep it once the resource was consumed; refund it if the body fails first.
 *
 * - Denied → `{ status: 'denied' }` (answered on `res` when given); `body` never runs.
 * - `body` resolves → the slot is kept (unless `body` called `slot.refund()`
 *   BEFORE marking it consumed — a refund after `markConsumed()` is ignored).
 * - `body` throws → refunded unless `slot.markConsumed()` was called first (an AI
 *   body calls it as it SENDS the request, so an abort, a timeout or a provider
 *   error after the send keeps the slot). The error is then passed to `onError`,
 *   or rethrown when there is none.
 *
 * The reserve and refund authenticate with a minted service token, never the
 * end-user bearer: the quota increment endpoint rejects user principals.
 */
export async function withQuotaReservation<T>(
  opts: QuotaReservationOptions,
  body: (slot: QuotaSlot) => Promise<T>,
  onError?: (error: unknown) => void | Promise<void>,
): Promise<QuotaReservationOutcome<T>> {
  const reserved = await reserveQuotaSlot(opts);
  if (reserved.status === 'denied') return reserved;
  return runWithSlot(reserved.slot, body, onError);
}
