// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 2's grant path (docs/plans/sales-agent.md): the decision an account
 * actually experiences.
 *
 * The cycle is a SEQUENCE OF REFUSALS and the ORDER is the design, so the order
 * is what these assert: a deployment that has not agreed to solicit never
 * evaluates a rule, an account's own statement outranks every signal, and the
 * holdout is applied before any rule runs so the control group cannot be
 * contaminated by having been evaluated differently.
 */

import { describe, it, expect } from '@jest/globals';

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-offers-cycle';

const {
  decideForAccount, candidatesFor, annualPackValue, packForDimension,
  DEFAULT_ANNOYANCE_COST_CENTS, FRUSTRATION_CONFIDENCE_FLOOR,
} = await import('../src/helpers/offers-cycle.js');
const { inHoldout } = await import('../src/helpers/offers-gates.js');
const { config } = await import('../src/config.js');

type Facts = Parameters<typeof decideForAccount>[0];

const dim = (ratio: number | null) => ({ ratio, crossed: null });

function profile(over: Record<string, unknown> = {}) {
  return {
    period: '2026-11-01',
    dimensions: { plugins: dim(0.95) },
    addonsHeld: [],
    subscriptionAgeDays: 400,
    complete: true,
    ...over,
  } as Facts['profiles'][number];
}

/** An org id that is NOT in the 10% holdout, so holdout never masks a case. */
const OFFERABLE = (() => {
  for (let i = 0; i < 500; i++) if (!inHoldout(`org-${i}`)) return `org-${i}`;
  throw new Error('no non-holdout id found');
})();
/** …and one that IS. */
const HELD_OUT = (() => {
  for (let i = 0; i < 500; i++) if (inHoldout(`org-${i}`)) return `org-${i}`;
  throw new Error('no holdout id found');
})();

const STRONG = { offerType: 'pack' as const, valueCents: 50_000, probability: 0.5, rationale: ['sustained_pressure'] };

function facts(over: Partial<Facts> = {}): Facts {
  return {
    orgId: OFFERABLE,
    profiles: [profile()],
    accountOptIn: true,
    candidates: [STRONG],
    ...over,
  };
}

describe('decideForAccount — the order of refusals', () => {
  it('offers the strong candidate when nothing refuses', () => {
    const d = decideForAccount(facts());
    expect(d.status).toBe('sent');
    expect(d.chosen).toMatchObject({ offerType: 'pack' });
    expect(d.expiresAt).toBeInstanceOf(Date);
  });

  it('refuses on the INSTANCE switch before anything else is considered', () => {
    // A deployment that has not agreed to solicit must not even evaluate rules.
    const original = config.offersEnabled;
    try {
      (config as { offersEnabled: boolean }).offersEnabled = false;
      // Everything else about this account argues for an offer.
      const d = decideForAccount(facts());
      expect(d).toMatchObject({ status: 'suppressed', reason: 'offers_disabled_instance' });
    } finally {
      (config as { offersEnabled: boolean }).offersEnabled = original;
    }
  });

  it('refuses on the ACCOUNT switch, which outranks every signal', () => {
    expect(decideForAccount(facts({ accountOptIn: false })))
      .toMatchObject({ status: 'suppressed', reason: 'offers_disabled_account' });
  });

  it('refuses on the manual do-not-offer list', () => {
    expect(decideForAccount(facts({ doNotOffer: true })))
      .toMatchObject({ status: 'suppressed', reason: 'offers_disabled_account' });
  });

  it('refuses a HOLDOUT account before any rule runs', () => {
    // The control group must be indistinguishable from an account the rules
    // declined — evaluating it differently contaminates the measurement.
    const d = decideForAccount(facts({ orgId: HELD_OUT }));
    expect(d).toMatchObject({ status: 'suppressed', reason: 'holdout', holdout: true });
  });

  it('marks every decision with holdout membership, offered or not', () => {
    expect(decideForAccount(facts()).holdout).toBe(false);
    expect(decideForAccount(facts({ orgId: HELD_OUT })).holdout).toBe(true);
  });

  it('refuses inside the quiet period and says WHEN the next offer may go', () => {
    const sent = new Date('2026-11-01T00:00:00.000Z');
    const d = decideForAccount(facts({ lastSentAt: sent }), { now: new Date('2026-11-10T00:00:00.000Z') });
    expect(d).toMatchObject({ status: 'suppressed', reason: 'quiet_period' });
    expect(d.holdUntil).toBeInstanceOf(Date);
  });

  it('fails CLOSED on an incomplete profile (D8)', () => {
    expect(decideForAccount(facts({ profiles: [profile({ complete: false })] })))
      .toMatchObject({ status: 'suppressed', reason: 'incomplete_profile' });
  });

  it('fails CLOSED with no profile at all', () => {
    expect(decideForAccount(facts({ profiles: [] })))
      .toMatchObject({ status: 'suppressed', reason: 'incomplete_profile' });
  });

  it('refuses a NEGATIVE-EV candidate rather than offering it weakly', () => {
    const weak = { offerType: 'pack' as const, valueCents: 100, probability: 0.1, rationale: [] };
    expect(decideForAccount(facts({ candidates: [weak] })))
      .toMatchObject({ status: 'suppressed', reason: 'negative_ev' });
  });

  it('HOLDS the slot for a better offer landing inside the window (D17)', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const later = new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000);
    const big = { offerType: 'upgrade' as const, valueCents: 650_000, probability: 0.5, rationale: ['crossover'], availableAt: later };
    const d = decideForAccount(facts({ candidates: [STRONG, big] }), { now });
    expect(d).toMatchObject({ status: 'suppressed', reason: 'held_better_offer' });
    expect(d.holdUntil).toEqual(later);
  });

  it('REFUSES rather than clamps an expiry at or past the quiet period', () => {
    // Clamping would silently turn the operator's stated policy into another.
    expect(decideForAccount(facts(), { expiryDays: 45, quietDays: 45 }))
      .toMatchObject({ status: 'suppressed', reason: 'preflight_refused' });
  });

  it('records no_rule_matched when the rules produced nothing', () => {
    expect(decideForAccount(facts({ candidates: [] })))
      .toMatchObject({ status: 'suppressed', reason: 'no_rule_matched' });
  });
});

describe('candidatesFor — what a profile justifies', () => {
  const value = (d: string) => (d === 'plugins' ? 11_990 : 2_990);

  it('proposes the CROSSOVER with no discount, valued on the annual delta', () => {
    const out = candidatesFor({
      profiles: [profile()],
      crossover: { crossover: true, candidateTier: 'business', savingCents: 2_996 },
      annualValueForDimension: value,
    });
    expect(out[0]).toMatchObject({ offerType: 'upgrade', valueCents: 2_996 * 12 });
    expect(out[0]!.rationale).toContain('crossover');
  });

  it('proposes COMPOSE when three dimensions are under pressure, not a pack', () => {
    // One dimension at 90% is a pack sale; three at once is a tier that no
    // longer fits, and a basket is the answer that needs no discount.
    const out = candidatesFor({
      profiles: [profile({ dimensions: { plugins: dim(0.95), cpuCredits: dim(0.9), pipelines: dim(0.85) } })],
      annualValueForDimension: value,
    });
    expect(out.map((c) => c.offerType)).toEqual(['compose']);
    // The basket is worth the sum of what it contains.
    expect(out[0]!.valueCents).toBe(11_990 + 2_990 + 2_990);
  });

  it('proposes a PACK only when the pressure is SUSTAINED', () => {
    const sustained = [1, 2, 3].map(() => profile({ dimensions: { plugins: dim(0.95) } }));
    expect(candidatesFor({ profiles: sustained, annualValueForDimension: value }).map((c) => c.offerType))
      .toEqual(['pack']);
    // A single saturated period is a spike, and "a spike-triggered offer is the
    // fastest way to make this feature feel like spam".
    expect(candidatesFor({ profiles: [profile()], annualValueForDimension: value })).toEqual([]);
  });

  it('proposes NOTHING for a dimension nothing is sold for', () => {
    // Zero value is the correct answer, and the candidate is refused rather
    // than offered at an invented price. (An earlier version left every pack at
    // value 0, which silently suppressed all of them as negative EV.)
    const sustained = [1, 2, 3].map(() => profile({ dimensions: { plugins: dim(0.95) } }));
    expect(candidatesFor({ profiles: sustained, annualValueForDimension: () => 0 })).toEqual([]);
  });

  it('proposes nothing with no profile at all', () => {
    expect(candidatesFor({ profiles: [], annualValueForDimension: value })).toEqual([]);
  });

  it('gives every pack candidate an EV that can actually clear the annoyance cost', () => {
    // The regression that matters: a candidate whose value cannot beat the
    // annoyance price is a feature that looks like it works and never offers.
    const sustained = [1, 2, 3].map(() => profile({ dimensions: { plugins: dim(0.95) } }));
    const [pack] = candidatesFor({ profiles: sustained, annualValueForDimension: value });
    expect(pack!.valueCents * pack!.probability).toBeGreaterThan(DEFAULT_ANNOYANCE_COST_CENTS);
  });
});

describe('annualPackValue — the catalogue figure, annualised', () => {
  // Annotated, because an entry with `grants: {}` widens the inferred element
  // type into a union the resolver's parameter will not accept — jest never
  // sees it, `typecheck:tests` does.
  const bundles: Parameters<typeof annualPackValue>[1] = [
    { id: 'plugin_pack', name: 'Plugin pack', grants: { plugins: 10 }, stackable: true, prices: { monthly: 1199, annual: 11990 }, availableForTiers: ['team'] },
    { id: 'big_pack', name: 'Big pack', grants: { plugins: 25 }, stackable: true, prices: { monthly: 2999, annual: 29990 }, availableForTiers: ['team'] },
    { id: 'feature', name: 'A feature', grants: {}, stackable: false, prices: { monthly: 3000, annual: 30000 }, availableForTiers: ['team'] },
  ];

  it('takes the cheapest pack, matching what the quota card quotes', () => {
    // The offer and the card must name the same pack, or the account is shown
    // two prices for the same problem.
    expect(annualPackValue('plugins', bundles, 'team')).toBe(11990);
  });

  it('is zero for a dimension nothing grants, or a tier nothing is sold to', () => {
    expect(annualPackValue('aiCalls', bundles, 'team')).toBe(0);
    expect(annualPackValue('plugins', bundles, 'developer')).toBe(0);
  });

  it('ignores a non-stackable bundle, which is not "a pack of N"', () => {
    const only = [{ ...bundles[2]!, grants: { plugins: 5 } }];
    expect(annualPackValue('plugins', only, 'team')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — the one thing the model may do
// ---------------------------------------------------------------------------

describe('the frustration signal can only SUPPRESS (D5)', () => {
  it('refuses an otherwise-valid offer to a frustrated account', () => {
    const d = decideForAccount(facts({
      frustration: { frustrated: true, confidence: 0.9, degraded: false },
    }));
    expect(d.status).toBe('suppressed');
    // Its OWN reason, not `negative_ev`: "we did not sell to them because they
    // are unhappy with us" is a different operational fact from "the arithmetic
    // said no", and the second would hide the first.
    expect(d.reason).toBe('account_frustrated');
  });

  it('treats a DEGRADED answer as no answer — an AI outage must not stop offers', () => {
    const d = decideForAccount(facts({
      frustration: { frustrated: true, confidence: 1, degraded: true },
    }));
    expect(d.status).toBe('sent');
  });

  it('treats a hesitant answer as no answer', () => {
    // The asymmetry runs the other way from the rest of the plan: a false
    // `frustrated` denies an account information and nothing notices.
    const d = decideForAccount(facts({
      frustration: { frustrated: true, confidence: FRUSTRATION_CONFIDENCE_FLOOR - 0.01, degraded: false },
    }));
    expect(d.status).toBe('sent');
  });

  it('is absent-safe: no signal behaves exactly as before', () => {
    expect(decideForAccount(facts({ frustration: null })).status).toBe('sent');
    expect(decideForAccount(facts()).status).toBe('sent');
  });

  it('cannot WIDEN anything — a content account still gets only what the rules allow', () => {
    const d = decideForAccount(facts({
      candidates: [],
      frustration: { frustrated: false, confidence: 0.99, degraded: false },
    }));
    expect(d.status).toBe('suppressed');
    expect(d.reason).toBe('no_rule_matched');
  });

  it('runs AFTER the account\'s own statement, which outranks every signal', () => {
    const d = decideForAccount(facts({
      accountOptIn: false,
      frustration: { frustrated: false, confidence: 0.99, degraded: false },
    }));
    expect(d.reason).toBe('offers_disabled_account');
  });
});

// ---------------------------------------------------------------------------
// F6 — what was proposed, recorded on the offer
// ---------------------------------------------------------------------------

describe('candidates carry WHAT was proposed (F6)', () => {
  // Annotated for the same reason the fixture above is: the differing `grants`
  // keys widen the inferred element type into a union the resolver's parameter
  // will not accept. Jest never sees it; `typecheck:tests` does.
  const PACKS: Parameters<typeof annualPackValue>[1] = [
    { id: 'pipeline_pack', name: 'Pipeline pack', grants: { pipelines: 10 }, stackable: true, prices: { monthly: 1199, annual: 11_990 }, availableForTiers: ['pro'] },
    { id: 'plugin_pack', name: 'Plugin pack', grants: { plugins: 10 }, stackable: true, prices: { monthly: 999, annual: 9_990 }, availableForTiers: ['pro'] },
    { id: 'api_pack', name: 'API pack', grants: { apiCalls: 1000 }, stackable: true, prices: { monthly: 499, annual: 4_990 }, availableForTiers: ['pro'] },
    // A FEATURE bundle that happens to grant: not "a pack of N", so never picked.
    { id: 'reporting', name: 'Advanced reporting', grants: { pipelines: 1 }, stackable: false, prices: { monthly: 100, annual: 1_000 }, availableForTiers: ['pro'] },
  ];

  const threeUnderPressure = {
    period: '2026-11-01',
    dimensions: { pipelines: dim(0.95), plugins: dim(0.92), apiCalls: dim(0.88) },
    addonsHeld: [],
    subscriptionAgeDays: 400,
    complete: true,
  } as Facts['profiles'][number];

  it('names the basket a compose offer proposed', () => {
    const [candidate] = candidatesFor({
      profiles: [threeUnderPressure],
      annualValueForDimension: (d) => annualPackValue(d, PACKS, 'pro'),
      packIdForDimension: (d) => packForDimension(d, PACKS, 'pro')?.id ?? null,
    });
    expect(candidate!.offerType).toBe('compose');
    expect(candidate!.targetBundles?.map((b) => b.bundleId).sort())
      .toEqual(['api_pack', 'pipeline_pack', 'plugin_pack']);
  });

  it('never proposes a non-stackable FEATURE bundle as a pack', () => {
    expect(packForDimension('pipelines', [PACKS[3]!], 'pro')).toBeNull();
  });

  it('is resolver-free-safe: no resolver ⇒ no basket, and still an offer', () => {
    // The basket is additive. A caller that cannot resolve bundle ids must still
    // get the decision, because the email leg needs no bundle id to quote a price.
    const [candidate] = candidatesFor({
      profiles: [threeUnderPressure],
      annualValueForDimension: (d) => annualPackValue(d, PACKS, 'pro'),
    });
    expect(candidate!.offerType).toBe('compose');
    expect(candidate!.targetBundles).toBeUndefined();
  });

  it('records the candidate tier on a crossover', () => {
    const [candidate] = candidatesFor({
      profiles: [profile()],
      crossover: { crossover: true, candidateTier: 'business', savingCents: 2_996 },
      annualValueForDimension: () => 0,
    });
    expect(candidate!.targetTier).toBe('business');
  });
});
