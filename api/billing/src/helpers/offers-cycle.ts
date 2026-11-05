// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 2's grant path — the decision an account actually experiences
 * (docs/plans/sales-agent.md).
 *
 * The cycle is a SEQUENCE OF REFUSALS, and the order is the design: the cheap
 * and absolute checks come first so an account that must not be offered to is
 * never evaluated against a rule, and the expensive judgement (D17's hold,
 * D18's EV) runs last on the few accounts that survive.
 *
 * Every outcome is a ROW, including every refusal. "Offers made, suppressed AND
 * WHY, PER REASON" is a product metric rather than plumbing: a feature
 * suppressing almost everything is misconfigured rather than careful, and that
 * is only visible if each reason is counted separately.
 *
 * NOTHING HERE MINTS ANYTHING YET. It decides, records the decision, and leaves
 * the discount grant to the existing promotion machinery (D2: extend the engine,
 * do not build a second one) — which is also what keeps the ceilings, the
 * campaign budget and the aggregate floor in one place.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { config } from '../config.js';
import {
  DEFAULT_HOLDOUT_PERCENT,
  DEFAULT_OFFER_EXPIRY_DAYS,
  DEFAULT_QUIET_PERIOD_DAYS,
  chooseOffer,
  frequencyVerdict,
  inHoldout,
  offerExpiryIsLegal,
  type OfferCandidate,
} from './offers-gates.js';
import { evaluateUsage, type ProfileLike } from './offers-rules.js';
import { Offer, type OfferStatus, type SuppressionReason } from '../models/offer.js';

const logger = createLogger('offers-cycle');

export interface AccountFacts {
  orgId: string;
  /** Profile history, NEWEST FIRST. */
  profiles: readonly ProfileLike[];
  /** The account's own `offersEnabled`, default true when never set. */
  accountOptIn: boolean;
  /** When the last offer was SENT, if any — the clock D6 measures from. */
  lastSentAt?: Date | null;
  lastWasDeclined?: boolean;
  /** On the manual do-not-offer list (D6). */
  doNotOffer?: boolean;
  /** Candidates the rules produced for this account. */
  candidates: readonly OfferCandidate[];
  /**
   * The Phase 4 signal, when one could be derived. ABSENT and `degraded` both
   * mean "no signal" — never "content".
   *
   * It is carried as an input to the decision rather than consulted inside it,
   * so the whole table stays pure and the model's only reachable effect is the
   * one refusal below.
   */
  frustration?: { frustrated: boolean; confidence: number; degraded: boolean } | null;
}

export interface CycleDecision {
  orgId: string;
  /** The offer to make, or null when none is. */
  chosen: OfferCandidate | null;
  status: OfferStatus | 'suppressed';
  reason?: SuppressionReason;
  holdUntil?: Date;
  holdout: boolean;
  expiresAt?: Date;
}

/**
 * Decide one account's outcome. PURE — no writes, no mints, no clock beyond
 * `now`, so the whole decision table is testable.
 *
 * The order of the checks is load-bearing:
 *
 *  1. the INSTANCE switch, because a deployment that has not agreed to solicit
 *     must not even evaluate rules;
 *  2. the ACCOUNT switch and the do-not-offer list, which are the account's own
 *     statement and outrank every signal;
 *  3. the HOLDOUT (D7), before any rule runs — a holdout account must be
 *     indistinguishable from one the rules declined, or the control group is
 *     contaminated by having been evaluated differently;
 *  4. the FREQUENCY rate (D6), which is the anti-flooding guarantee;
 *  5. profile COMPLETENESS (D8), failing closed;
 *  6. the rules, then D17/D18 — the only expensive step.
 */
export function decideForAccount(facts: AccountFacts, opts?: {
  now?: Date;
  holdoutPercent?: number;
  quietDays?: number;
  expiryDays?: number;
  annoyanceCostCents?: number;
}): CycleDecision {
  const now = opts?.now ?? new Date();
  const holdout = inHoldout(facts.orgId, opts?.holdoutPercent ?? DEFAULT_HOLDOUT_PERCENT);
  const base = { orgId: facts.orgId, chosen: null, holdout } as const;
  const no = (reason: SuppressionReason, extra?: Partial<CycleDecision>): CycleDecision =>
    ({ ...base, status: 'suppressed', reason, ...extra });

  // 1. The deployment switch, re-read every cycle rather than captured at boot.
  if (!config.enabled || !config.offersEnabled) return no('offers_disabled_instance');

  // 2. The account's own statement.
  if (!facts.accountOptIn || facts.doNotOffer) return no('offers_disabled_account');

  // 3. The holdout, BEFORE the rules. An account in the control group must not
  //    be treated differently in any way the measurement could notice.
  if (holdout) return no('holdout');

  // 4. The rate.
  const freq = frequencyVerdict({
    lastSentAt: facts.lastSentAt ?? null,
    lastWasDeclined: facts.lastWasDeclined,
    quietDays: opts?.quietDays,
    now,
  });
  if (!freq.allowed) return no('quiet_period', { holdUntil: freq.nextAllowedAt });

  // 5. Fail CLOSED on an unusable profile (D8). An offer argued from a partial
  //    read is argued from an artefact.
  const latest = facts.profiles[0];
  if (!latest || !latest.complete) return no('incomplete_profile');

  // 6. The one thing the MODEL may do (Phase 4, D5): suppress.
  //
  //    It runs after the profile gate and before the judgement, so a frustrated
  //    account is refused on its own named reason rather than disappearing into
  //    `negative_ev` — "we did not sell to them because they are unhappy with
  //    us" is an operational fact worth seeing separately.
  //
  //    A DEGRADED answer is no answer: an AI outage must not stop offers, and it
  //    must not grant them either. The confidence floor is deliberately high —
  //    the signal costs an offer when it is wrong, and a hesitant model should
  //    not be the reason an account was not told its options.
  if (facts.frustration && !facts.frustration.degraded
    && facts.frustration.frustrated
    && facts.frustration.confidence >= FRUSTRATION_CONFIDENCE_FLOOR) {
    return no('account_frustrated');
  }

  // 7. The judgement.
  const decision = chooseOffer({
    candidates: facts.candidates,
    annoyanceCostCents: opts?.annoyanceCostCents ?? DEFAULT_ANNOYANCE_COST_CENTS,
    windowDays: opts?.quietDays ?? DEFAULT_QUIET_PERIOD_DAYS,
    now,
  });
  if (!decision.chosen) {
    return no(decision.reason ?? 'no_rule_matched', { holdUntil: decision.holdUntil });
  }

  const expiryDays = opts?.expiryDays ?? DEFAULT_OFFER_EXPIRY_DAYS;
  const quietDays = opts?.quietDays ?? DEFAULT_QUIET_PERIOD_DAYS;
  // A configuration error, refused rather than clamped: an expiry at or past the
  // quiet period makes offers overlap and the rate undefined.
  if (!offerExpiryIsLegal(expiryDays, quietDays)) {
    logger.error('Offer expiry is not shorter than the quiet period — refusing to offer', { expiryDays, quietDays });
    return no('preflight_refused');
  }

  return {
    ...base,
    chosen: decision.chosen,
    status: 'sent',
    expiresAt: new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000),
  };
}

/**
 * What an unwanted offer costs, in cents, for D18's EV comparison.
 *
 * A PRICE on the annoyance rather than a checklist, and deliberately not small:
 * the unsubscribe rate is "the only metric here that measures whether the
 * account experienced this as useful or as spam, and the one that cannot be
 * fixed later by tuning a threshold." Setting this near zero turns the EV check
 * into a rubber stamp, which is the failure mode worth guarding against.
 */
export const DEFAULT_ANNOYANCE_COST_CENTS = 2_000;

/**
 * How sure the model has to be before its signal costs an account its offer.
 *
 * High, because the asymmetry runs the other way from the rest of the plan: a
 * false `frustrated` denies an account information it might have wanted, and
 * nothing downstream notices. A hesitant answer is therefore treated as no
 * answer rather than as a weak vote.
 */
export const FRUSTRATION_CONFIDENCE_FLOOR = 0.6;

/**
 * Persist one decision, idempotently.
 *
 * The unique `(orgId, cycleKey)` index is the idempotency key D15 asks for: a
 * cycle that runs twice, or two replicas that both won the lock, cannot produce
 * two offers for one account. That matters more here than for the profile store
 * because this row is paired with a grant — a duplicate is money.
 *
 * A duplicate is a NO-OP rather than an error: the first writer's decision
 * stands, and re-deciding would risk a second grant for the same slot.
 */
export async function recordDecision(
  decision: CycleDecision,
  cycleKey: string,
  source: 'agent' | 'manual' = 'agent',
  /**
   * The copy the account is about to be shown, stored WITH the decision.
   *
   * Passed in rather than rendered here because the row has to say what was
   * actually sent: the in-app card reads it back instead of re-deriving from
   * today's catalogue, which is how a card could otherwise restate last month's
   * offer at this month's price.
   */
  copy?: { subject: string; body: string },
): Promise<boolean> {
  try {
    await Offer.create({
      orgId: decision.orgId,
      offerType: decision.chosen?.offerType ?? 'pack',
      rationale: decision.chosen?.rationale ?? [],
      amountCents: 0,
      ...(decision.chosen?.targetTier ? { targetTier: decision.chosen.targetTier } : {}),
      ...(decision.chosen?.targetBundles?.length ? { targetBundles: decision.chosen.targetBundles } : {}),
      ...(copy && decision.status === 'sent' ? { subject: copy.subject, body: copy.body } : {}),
      status: decision.status === 'suppressed' ? 'withdrawn' : decision.status,
      ...(decision.status === 'sent' ? { sentAt: new Date(), expiresAt: decision.expiresAt } : {}),
      ...(decision.reason ? { suppressedReason: decision.reason } : {}),
      ...(decision.holdUntil ? { holdUntil: decision.holdUntil } : {}),
      holdout: decision.holdout,
      source,
      cycleKey,
    });
    return true;
  } catch (err) {
    if ((err as { code?: number } | null)?.code === 11000) return false;
    logger.warn('Could not record an offer decision', { orgId: decision.orgId, error: errorMessage(err) });
    return false;
  }
}

/**
 * Build the candidates a profile justifies. Pure, so the rules stay testable.
 *
 * `annualValueForDimension` is INJECTED rather than read from the catalogue
 * here, for two reasons: it keeps this function pure (the catalogue is env-
 * and tier-dependent), and it makes the value explicit. An earlier version of
 * this left pack and compose candidates at `valueCents: 0`, which is not a
 * missing figure but a silent REFUSAL — zero value against any annoyance cost
 * is negative EV (D18), so every pack offer would have been suppressed as
 * `negative_ev` while the feature looked like it was working.
 */
export function candidatesFor(input: {
  profiles: readonly ProfileLike[];
  /** Crossover verdict for this account, when one exists. */
  crossover?: { crossover: boolean; candidateTier: string | null; savingCents: number } | null;
  /**
   * Annualised revenue one pack on this dimension would add, in cents. Return
   * 0 for a dimension nothing is sold for — that candidate is then correctly
   * refused rather than offered at an invented value.
   */
  annualValueForDimension: (dimension: string) => number;
  /**
   * The bundle id a pack on this dimension would be, when one exists.
   *
   * Injected for the same reason as the value: it keeps this function pure, and
   * it guarantees the basket the account is shown is built from the SAME
   * resolver the value was computed with. Null means nothing is sold for the
   * dimension, which also means no candidate.
   */
  packIdForDimension?: (dimension: string) => string | null;
}): OfferCandidate[] {
  const out: OfferCandidate[] = [];
  const latest = input.profiles[0];
  if (!latest) return out;

  // The CROSSOVER first, and it needs no discount at all — "the cheapest offer
  // to make and the safest to get wrong". Its value to the business is the tier
  // delta the account moves onto, not the saving it realises.
  if (input.crossover?.crossover && input.crossover.candidateTier) {
    out.push({
      offerType: 'upgrade',
      targetTier: input.crossover.candidateTier,
      valueCents: Math.max(0, input.crossover.savingCents) * 12,
      // High, because the account is already paying more than the thing costs:
      // the argument makes itself and carries no discount to justify.
      probability: 0.4,
      rationale: ['crossover', `candidate_tier:${input.crossover.candidateTier}`],
    });
  }

  // CO-OCCURRENCE is what distinguishes a tier move from a pack sale (D4): one
  // dimension at 90% is a pack, three at once is a tier that no longer fits.
  const pressured = Object.entries(latest.dimensions)
    .filter(([, d]) => d.ratio !== null && d.ratio >= 0.8)
    .map(([type]) => type);

  if (pressured.length >= 3) {
    // The basket is worth the sum of what it contains — a compose offer sized to
    // three dimensions is three packs, which is also why it needs no discount.
    const valueCents = pressured.reduce((sum, p) => sum + input.annualValueForDimension(p), 0);
    if (valueCents > 0) {
      const basket = pressured
        .map((p) => ({ bundleId: input.packIdForDimension?.(p) ?? null, dimension: p }))
        .filter((b): b is { bundleId: string; dimension: string } => b.bundleId !== null)
        .map((b) => ({ bundleId: b.bundleId, quantity: 1 }));
      out.push({
        offerType: 'compose',
        valueCents,
        probability: 0.25,
        rationale: ['co_occurrence', ...pressured.map((p) => `pressure:${p}`)],
        ...(basket.length > 0 ? { targetBundles: basket } : {}),
      });
    }
  } else if (pressured.length >= 1) {
    const dimension = pressured[0]!;
    const sustained = evaluateUsage({ dimension, ratio: 0.8, sustainedPeriods: 3 }, input.profiles);
    // SUSTAINED, not instantaneous: "a spike-triggered offer is the fastest way
    // to make this feature feel like spam."
    const valueCents = input.annualValueForDimension(dimension);
    if (sustained.matches && valueCents > 0) {
      const bundleId = input.packIdForDimension?.(dimension) ?? null;
      out.push({
        offerType: 'pack',
        valueCents,
        probability: 0.3,
        rationale: ['sustained_pressure', `pressure:${dimension}`],
        ...(bundleId ? { targetBundles: [{ bundleId, quantity: 1 }] } : {}),
      });
    }
  }

  return out;
}

/** One add-on bundle, in the shape both the value resolver and the copy need. */
export interface PackLike {
  id: string;
  name: string;
  grants?: Record<string, number>;
  stackable: boolean;
  prices: { monthly: number; annual: number };
  availableForTiers: readonly string[];
}

/**
 * The cheapest pack that raises `dimension` for an account on `tier`, at
 * `interval` — ONE resolver, so the figure the EV was computed from and the
 * figure the mail quotes cannot be two different packs.
 *
 * Cheapest rather than largest, matching the quota card's `packForQuota` (F2)
 * exactly: the card is answering "what would it cost to not run out", the offer
 * is answering the same question, and an account shown two prices for one
 * problem stops believing either.
 *
 * Null when nothing in the catalogue grants the dimension, when no such pack is
 * sold to that tier, or when the pack is free — "$0" reads as a bug rather than
 * a bargain, and an offer with no price is one this plan refuses to send.
 */
export function packForDimension(
  dimension: string,
  bundles: readonly PackLike[],
  tier: string,
  interval: 'monthly' | 'annual' = 'annual',
): PackLike | null {
  const priceOf = (b: PackLike) => (interval === 'annual' ? b.prices.annual : b.prices.monthly);
  const candidates = bundles.filter((b) =>
    // A feature bundle that happens to carry a grant is not "a pack of N".
    b.stackable
    && (b.grants?.[dimension] ?? 0) > 0
    && b.availableForTiers.includes(tier)
    && priceOf(b) > 0);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, b) => (priceOf(b) < priceOf(best) ? b : best));
}

/**
 * The catalogue-backed value resolver `candidatesFor` needs: annualised revenue
 * from one pack on `dimension`, for an account on `tier`.
 *
 * Annual rather than monthly because every other figure in the EV comparison is
 * annual — the crossover's saving is multiplied by twelve, and comparing a
 * monthly pack against an annual tier move would make the pack look twelve
 * times weaker than it is and hold the slot forever.
 *
 * Zero when nothing in the catalogue grants that dimension, or nothing is sold
 * to that tier. Zero is the correct answer and the candidate is then refused:
 * there is no offer to make.
 */
export function annualPackValue(
  dimension: string,
  bundles: readonly PackLike[],
  tier: string,
): number {
  return packForDimension(dimension, bundles, tier, 'annual')?.prices.annual ?? 0;
}
