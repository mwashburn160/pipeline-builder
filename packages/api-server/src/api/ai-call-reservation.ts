// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  aiCallWeight,
  emitCounter,
  getServiceAuthHeader,
  quotaAttributionFromRequest,
  serviceIdentity,
  type AiKeySource,
  type QuotaReserveResult,
  type QuotaUsageAttribution,
} from '@pipeline-builder/api-core';
import type { Request } from 'express';

import {
  reserveQuotaSlot,
  runWithSlot,
  type QuotaReservationOptions,
  type QuotaReservationOutcome,
  type QuotaSlot,
} from './quota-reservation.js';

/**
 * Which product surface an AI call belongs to — the usage ledger's `feature`
 * dimension. `agent-tool:<name>` is a generation an agent TOOL runs in-process
 * (its own slot, beside the turn's).
 */
export type AiFeature =
  | 'ask'
  | 'agent'
  | `agent-tool:${string}`
  | 'pipeline-generate'
  | 'plugin-generate'
  | 'report-summary';

/** The part of a resolved model selection the reservation reads (ai-core `ResolvedModelSelection` fits). */
export interface AiCallSelection {
  provider: string;
  modelId: string;
  keySource: AiKeySource;
}

/**
 * Why an AI call spent no `aiCalls` unit:
 *  - `byok` — the org's own key or the caller's request key served it
 *    (`keySource !== 'platform'`): the customer pays the provider, not us;
 *  - `impersonation` — a sysadmin impersonation session: vendor staff neither
 *    spend the tenant's budget nor get locked out by it (mirrors the apiCalls
 *    exemption; the call is still audited);
 *  - `unweighted` — the model's `AI_MODEL_WEIGHTS` weight is 0 (by default the
 *    self-hosted OpenAI-compatible provider).
 * A waived call is still recorded in the usage ledger (zero units, its tokens).
 */
export type AiSlotWaiver = 'byok' | 'impersonation' | 'unweighted';

/** Token counts as the AI SDK / ai-core report them (missing → 0). */
export interface AiCallTokens {
  inputTokens?: number;
  outputTokens?: number;
}

/** A settled-by-rule `aiCalls` slot, plus what the AI path needs on top of {@link QuotaSlot}. */
export interface AiCallSlot extends QuotaSlot {
  /** Units reserved: the model's weight, or 0 when {@link waived}. */
  readonly amount: number;
  /** Set when no unit was reserved, and why. */
  readonly waived?: AiSlotWaiver;
  /** The attribution the reserve, refund and usage report carry. */
  readonly attribution: QuotaUsageAttribution;
  /**
   * Report the call's token usage to the usage ledger (once; later calls are
   * ignored). Fire-and-forget. Call it after the call settles — success, abort or
   * failure — with whatever usage the provider reported.
   */
  reportUsage(tokens: AiCallTokens | undefined): void;
}

export interface AiCallReservationOptions extends Omit<QuotaReservationOptions, 'type' | 'amount' | 'attribution'> {
  feature: AiFeature;
  /**
   * The inbound request, when there is one: its route pattern + verified
   * principal become the attribution, and an impersonation session waives the
   * slot. Absent for scheduled work, which passes {@link attribution} instead.
   */
  req?: Pick<Request, 'user' | 'route' | 'method' | 'baseUrl' | 'params' | 'headers'>;
  /** Attribution merged OVER the request's (a scheduler names its principal + route here). */
  attribution?: QuotaUsageAttribution;
}

/** The synthetic reservation a waived slot carries (nothing was reserved). */
function waivedReservation(): QuotaReserveResult {
  return { exceeded: false, quota: { type: 'aiCalls', limit: -1, used: 0, remaining: -1 } };
}

/** Attribution for one AI call: request (or explicit) + feature, model, keySource. */
function aiAttribution(opts: AiCallReservationOptions, selection: AiCallSelection): QuotaUsageAttribution {
  return {
    ...(opts.req ? quotaAttributionFromRequest(opts.req as Request) : {}),
    ...opts.attribution,
    feature: opts.feature,
    model: selection.modelId.slice(0, 200),
    keySource: selection.keySource,
  };
}

function waiverFor(opts: AiCallReservationOptions, selection: AiCallSelection, weight: number): AiSlotWaiver | undefined {
  if (selection.keySource !== 'platform') return 'byok';
  if (opts.req?.user?.impersonatorId) return 'impersonation';
  if (weight <= 0) return 'unweighted';
  return undefined;
}

/**
 * Reserve the `aiCalls` slot for ONE AI call on an already-resolved model —
 * or waive it — and return the handle; the caller settles it (`markConsumed()`
 * on the provider's first response, `refund()` on a pre-contact failure,
 * `reportUsage()` once settled). The primitive under
 * {@link withAiCallReservation}, for work that does not fit one callback (an
 * agent tool's in-process generation, a scheduled report summary).
 *
 * The model is resolved FIRST because it decides the charge:
 *  - a BYOK key (`keySource` `org` / `request`), an impersonation session or a
 *    weight-0 model reserves NOTHING ({@link AiSlotWaiver});
 *  - otherwise the reservation is `aiCallWeight(selection)` units (1 unless
 *    `AI_MODEL_WEIGHTS` says otherwise), attributed to the route, principal,
 *    feature, model and key source.
 * The quota service also applies the org's optional AI controls to that
 * reservation (per-member share, token budget) and answers a distinct 429 code.
 */
export async function reserveAiCallSlot(
  opts: AiCallReservationOptions,
  selection: AiCallSelection,
): Promise<{ status: 'denied'; reservation: QuotaReserveResult } | { status: 'reserved'; slot: AiCallSlot }> {
  const weight = aiCallWeight(selection);
  const waived = waiverFor(opts, selection, weight);
  const attribution = aiAttribution(opts, selection);

  let base: QuotaSlot;
  if (waived) {
    emitCounter('ai_quota_waived_total', { feature: featureLabel(opts.feature), reason: waived });
    // Nothing reserved, so nothing to keep or give back.
    base = {
      serviceAuth: getServiceAuthHeader({ serviceName: opts.serviceName ?? serviceIdentity(), orgId: opts.orgId, role: 'member' }),
      reservation: waivedReservation(),
      markConsumed: () => undefined,
      refund: () => undefined,
    };
  } else {
    const reserved = await reserveQuotaSlot({ ...opts, type: 'aiCalls', amount: weight, attribution });
    if (reserved.status === 'denied') return reserved;
    base = reserved.slot;
  }

  let consumed = false;
  let reported = false;
  const slot: AiCallSlot = {
    serviceAuth: base.serviceAuth,
    reservation: base.reservation,
    amount: waived ? 0 : weight,
    ...(waived ? { waived } : {}),
    attribution,
    markConsumed: () => { consumed = true; base.markConsumed(); },
    refund: () => base.refund(),
    reportUsage: (tokens) => {
      if (reported) return;
      reported = true;
      const tokensIn = tokens?.inputTokens ?? 0;
      const tokensOut = tokens?.outputTokens ?? 0;
      // A call that never reached the provider and spent no tokens has nothing
      // to record (its reservation, if any, was refunded and ledgered as such).
      if (tokensIn + tokensOut === 0 && !(waived && consumed)) return;
      void opts.quotaService.reportUsage?.(opts.orgId, 'aiCalls', base.serviceAuth, { tokensIn, tokensOut }, attribution);
    },
  };
  return { status: 'reserved', slot };
}

/**
 * Resolve the model, reserve (or waive) its `aiCalls` slot, run `body`, and
 * settle by the {@link withQuotaReservation} rule — keep once consumed, refund
 * when the body fails first.
 *
 * `resolve` runs BEFORE any reservation (its result decides the charge — see
 * {@link reserveAiCallSlot}); a resolution failure (AI switched off, an
 * unloadable org key, nothing configured) goes to `onError` with no slot taken.
 * Denied → `{ status: 'denied' }`, answered on `res` when given.
 */
export async function withAiCallReservation<T, S extends AiCallSelection>(
  opts: AiCallReservationOptions & { resolve: () => Promise<S> },
  body: (slot: AiCallSlot, selection: S) => Promise<T>,
  onError?: (error: unknown) => void | Promise<void>,
): Promise<QuotaReservationOutcome<T>> {
  let selection: S;
  try {
    selection = await opts.resolve();
  } catch (error) {
    if (!onError) throw error;
    await onError(error);
    return { status: 'failed', error };
  }
  const reserved = await reserveAiCallSlot(opts, selection);
  if (reserved.status === 'denied') return reserved;
  return runWithSlot(reserved.slot, (slot) => body(slot, selection), onError);
}

/** Bounded metric label: `agent-tool:<name>` collapses to `agent-tool`. */
function featureLabel(feature: AiFeature): string {
  return feature.startsWith('agent-tool:') ? 'agent-tool' : feature;
}
