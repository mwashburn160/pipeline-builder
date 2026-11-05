// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 2's gates: the holdout (D7), the frequency rate (D6), the expected-value
 * check (D18) and the hold decision (D17) — docs/plans/sales-agent.md.
 *
 * All PURE. Each takes facts and returns a verdict with a reason, so the offer
 * cycle is a sequence of decisions a test can drive one at a time, and every
 * refusal carries the suppression reason Phase 6 counts.
 */

import { createHash } from 'node:crypto';
import type { SuppressionReason } from '../models/offer.js';

/**
 * Fraction of accounts never offered to (D7).
 *
 * 10%, deterministic by a hash of the root org id. **Deterministic rather than
 * random per cycle** so an account's membership is stable: "an account that
 * flips in and out of the holdout is in neither group", and a holdout that
 * moves measures nothing.
 *
 * Env-tunable because it is a measurement-power decision, not a correctness
 * one: a small install needs a larger fraction to see a difference, and a large
 * one can afford less forgone revenue for the same confidence.
 */
export const DEFAULT_HOLDOUT_PERCENT = 10;

/**
 * The anti-flooding invariant: at most one offer per account per N days,
 * measured from SEND (D6).
 *
 * From SEND rather than from resolution, and the plan records why because the
 * mistake is easy to repeat: from resolution, a DECLINED offer resolves on day 2
 * and restarts the clock immediately while an IGNORED one resolves on day 30 —
 * so declining would earn a faster next offer than ignoring, rewarding the
 * account that engaged with the thing it asked not to receive. From send both
 * are 45, and the decline backoff applies on top, in the direction intended.
 */
export const DEFAULT_QUIET_PERIOD_DAYS = 45;

/** How long an offer stands. MUST be shorter than the quiet period (see below). */
export const DEFAULT_OFFER_EXPIRY_DAYS = 30;

/**
 * Extra quiet days after a DECLINE, on top of the window.
 *
 * The decline backoff D6 asks for. It only works because the window is measured
 * from send: added to a resolution-measured window it would compound with the
 * early-resolution bug and punish declining twice.
 */
export const DEFAULT_DECLINE_BACKOFF_DAYS = 90;

/**
 * Whether `expiryDays` is a legal configuration against `quietDays`.
 *
 * "The expiry must be shorter than the quiet period, or offers overlap and the
 * rate is undefined. An expiry at or past 45 is a CONFIGURATION ERROR and should
 * be REFUSED rather than clamped." Clamping would silently change the operator's
 * stated intent into a different policy.
 */
export function offerExpiryIsLegal(expiryDays: number, quietDays: number): boolean {
  return expiryDays > 0 && quietDays > 0 && expiryDays < quietDays;
}

/**
 * Is this account in the measurement holdout (D7)?
 *
 * SHA-256 of the org id, first four bytes as an integer, modulo 100. A hash
 * rather than a stored flag so membership needs no migration and no write, and
 * cannot drift between services that each want to know.
 */
export function inHoldout(orgId: string, percent: number = DEFAULT_HOLDOUT_PERCENT): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const digest = createHash('sha256').update(orgId).digest();
  return (digest.readUInt32BE(0) % 100) < percent;
}

export interface FrequencyInput {
  /** When the most recent offer was SENT, if any. */
  lastSentAt?: Date | null;
  /** Whether that offer was declined — earns the longer backoff. */
  lastWasDeclined?: boolean;
  quietDays?: number;
  declineBackoffDays?: number;
  now?: Date;
}

/**
 * Has enough time passed since the last offer was SENT?
 *
 * Returns the date the next offer becomes permissible, so a suppression row can
 * record WHEN rather than only that it was suppressed — which is what lets the
 * account's own settings surface say "you are inside your quiet period until X"
 * instead of leaving them wondering (F7).
 */
export function frequencyVerdict(input: FrequencyInput): { allowed: boolean; nextAllowedAt?: Date } {
  const { lastSentAt } = input;
  if (!lastSentAt) return { allowed: true };
  const quiet = input.quietDays ?? DEFAULT_QUIET_PERIOD_DAYS;
  const backoff = input.lastWasDeclined ? (input.declineBackoffDays ?? DEFAULT_DECLINE_BACKOFF_DAYS) : 0;
  const nextAllowedAt = new Date(lastSentAt.getTime() + (quiet + backoff) * 24 * 60 * 60 * 1000);
  const now = input.now ?? new Date();
  return now >= nextAllowedAt ? { allowed: true } : { allowed: false, nextAllowedAt };
}

export interface OfferCandidate {
  offerType: 'upgrade' | 'pack' | 'compose';
  /** Annualised value to the business if accepted, in cents. */
  valueCents: number;
  /** 0–1 estimate that the account accepts. */
  probability: number;
  /** When this candidate is expected to become available, if not now. */
  availableAt?: Date;
  rationale: string[];
}

/**
 * Expected value of making an offer, net of the cost of making it (D18).
 *
 * "Price the annoyance; suppression is an EV calculation, not a checklist." The
 * annoyance cost is real and asymmetric: an unwanted offer spends a slot, risks
 * an unsubscribe, and the unsubscribe rate is "the only metric here that
 * measures whether the account experienced this as useful or as spam, and the
 * one that cannot be fixed later by tuning a threshold."
 */
export function expectedValueCents(candidate: OfferCandidate, annoyanceCostCents: number): number {
  return Math.round(candidate.valueCents * clamp01(candidate.probability)) - annoyanceCostCents;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export interface HoldDecision {
  /** The candidate to offer now, or null to hold / not offer. */
  chosen: OfferCandidate | null;
  reason?: Extract<SuppressionReason, 'held_better_offer' | 'negative_ev' | 'no_rule_matched'>;
  /** For a hold: when the better candidate is expected. */
  holdUntil?: Date;
}

/**
 * Choose among candidates, or decline to offer because a better one is coming
 * (D17).
 *
 * "D6 allows one offer per account per 45 days. At six or so slots a year, the
 * scarce resource is not the budget, it is the SLOT" — so the question is not
 * "what is the best offer available now" but "is this the best offer expected
 * within the window". The plan's worked example: a credits pack worth ~$59/year
 * spent today forecloses a ~$650 crossover landing in two to three months.
 *
 * TWO BOUNDS on the hold, because "an agent that always expects something
 * better never offers anything":
 *
 *  - a future candidate must be expected INSIDE the window. Beyond it, holding
 *    buys nothing — the slot renews anyway;
 *  - it must beat the available one by a MARGIN, not by a rounding error. A
 *    1% better forecast is not worth forgoing a certain sale for.
 */
export function chooseOffer(input: {
  candidates: readonly OfferCandidate[];
  annoyanceCostCents: number;
  /** How far ahead a future candidate may be and still justify a hold. */
  windowDays?: number;
  /** How much better a future candidate must be, as a multiple. */
  holdMargin?: number;
  now?: Date;
}): HoldDecision {
  const now = input.now ?? new Date();
  const windowDays = input.windowDays ?? DEFAULT_QUIET_PERIOD_DAYS;
  const margin = input.holdMargin ?? 1.5;
  const horizon = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

  const available = input.candidates.filter((c) => !c.availableAt || c.availableAt <= now);
  const future = input.candidates.filter((c) => c.availableAt && c.availableAt > now && c.availableAt <= horizon);

  const bestAvailable = best(available, input.annoyanceCostCents);
  const bestFuture = best(future, input.annoyanceCostCents);

  if (!bestAvailable) {
    // Nothing offerable now. A future candidate still justifies recording a
    // HOLD rather than "no rule matched": the two are different findings, and
    // Phase 6 asks whether holds were vindicated.
    if (bestFuture) return { chosen: null, reason: 'held_better_offer', holdUntil: bestFuture.availableAt };
    return { chosen: null, reason: 'no_rule_matched' };
  }

  const availableEv = expectedValueCents(bestAvailable, input.annoyanceCostCents);
  // Negative EV is a refusal, not a low ranking: an offer whose expected value
  // is less than the annoyance it costs should not be made at any priority.
  if (availableEv <= 0) {
    if (bestFuture) return { chosen: null, reason: 'held_better_offer', holdUntil: bestFuture.availableAt };
    return { chosen: null, reason: 'negative_ev' };
  }

  if (bestFuture) {
    const futureEv = expectedValueCents(bestFuture, input.annoyanceCostCents);
    if (futureEv > availableEv * margin) {
      return { chosen: null, reason: 'held_better_offer', holdUntil: bestFuture.availableAt };
    }
  }

  return { chosen: bestAvailable };
}

function best(candidates: readonly OfferCandidate[], annoyanceCostCents: number): OfferCandidate | null {
  if (candidates.length === 0) return null;
  // Deterministic: ties break on the type order in OFFER_TYPES rather than on
  // array order, so the same inputs always choose the same offer. "Variance in
  // which offer an account receives is the one kind of inconsistency a customer
  // can actually catch you at."
  return [...candidates]
    .sort((a, b) => {
      const d = expectedValueCents(b, annoyanceCostCents) - expectedValueCents(a, annoyanceCostCents);
      return d !== 0 ? d : a.offerType.localeCompare(b.offerType);
    })[0]!;
}
