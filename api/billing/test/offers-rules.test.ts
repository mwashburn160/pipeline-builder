// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The GOLDEN PROFILES the plan asks for (docs/plans/sales-agent.md Phase 0):
 * "a handful of hand-built accounts covering each co-occurrence pattern, each
 * disqualifier, and the crossover case — asserted against the offer each should
 * produce, INCLUDING THE ONES THAT SHOULD PRODUCE NONE. In a repository with
 * eighteen thousand tests, a rule engine that decides discounts should not be
 * the part with none."
 *
 * Plus Phase 2's gates: the holdout (D7), the frequency rate (D6), the EV check
 * (D18) and the hold decision (D17).
 */

import { describe, it, expect } from '@jest/globals';

import {
  DEFAULT_OFFER_EXPIRY_DAYS,
  DEFAULT_QUIET_PERIOD_DAYS,
  chooseOffer,
  expectedValueCents,
  frequencyVerdict,
  inHoldout,
  offerExpiryIsLegal,
  type OfferCandidate,
} from '../src/helpers/offers-gates.js';
import {
  dimensionsUnderPressure,
  evaluateUsage,
  sustainedPeriods,
  type ProfileLike,
} from '../src/helpers/offers-rules.js';

// -- golden profiles ---------------------------------------------------------

function profile(over: Partial<ProfileLike> = {}): ProfileLike {
  return {
    period: '2026-11-01',
    dimensions: {},
    addonsHeld: [],
    subscriptionAgeDays: 400,
    complete: true,
    ...over,
  };
}

const dim = (ratio: number | null) => ({ ratio, crossed: null });

/** Outgrown its tier: three dimensions saturated, sustained over four periods. */
const OUTGROWN: ProfileLike[] = [1, 2, 3, 4].map((i) => profile({
  period: `2026-1${i}-01`,
  dimensions: { plugins: dim(0.95), cpuCredits: dim(0.91), pipelines: dim(0.85) },
}));

/** Busy fortnight: saturated NOW, idle before. The spike a rule must not act on. */
const SPIKE: ProfileLike[] = [
  profile({ dimensions: { plugins: dim(0.97) } }),
  profile({ dimensions: { plugins: dim(0.21) } }),
  profile({ dimensions: { plugins: dim(0.18) } }),
];

/** One dimension under pressure: a PACK sale, not a tier move. */
const ONE_DIMENSION: ProfileLike[] = [1, 2, 3].map(() => profile({
  dimensions: { cpuCredits: dim(0.93), plugins: dim(0.2) },
}));

describe('sustainedPeriods — a streak, not a count', () => {
  it('counts consecutive periods back from the newest', () => {
    expect(sustainedPeriods(OUTGROWN, 'plugins', 0.9)).toBe(4);
  });

  it('STOPS at the first period that breaks the streak', () => {
    // The whole point: an account saturated last spring and idle now is not a
    // candidate, and counting any three matching periods would make it one.
    expect(sustainedPeriods(SPIKE, 'plugins', 0.9)).toBe(1);
  });

  it('treats an ABSENT dimension as breaking the streak, not as skippable', () => {
    // Skipping would let two saturated periods either side of an unreadable one
    // count as consecutive — a claim the data does not support.
    const gapped = [profile({ dimensions: { a: dim(0.95) } }), profile({ dimensions: {} }), profile({ dimensions: { a: dim(0.95) } })];
    expect(sustainedPeriods(gapped, 'a', 0.9)).toBe(1);
  });

  it('treats a null ratio (unlimited) as breaking the streak', () => {
    const unlimited = [profile({ dimensions: { a: dim(0.95) } }), profile({ dimensions: { a: dim(null) } })];
    expect(sustainedPeriods(unlimited, 'a', 0.9)).toBe(1);
  });

  it('is zero on empty history rather than throwing', () => {
    expect(sustainedPeriods([], 'a', 0.9)).toBe(0);
  });
});

describe('dimensionsUnderPressure — co-occurrence is the intelligence', () => {
  it('counts the dimensions at or above the band', () => {
    // One at 90% is a pack sale; three at once is a tier that no longer fits.
    expect(dimensionsUnderPressure(OUTGROWN[0]!)).toBe(3);
    expect(dimensionsUnderPressure(ONE_DIMENSION[0]!)).toBe(1);
  });

  it('never counts an unlimited dimension, which cannot be under pressure', () => {
    expect(dimensionsUnderPressure(profile({ dimensions: { a: dim(null), b: dim(null) } }))).toBe(0);
  });
});

describe('evaluateUsage — the accounts that should get NOTHING', () => {
  it('refuses with no profile at all', () => {
    expect(evaluateUsage({ dimension: 'plugins', sustainedPeriods: 3 }, []))
      .toEqual({ matches: false, reason: 'no_profile' });
  });

  it('refuses an INCOMPLETE profile by default — the safe behaviour needs no opt-in', () => {
    const history = [profile({ complete: false, dimensions: { plugins: dim(0.95) } })];
    expect(evaluateUsage({ dimension: 'plugins' }, history))
      .toEqual({ matches: false, reason: 'incomplete_profile' });
  });

  it('allows an operator to opt OUT of the completeness requirement explicitly', () => {
    const history = [profile({ complete: false, dimensions: { plugins: dim(0.95) } })];
    expect(evaluateUsage({ dimension: 'plugins', requireCompleteProfile: false }, history).matches).toBe(true);
  });

  it('refuses the SPIKE: saturated now, idle before', () => {
    expect(evaluateUsage({ dimension: 'plugins', ratio: 0.9, sustainedPeriods: 3 }, SPIKE))
      .toEqual({ matches: false, reason: 'not_sustained' });
  });

  it('refuses a single-dimension account asked for co-occurrence', () => {
    expect(evaluateUsage({ minDimensionsUnderPressure: 3 }, ONE_DIMENSION))
      .toEqual({ matches: false, reason: 'too_few_dimensions' });
  });

  it('refuses an account that ALREADY HOLDS the pack being offered', () => {
    // The single most obvious way to look like nobody is paying attention.
    const history = [profile({ addonsHeld: ['cpu_credits_pack'], dimensions: { cpuCredits: dim(0.95) } })];
    expect(evaluateUsage({ lacksAddons: ['cpu_credits_pack'] }, history))
      .toEqual({ matches: false, reason: 'addon_already_held' });
  });

  it('refuses an account missing a required prerequisite add-on', () => {
    expect(evaluateUsage({ holdsAddons: ['compliance_standard'] }, [profile()]))
      .toEqual({ matches: false, reason: 'addon_missing' });
  });

  it('refuses a YOUNG account, which is not an expansion case', () => {
    expect(evaluateUsage({ minSubscriptionAgeDays: 90 }, [profile({ subscriptionAgeDays: 12 })]))
      .toEqual({ matches: false, reason: 'subscription_too_young' });
  });

  it('refuses when the named dimension is ABSENT rather than reading it as 0%', () => {
    // The profile omits a dimension it could not read; "0%" would silently
    // answer "not under pressure" for the one dimension nobody measured.
    expect(evaluateUsage({ dimension: 'storageBytes', sustainedPeriods: 1 }, [profile({ dimensions: { plugins: dim(0.95) } })]))
      .toEqual({ matches: false, reason: 'dimension_absent' });
  });
});

describe('evaluateUsage — the account that SHOULD be offered', () => {
  it('matches the outgrown account on sustained pressure and co-occurrence', () => {
    expect(evaluateUsage({
      dimension: 'plugins',
      ratio: 0.9,
      sustainedPeriods: 3,
      minDimensionsUnderPressure: 3,
      minSubscriptionAgeDays: 90,
      lacksAddons: ['plugin_pack'],
    }, OUTGROWN)).toEqual({ matches: true });
  });

  it('matches with no usage block at all, leaving the old behaviour untouched', () => {
    expect(evaluateUsage(undefined, []).matches).toBe(true);
  });
});

// -- Phase 2 gates -----------------------------------------------------------

describe('inHoldout (D7) — deterministic, so membership is stable', () => {
  it('gives the same answer every time for the same org', () => {
    // "An account that flips in and out of the holdout is in neither group."
    const first = inHoldout('org-abc');
    for (let i = 0; i < 20; i++) expect(inHoldout('org-abc')).toBe(first);
  });

  it('lands near the requested fraction across many ids', () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `org-${i}`);
    const share = ids.filter((id) => inHoldout(id, 10)).length / ids.length;
    expect(share).toBeGreaterThan(0.07);
    expect(share).toBeLessThan(0.13);
  });

  it('handles the degenerate fractions without a hash at all', () => {
    expect(inHoldout('anything', 0)).toBe(false);
    expect(inHoldout('anything', 100)).toBe(true);
  });
});

describe('frequencyVerdict (D6) — a RATE measured from SEND', () => {
  const sent = new Date('2026-01-01T00:00:00.000Z');
  const plus = (days: number) => new Date(sent.getTime() + days * 24 * 60 * 60 * 1000);

  it('allows the first offer, with nothing sent before', () => {
    expect(frequencyVerdict({})).toEqual({ allowed: true });
  });

  it('refuses inside the window and names WHEN the next offer may go', () => {
    // The date is what lets the account's settings surface say "you are inside
    // your quiet period until X" rather than leaving them wondering (F7).
    const v = frequencyVerdict({ lastSentAt: sent, now: plus(10) });
    expect(v.allowed).toBe(false);
    expect(v.nextAllowedAt).toEqual(plus(DEFAULT_QUIET_PERIOD_DAYS));
  });

  it('allows exactly on day 45, not a day later', () => {
    expect(frequencyVerdict({ lastSentAt: sent, now: plus(45) }).allowed).toBe(true);
    expect(frequencyVerdict({ lastSentAt: sent, now: plus(44) }).allowed).toBe(false);
  });

  it('makes DECLINING slower than ignoring, not faster', () => {
    // The bug the plan records: measured from resolution, a decline on day 2
    // restarted the clock immediately while an ignored offer resolved on day 30
    // — so declining earned a FASTER next offer than ignoring, rewarding the
    // account that engaged with what it asked not to receive.
    const ignored = frequencyVerdict({ lastSentAt: sent, now: plus(45) });
    const declined = frequencyVerdict({ lastSentAt: sent, lastWasDeclined: true, now: plus(45) });
    expect(ignored.allowed).toBe(true);
    expect(declined.allowed).toBe(false);
    expect(declined.nextAllowedAt!.getTime()).toBeGreaterThan(plus(45).getTime());
  });

  it('is independent of how long the offer stood', () => {
    // From send, expiry is a decision about how long the offer stands and
    // nothing else; from resolution a longer expiry silently lengthened the
    // whole cycle.
    const a = frequencyVerdict({ lastSentAt: sent, now: plus(45) });
    expect(a.allowed).toBe(true);
  });
});

describe('offerExpiryIsLegal — an overlapping expiry is a config error', () => {
  it('accepts the shipped pair and refuses an expiry at or past the window', () => {
    // "Refused rather than clamped": clamping silently turns the operator's
    // stated intent into a different policy.
    expect(offerExpiryIsLegal(DEFAULT_OFFER_EXPIRY_DAYS, DEFAULT_QUIET_PERIOD_DAYS)).toBe(true);
    expect(offerExpiryIsLegal(45, 45)).toBe(false);
    expect(offerExpiryIsLegal(60, 45)).toBe(false);
    expect(offerExpiryIsLegal(0, 45)).toBe(false);
  });
});

describe('expectedValueCents (D18) — price the annoyance', () => {
  const c = (over: Partial<OfferCandidate> = {}): OfferCandidate =>
    ({ offerType: 'pack', valueCents: 10_000, probability: 0.5, rationale: [], ...over });

  it('is value x probability, less the cost of making it', () => {
    expect(expectedValueCents(c(), 1_000)).toBe(4_000);
  });

  it('clamps a nonsense probability instead of producing a nonsense EV', () => {
    expect(expectedValueCents(c({ probability: 5 }), 0)).toBe(10_000);
    expect(expectedValueCents(c({ probability: -1 }), 0)).toBe(0);
    expect(expectedValueCents(c({ probability: Number.NaN }), 0)).toBe(0);
  });
});

describe('chooseOffer (D17) — the SLOT is the scarce resource', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');
  const inDays = (d: number) => new Date(now.getTime() + d * 24 * 60 * 60 * 1000);

  const pack: OfferCandidate = { offerType: 'pack', valueCents: 5_900, probability: 0.5, rationale: ['credits'] };
  const crossover: OfferCandidate = { offerType: 'upgrade', valueCents: 65_000, probability: 0.5, rationale: ['crossover'], availableAt: inDays(60) };
  const soonCrossover: OfferCandidate = { ...crossover, availableAt: inDays(30) };

  it('HOLDS the slot when a much better offer lands inside the window', () => {
    // The plan's worked example: spending the slot on a ~$59/year pack today
    // forecloses a ~$650 crossover two to three months out.
    const d = chooseOffer({ candidates: [pack, soonCrossover], annoyanceCostCents: 500, now });
    expect(d.chosen).toBeNull();
    expect(d.reason).toBe('held_better_offer');
    expect(d.holdUntil).toEqual(inDays(30));
  });

  it('does NOT hold for a candidate beyond the window — the slot renews anyway', () => {
    const d = chooseOffer({ candidates: [pack, crossover], annoyanceCostCents: 500, now });
    expect(d.chosen).toMatchObject({ offerType: 'pack' });
  });

  it('does NOT hold for a marginally better forecast', () => {
    // "An agent that always expects something better never offers anything."
    const barely: OfferCandidate = { offerType: 'upgrade', valueCents: 6_200, probability: 0.5, rationale: [], availableAt: inDays(10) };
    expect(chooseOffer({ candidates: [pack, barely], annoyanceCostCents: 500, now }).chosen)
      .toMatchObject({ offerType: 'pack' });
  });

  it('refuses a NEGATIVE-EV offer rather than ranking it last', () => {
    const weak: OfferCandidate = { offerType: 'pack', valueCents: 100, probability: 0.1, rationale: [] };
    const d = chooseOffer({ candidates: [weak], annoyanceCostCents: 5_000, now });
    expect(d).toMatchObject({ chosen: null, reason: 'negative_ev' });
  });

  it('records no_rule_matched when nothing is offerable now or later', () => {
    expect(chooseOffer({ candidates: [], annoyanceCostCents: 0, now }))
      .toMatchObject({ chosen: null, reason: 'no_rule_matched' });
  });

  it('holds rather than reporting negative_ev when a future candidate exists', () => {
    // Different findings: Phase 6 asks whether holds were VINDICATED, and a
    // hold recorded as "nothing matched" cannot be audited that way.
    const weak: OfferCandidate = { offerType: 'pack', valueCents: 100, probability: 0.1, rationale: [] };
    const d = chooseOffer({ candidates: [weak, soonCrossover], annoyanceCostCents: 5_000, now });
    expect(d).toMatchObject({ chosen: null, reason: 'held_better_offer' });
  });

  it('is DETERMINISTIC on a tie, because variance is what a customer catches you at', () => {
    const a: OfferCandidate = { offerType: 'pack', valueCents: 10_000, probability: 0.5, rationale: [] };
    const b: OfferCandidate = { offerType: 'compose', valueCents: 10_000, probability: 0.5, rationale: [] };
    const first = chooseOffer({ candidates: [a, b], annoyanceCostCents: 0, now }).chosen;
    for (let i = 0; i < 10; i++) {
      expect(chooseOffer({ candidates: [b, a], annoyanceCostCents: 0, now }).chosen).toEqual(first);
    }
  });
});
