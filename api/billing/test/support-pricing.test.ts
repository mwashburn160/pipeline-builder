// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shape of the support ladder, which is a PRICING guard and not a config
 * snapshot.
 *
 * Support is the one add-on family sold as a three-rung ladder rather than a
 * capacity pack, so it has product rules that nothing else in the catalog has,
 * and all three were broken at some point in its first cut:
 *
 *  1. EVERY LEVEL STATES A TARGET. Premium once stated none — it sold "24x7
 *     coverage" and no number — so the ladder went blank on the single axis a
 *     buyer compares, exactly where the price doubled. The top rung read as less
 *     of a commitment than the middle one and the rational purchase was
 *     priority.
 *
 *  2. THE VOLUME CURVE FLATTENS AS THE LEVEL RISES, and support is the only
 *     family where it does. A volume break is justified when unit cost falls
 *     with scale, which is true of capacity and false of support: cost per
 *     contact does not fall with the count, it rises with the coverage the level
 *     promises. Run flat, the same percentage is five times the money at the top
 *     — a uniform -30% at 20 contacts took premium from $1,999.80 to $1,399.86 a
 *     month.
 *
 *  3. THE LEVELS ARE MUTUALLY EXCLUSIVE and included in NO tier. Enterprise
 *     spreads every feature flag, so a support flag reaching that list would
 *     hand away the product it is meant to buy.
 *
 * The assertions are relational wherever they can be — "premium discounts no
 * harder than priority" rather than "premium caps at 10" — so a deliberate
 * reprice does not have to come here, while a change that inverts the shape
 * does.
 */

import { describe, it, expect } from '@jest/globals';
import {
  SUPPORT_FEATURE_FLAGS,
  SUPPORT_RESPONSE_TARGETS,
  URGENT_SEVERITY_LEVELS,
  TIER_FEATURES,
  STANDARD_TIERS,
  admitCaseSeverity,
  type QuotaTier,
} from '@pipeline-builder/api-core';
import { loadBillingConfig } from '../src/config/billing-config.js';
import { bundleRequiresError, cascadeRemoveDependents, supportLevelConflictError } from '../src/helpers/addon-catalog.js';
import type { BundleConfig } from '../src/config/billing-types.js';

const { bundles } = loadBillingConfig();

/** Cheapest level first — the ladder's own order. */
const LADDER = ['support_standard', 'support_priority', 'support_premium'] as const;
/** The two BASELINE levels. Mutually exclusive with each other; premium is not
 *  one of them — it is an upgrade bought on top of whichever is held. */
const BASELINES = ['support_standard', 'support_priority'] as const;

function level(id: string): BundleConfig {
  const b = bundles.find((x) => x.id === id);
  // A withdrawn or renamed level fails loudly rather than making every
  // assertion below iterate nothing.
  if (!b) throw new Error(`no support bundle '${id}' in the catalog — update this guard or the catalog`);
  return b;
}

/** The best volume discount available at `qty`, in percent. */
const pctAt = (b: BundleConfig, qty: number): number => (b.volumeTiers ?? [])
  .filter((v) => qty >= v.minQuantity)
  .reduce((best, v) => Math.max(best, v.discountPercent), 0);

/** The deepest discount a level will ever give. */
const deepest = (b: BundleConfig): number => (b.volumeTiers ?? [])
  .reduce((best, v) => Math.max(best, v.discountPercent), 0);

describe('the ladder this guard reads is the one it thinks it is', () => {
  it('is the whole support family, in price order', () => {
    expect([...LADDER].sort()).toEqual([...SUPPORT_FEATURE_FLAGS].sort());
    const prices = LADDER.map((id) => level(id).prices.monthly);
    for (let i = 1; i < prices.length; i += 1) expect(prices[i]).toBeGreaterThan(prices[i - 1]!);
  });

  it('prices per CONTACT, one unit each, and all three stack', () => {
    // The unit is what makes the ladder affordable at all: case volume does not
    // scale with headcount, so per-SEAT pricing would have charged a 100-seat
    // org about 54% of its plan for standard support.
    for (const id of BASELINES) expect(level(id).grants).toMatchObject({ supportContacts: 1 });
    // Premium grants an UPGRADE slot, not a contact — see the upgrade block below.
    expect(level('support_premium').grants).toMatchObject({ supportPremiumContacts: 1 });
    expect(level('support_premium').grants).not.toHaveProperty('supportContacts');
    for (const id of LADDER) expect(level(id).stackable).toBe(true);
  });

  it('is offered on every tier and included in none', () => {
    for (const id of LADDER) {
      expect([...level(id).availableForTiers].sort()).toEqual([...new Set(bundles.flatMap((b) => b.availableForTiers))].sort());
    }
    // THE Enterprise trap: `TIER_FEATURES.enterprise` spreads the flag list, so
    // without the exclusion a new support flag becomes a free inclusion.
    for (const tier of STANDARD_TIERS as readonly QuotaTier[]) {
      for (const id of LADDER) expect(TIER_FEATURES[tier]).not.toContain(id);
    }
  });
});

describe('every level states a first-response target', () => {
  it('names one for all three, premium included', () => {
    // Rule 1. The regression: premium was the only level with no number.
    for (const id of LADDER) {
      expect(SUPPORT_RESPONSE_TARGETS[id]).toBeTruthy();
      expect(SUPPORT_RESPONSE_TARGETS[id]).toMatch(/\d|next/);
    }
  });

  it('puts the target in the catalog description, from the canonical map', () => {
    // One source for the commitment string: the case chip, the catalog, the
    // pricing page and the alert that fires when the desk misses it must not be
    // able to disagree.
    for (const id of LADDER) expect(level(id).description).toContain(SUPPORT_RESPONSE_TARGETS[id]!);
  });

  it('never states a target in BUSINESS HOURS, the unit that misled', () => {
    // "48 business hours" reads as two days and means six working days, so the
    // old wording overstated every commitment by about three times.
    for (const id of LADDER) expect(SUPPORT_RESPONSE_TARGETS[id]).not.toMatch(/business hours?/i);
  });

  it('gives premium alone the clock that does not stop', () => {
    expect(SUPPORT_RESPONSE_TARGETS.support_premium).toMatch(/any day/);
    expect(SUPPORT_RESPONSE_TARGETS.support_standard).not.toMatch(/any day/);
    expect(SUPPORT_RESPONSE_TARGETS.support_priority).not.toMatch(/any day/);
  });
});

describe('the volume curve flattens as the level rises', () => {
  it('discounts premium no harder than priority, and priority no harder than standard', () => {
    // Rule 2, stated relationally so a reprice does not have to come here.
    const [std, pri, prem] = LADDER.map((id) => deepest(level(id)));
    expect(prem).toBeLessThan(pri!);
    expect(pri!).toBeLessThan(std!);
  });

  it('holds at every quantity, not just at the deepest rung', () => {
    // A curve can satisfy "shallower maximum" while still crossing somewhere in
    // the middle, which is where a real account sits.
    for (const qty of [1, 2, 3, 5, 8, 12, 20, 50]) {
      const [std, pri, prem] = LADDER.map((id) => pctAt(level(id), qty));
      expect(prem).toBeLessThanOrEqual(pri!);
      expect(pri!).toBeLessThanOrEqual(std!);
    }
  });

  it('cuts the money premium gives away to a THIRD of what the flat curve gave', () => {
    // Rule 2 in money rather than percent, stated against the counterfactual
    // because that is the claim the fix actually makes.
    //
    // Note what it does NOT claim: premium's absolute give-away is still larger
    // than standard's, and must be. A percentage off a 5x unit price is 5x the
    // money, so bringing premium BELOW standard in dollars would need a cap
    // under about 4% — a number so shallow the break would stop functioning as
    // a break. The leak was never "premium discounts at all", it was the SIZE:
    // a uniform -30% at 20 contacts cost $600/mo on the level whose case volume
    // the seven-day rota has to absorb.
    const FLAT = 30;
    for (const qty of [20, 50]) {
      const prem = level('support_premium');
      const was = prem.prices.monthly * qty * FLAT / 100;
      const now = prem.prices.monthly * qty * pctAt(prem, qty) / 100;
      expect(now).toBeLessThanOrEqual(was / 3);
    }
  });

  it('still engages for a real account, so the breaks are not decorative', () => {
    // The inverse failure: flattening the top until nothing discounts at all
    // would be a price rise dressed as a margin fix.
    for (const id of LADDER) expect(pctAt(level(id), 8)).toBeGreaterThan(0);
  });

  it('holds the ANNUAL stack shallowest at the top, where it compounds worst', () => {
    // Annual is 10x monthly (~17% off) and the volume percent comes off the
    // annual price too, so the two multiply. Uncapped, 20 annual premium
    // contacts landed 41.7% below a year at monthly list.
    //
    // The bound is asserted on PREMIUM alone, deliberately. Standard is allowed
    // to stack deeper than a third: it is the attach-rate lever, its marginal
    // case is cheap to serve, and revenue at that discount is revenue that
    // mostly would not exist otherwise. What must not happen is the deepest
    // combined discount in the family sitting on the most expensive level.
    const stacked = (id: string) => {
      const b = level(id);
      return 1 - (b.prices.annual * 20 * (100 - pctAt(b, 20)) / 100) / (b.prices.monthly * 12 * 20);
    };
    expect(stacked('support_premium')).toBeLessThan(0.3);
    const [std, pri, prem] = LADDER.map(stacked);
    expect(prem).toBeLessThan(pri!);
    expect(pri!).toBeLessThanOrEqual(std!);
  });
});

describe('urgent severity is premium-only', () => {
  it('admits urgent at premium and nowhere else on the ladder', () => {
    // This is what makes the top rung a CAPABILITY rather than only a faster
    // clock, which is what the priority-to-premium step is priced on.
    expect([...URGENT_SEVERITY_LEVELS]).toEqual(['support_premium']);
    expect(admitCaseSeverity('urgent', 'support_premium')).toEqual({ severity: 'urgent', downgraded: false });
    for (const id of ['support_standard', 'support_priority']) {
      expect(admitCaseSeverity('urgent', id)).toEqual({ severity: 'high', downgraded: true });
    }
  });

  it('is the ONLY thing the top rung adds beyond its target, so the step is legible', () => {
    // Guards against the opposite drift: piling extras onto premium until the
    // step stops being explainable. Premium grants its own flag and nothing else.
    expect(level('support_premium').features).toEqual(['support_premium']);
  });

  it('never touches a severity below urgent, at any level', () => {
    for (const requested of ['normal', 'high']) {
      for (const id of [...LADDER, null]) {
        expect(admitCaseSeverity(requested, id)).toEqual({ severity: requested, downgraded: false });
      }
    }
  });

  it('passes urgent through untouched when no case is being opened', () => {
    // A null level means no entitlement, or an entitlement read that failed.
    // There is no commitment to protect, so an outage of ours must not demote
    // somebody's label as a side effect.
    expect(admitCaseSeverity('urgent', null)).toEqual({ severity: 'urgent', downgraded: false });
  });
});

describe('the levels are mutually exclusive at PURCHASE, not just in the math', () => {
  // `effectiveEntitlements` resolves a double hold to the highest level by
  // `continue`-ing past the losers — which discards their `supportContacts`
  // GRANT along with their feature flag. So a customer could buy 99 standard
  // contacts plus 1 premium, be charged for all 100 units, and receive ONE
  // contact. The resolution is right as defence in depth; the refusal is what
  // stops anyone paying for a discarded grant.
  const held = (bundleId: string, quantity: number) => [{ bundleId, quantity }];

  it('refuses adding one baseline to an account already holding the other', () => {
    const err = supportLevelConflictError(level('support_priority'), held('support_standard', 99), bundles);
    expect(err).toMatch(/mutually exclusive/i);
    expect(err).toMatch(/Standard Support/);
    // The non-obvious part the customer has to be told: the contacts they were
    // counting on do not come with them.
    expect(err).toMatch(/do not carry over/i);
  });

  it('refuses it in BOTH directions, so neither order of purchase slips through', () => {
    for (const [add, has] of [
      ['support_priority', 'support_standard'],
      ['support_standard', 'support_priority'],
    ] as const) {
      expect(supportLevelConflictError(level(add), held(has, 1), bundles)).toBeTruthy();
    }
  });

  it('does NOT refuse premium alongside a baseline — that is the supported shape', () => {
    // The exclusion is between the two BASELINES. Premium is an upgrade bought
    // on top of one of them, which is the whole point of the upgrade model: a
    // 100-person org gives business hours to its three named contacts and 24x7
    // to the one carrying the pager.
    for (const base of BASELINES) {
      expect(supportLevelConflictError(level('support_premium'), held(base, 3), bundles)).toBeNull();
      expect(supportLevelConflictError(level(base), held('support_premium', 1), bundles)).toBeNull();
    }
  });

  it('allows RAISING THE QUANTITY of the level already held', () => {
    // Going from 2 standard contacts to 5 is the common case and must not trip
    // the gate — the conflict is between the two BASELINES, never within one.
    for (const id of LADDER) {
      expect(supportLevelConflictError(level(id), held(id, 4), bundles)).toBeNull();
    }
  });

  it('allows the first level on an account holding none', () => {
    for (const id of LADDER) {
      expect(supportLevelConflictError(level(id), [], bundles)).toBeNull();
      expect(supportLevelConflictError(level(id), held('seat', 10), bundles)).toBeNull();
    }
  });

  it('ignores a level held at quantity 0', () => {
    // A removed add-on may linger as a zero-quantity row; it is not a hold, and
    // treating it as one would lock the customer out of ever buying again.
    expect(supportLevelConflictError(level('support_premium'), held('support_standard', 0), bundles)).toBeNull();
  });

  it('does not touch non-support bundles', () => {
    expect(supportLevelConflictError(level('seat'), held('support_premium', 1), bundles)).toBeNull();
  });
});

describe('premium is an additive UPGRADE, not a third level', () => {
  // The model this block pins, and why it exists: with three mutually exclusive
  // levels there was no way to express "99 people on business hours, the on-call
  // lead on 24x7" — buying 99 standard + 1 premium charged for 100 units and
  // granted ONE contact, because `effectiveEntitlements` discards the losing
  // level's quota grant along with its flag.

  it('requires a baseline, and EITHER baseline satisfies it', () => {
    // `requires` is an AND over bundle ids, so the OR needed its own field.
    // The alternative — a `support_baseline` FEATURE FLAG invented purely to be
    // required — would have put a capability that does not exist into every
    // support customer's entitlement list.
    expect(level('support_premium').requiresAnyOf).toEqual(['support_standard', 'support_priority']);
    expect(level('support_premium').requires ?? []).toEqual([]);
  });

  it('is unpurchasable with no baseline, and the refusal offers the CHOICE', () => {
    const err = bundleRequiresError(
      level('support_premium'),
      [{ bundleId: 'support_premium', quantity: 1 }],
      bundles,
      'team',
    );
    expect(err).toMatch(/one of/i);
    expect(err).toMatch(/Standard Support/);
    expect(err).toMatch(/Priority Support/);
  });

  it('is purchasable on EITHER baseline', () => {
    for (const base of BASELINES) {
      expect(bundleRequiresError(
        level('support_premium'),
        [{ bundleId: base, quantity: 3 }, { bundleId: 'support_premium', quantity: 1 }],
        bundles,
        'team',
      )).toBeNull();
    }
  });

  it('is CASCADED OUT when the last baseline goes, since an upgrade cannot outlive it', () => {
    const { addons, removed } = cascadeRemoveDependents(
      [{ bundleId: 'support_standard', quantity: 0 }, { bundleId: 'support_premium', quantity: 2 }],
      bundles,
      'team',
    );
    expect(removed).toContain('support_premium');
    expect(addons.find((a) => a.bundleId === 'support_premium')?.quantity ?? 0).toBe(0);
  });

  it('SURVIVES a baseline swap, because the other alternative still satisfies it', () => {
    // An account moving standard -> priority must not silently lose its premium
    // upgrades. This is the case an AND-only prerequisite would have broken.
    const { removed } = cascadeRemoveDependents(
      [{ bundleId: 'support_standard', quantity: 0 }, { bundleId: 'support_priority', quantity: 3 }, { bundleId: 'support_premium', quantity: 1 }],
      bundles,
      'team',
    );
    expect(removed).not.toContain('support_premium');
  });

  it('prices ADDITIVELY, so an upgraded contact costs baseline + upgrade', () => {
    // The deliberate consequence of the upgrade model: that contact is served
    // during business hours through the baseline and overnight through this, so
    // a delta price would pretend the baseline were free. A list price is also
    // far easier to concede down from than to raise.
    const std = level('support_standard').prices.monthly;
    const prem = level('support_premium').prices.monthly;
    expect(std + prem).toBe(11998);
    // And the effective ladder still rises monotonically per contact.
    expect(std).toBeLessThan(level('support_priority').prices.monthly);
    expect(level('support_priority').prices.monthly).toBeLessThan(std + prem);
  });

  it('is the ONLY level outside the baseline exclusion', () => {
    // Stated as a property so adding a fourth level forces a decision about
    // which side of the line it falls on. The set is derived from which GRANT a
    // bundle makes (`supportContacts` = baseline), not from its name, so a
    // future `support_*` bundle lands on the right side by construction.
    const one = (bundleId: string) => [{ bundleId, quantity: 1 }];
    expect(supportLevelConflictError(level('support_premium'), one('support_standard'), bundles)).toBeNull();
    expect(supportLevelConflictError(level('support_standard'), one('support_priority'), bundles)).toBeTruthy();
  });
});

describe('the prerequisite guard does not crash billing when the ladder is withdrawn', () => {
  // SECOND INSTANCE of this exact shape. `assertCombosValid` had already had to
  // learn it for `assured_delivery` referencing an inactive support bundle; the
  // prerequisite validator repeated it the moment `requiresAnyOf` landed.
  //
  // `SUPPORT_ENABLED=false` deactivates all three support bundles, but premium
  // still DECLARES `requiresAnyOf` on the two baselines. A validator that
  // checked every bundle rather than every ACTIVE one threw at config load and
  // took the whole billing service down. An inactive bundle is not purchasable,
  // so an unsatisfiable prerequisite on it is irrelevant.
  //
  // The switch behaviour itself is NOT re-tested here: the deployment switches
  // are read at MODULE scope, so exercising them needs a cache-busting
  // re-import, and `support-deployment-switches.test.ts` owns that harness —
  // it is what caught this. Duplicating it here would mean two copies of a
  // fragile trick. What this block pins is the half that holds under the
  // default config: that the guard is still armed.

  it('leaves the guard ARMED for an active bundle', () => {
    // The inverse risk of the fix: skipping inactive dependents must not have
    // turned the check off. Premium is active by default, declares the OR, and
    // its baselines resolve — so the default load passing is the guard running
    // and finding nothing wrong, not the guard being absent.
    const premium = level('support_premium');
    expect(premium.isActive).toBe(true);
    expect(premium.requiresAnyOf).toEqual(['support_standard', 'support_priority']);
    expect(() => loadBillingConfig()).not.toThrow();
  });

  it('keeps every rung IN the catalog, so a withdrawn SKU stays describable', () => {
    // Withdrawing a level marks it inactive; it must not vanish. The pricing
    // page still has to be able to say what premium is, and an org already
    // holding it must not have its entitlement become unresolvable.
    for (const id of LADDER) expect(bundles.some((b) => b.id === id)).toBe(true);
  });
});
