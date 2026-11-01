// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pricing-shape guard: the tier ladder and the add-on catalog are set in two
 * different files, and the product rule that binds them is "every step up the
 * ladder must be the cheapest way to get the next tier's capacity".
 *
 * Nothing compared the two before this. When the tier caps were re-sized, every
 * capacity pack silently became exactly 100% of Pro's own rate — Pro held 25
 * plugins / 100k API / 2.5k AI per period and the packs granted 25 / 100k /
 * 2.5k — so one pack doubled the tier, and a $0 Developer account plus a $10
 * Plugin Pack reached 35 plugin builds/period, past Team's 30 at $79. The only
 * sizing assertion in the repo at the time compared aiCalls against Team and
 * nothing else, so it all passed.
 *
 * Three rules, and they are NOT interchangeable — which one applies depends on
 * what the dimension is:
 *
 *  1. RATE packs (plugins / apiCalls / aiCalls / listings). Each of these caps
 *     is a per-period flow (`QUOTA_RESET_DAYS`), reserved on create/build. Held
 *     to BOTH a ratio bound (<= 50% of the cap of every tier that may buy it)
 *     and the no-crossing rule (one pack must not reach the next tier's cap).
 *
 *  2. `storage_pack`. Registry bytes are a STOCK, not a rate — its quota `used`
 *     is structurally 0 and the registry measures live — so "half the rate" is
 *     meaningless for it. No-crossing only, which is why it is the one capacity
 *     pack still sold on the free tier.
 *
 *  3. The tier DIFFERENTIATORS (`seat`, `pipeline_pack`) are exempt from the
 *     ratio bound and protected by WHERE they sell instead: Team+ only.
 *     `pipeline_pack` grants +5 pipelines against Team's 12 and should not have
 *     to be small — a Pro account simply cannot buy pipelines or seats at all,
 *     which is what forces the Pro -> Team upgrade.
 *
 * And the rule the other three serve, asserted last: for every adjacent step,
 * assembling the next tier's capacity out of packs must cost MORE than the
 * upgrade. That is the property that actually makes the ladder pull upward, and
 * it is the one that catches a pack repricing that quietly makes staying put the
 * rational choice.
 *
 * Retention packs are exempt from all of it: `eventRetentionDays` /
 * `doraRetentionDays` are absent from `VALID_QUOTA_TYPES`, never ride the
 * quota-service leg, and are deliberately larger than the base (+90d on 30,
 * +365d on 180).
 */

import { describe, it, expect } from '@jest/globals';
import { QUOTA_TIERS, VALID_QUOTA_TYPES, STANDARD_TIERS, type QuotaTier } from '@pipeline-builder/api-core';
import { loadBillingConfig } from '../src/config/billing-config.js';
import type { BundleConfig } from '../src/config/billing-types.js';

const { bundles, plans, comboDiscounts } = loadBillingConfig();
/** `plans` is a flat array carrying its own `tier`, not a tier-keyed record. */
const plan = (t: QuotaTier) => {
  const found = plans.find((x) => x.tier === t);
  if (!found) throw new Error(`no billing plan for tier '${t}'`);
  return found;
};

/** Held to the ratio bound; one quota dimension each. */
const RATE_PACKS = ['plugin_pack', 'api_pack', 'ai_pack', 'listing_pack'] as const;
/** Sold on Team+ only instead of being made small — see the header. */
const DIFFERENTIATORS = ['seat', 'pipeline_pack'] as const;
/** Not quota-metered, intentionally larger than the base — see the header. */
const RETENTION = ['retention_pack', 'dora_history_pack'] as const;

/** Cheapest-first, so "a more expensive tier" is just a later index. */
const LADDER: QuotaTier[] = ['developer', 'pro', 'team', 'business', 'enterprise'];

const cap = (tier: QuotaTier, dim: string): number =>
  (QUOTA_TIERS[tier].limits as unknown as Record<string, number>)[dim]!;
const grantOf = (b: BundleConfig, dim: string): number => (b.grants as Record<string, number>)[dim] ?? 0;

function byId(id: string): BundleConfig {
  const b = bundles.find((x) => x.id === id);
  // Guards a vacuous pass: a renamed or withdrawn pack fails loudly here rather
  // than making every assertion below iterate an empty list.
  if (!b) throw new Error(`no bundle '${id}' in the catalog — update this guard or the catalog`);
  return b;
}

/** Cost of `k` units, honouring the bundle's volume breaks (best applicable). */
function unitsCost(b: BundleConfig, k: number): number {
  const pct = (b.volumeTiers ?? [])
    .filter((v) => k >= v.minQuantity)
    .reduce((best, v) => Math.max(best, v.discountPercent), 0);
  return Math.round(k * b.prices.monthly * (100 - pct) / 100);
}

describe('the ladder this guard reads is the one it thinks it is', () => {
  it('covers every selectable tier, cheapest first', () => {
    expect([...LADDER].sort()).toEqual([...STANDARD_TIERS].sort());
  });

  it('is priced monotonically, so "upgrade delta" is always positive', () => {
    const prices = LADDER.map((t) => plan(t).prices.monthly);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });
});

describe('rate packs are a top-up, not a second subscription', () => {
  it.each(RATE_PACKS)('%s grants one quota dimension, so its ratio is unambiguous', (id) => {
    const dims = Object.keys(byId(id).grants);
    // Single-key also keeps `BILLING_BUNDLE_<ID>_GRANT` working, since
    // applyGrantOverride ignores a multi-key grant.
    expect({ id, dims }).toEqual({ id, dims: [dims[0]] });
    expect(VALID_QUOTA_TYPES).toContain(dims[0]);
  });

  it.each(RATE_PACKS)('%s grants at most half the cap of every tier that can buy it', (id) => {
    const pack = byId(id);
    const dim = Object.keys(pack.grants)[0]!;
    const grant = grantOf(pack, dim);
    const tooBig = pack.availableForTiers
      .filter((t) => cap(t, dim) !== -1 && grant > cap(t, dim) / 2)
      .map((t) => `${t}: +${grant} on a cap of ${cap(t, dim)} (${Math.round((grant / cap(t, dim)) * 100)}%)`);
    expect({ id, dim, tooBig }).toEqual({ id, dim, tooBig: [] });
  });

  it.each(RATE_PACKS)('%s is not sold on the free Developer tier', (id) => {
    // The conversion leak: a $0 account that can buy capacity has no reason to
    // upgrade FOR capacity. Developer's path up is an upgrade.
    expect({ id, tiers: byId(id).availableForTiers })
      .toEqual({ id, tiers: expect.not.arrayContaining(['developer']) });
  });
});

describe('no single pack vaults a tier past the next one', () => {
  // The rule that makes the published table honest: a reader comparing "Team:
  // 60 plugins" against "Plugin Pack +10" should not be able to conclude that
  // one pack on Pro beats Team.
  const PACKS = [...RATE_PACKS, 'storage_pack', ...DIFFERENTIATORS] as const;

  it.each(PACKS)('%s cannot reach a more expensive tier\'s cap in one unit', (id) => {
    const pack = byId(id);
    const crossings: string[] = [];
    for (const dim of Object.keys(pack.grants)) {
      const grant = grantOf(pack, dim);
      for (const tier of pack.availableForTiers) {
        const here = cap(tier, dim);
        if (here === -1) continue;
        for (const up of LADDER.slice(LADDER.indexOf(tier) + 1)) {
          const there = cap(up, dim);
          if (there !== -1 && here + grant >= there) {
            crossings.push(`${dim}: ${tier} ${here}+${grant} >= ${up} ${there}`);
          }
        }
      }
    }
    expect({ id, crossings }).toEqual({ id, crossings: [] });
  });
});

describe('storage_pack is the stock dimension, and the only one on the free tier', () => {
  it('is the ONLY capacity pack sold on Developer', () => {
    // If another pack reaches the free tier this fails and sends the author to
    // the header, rather than passing as an oversight.
    const onFree = bundles
      .filter((b) => Object.keys(b.grants).some((d) => (VALID_QUOTA_TYPES as readonly string[]).includes(d)))
      .filter((b) => b.availableForTiers.includes('developer'))
      .map((b) => b.id);
    expect(onFree).toEqual(['storage_pack']);
  });
});

describe('the tier differentiators are protected by WHERE they sell, not by size', () => {
  it.each(DIFFERENTIATORS)('%s is not sold below Team', (id) => {
    // The protection is the FLOOR, not the exact list: a tier added above Team
    // should get them automatically, which is why this asserts the absence of
    // the entry-level tiers rather than naming every tier that qualifies.
    expect({ id, tiers: byId(id).availableForTiers })
      .toEqual({ id, tiers: expect.not.arrayContaining(['developer', 'pro']) });
  });

  it('pipeline_pack carries the plugin throughput for the pipelines it grants', () => {
    // A pipelines-only pack broke the tiers' 5x plugins-per-pipeline ratio for
    // whoever bought it, so the pipelines it sold could not be built for.
    const g = byId('pipeline_pack').grants as Record<string, number>;
    expect({ pipelines: g.pipelines, plugins: g.plugins })
      .toEqual({ pipelines: g.pipelines, plugins: g.pipelines! * 5 });
  });
});

describe('every tier keeps 5 plugin builds per pipeline, packs included', () => {
  it('holds at the baseline and after one pipeline_pack', () => {
    const g = byId('pipeline_pack').grants as Record<string, number>;
    const broken: string[] = [];
    for (const t of LADDER) {
      const [pipe, plug] = [cap(t, 'pipelines'), cap(t, 'plugins')];
      if (plug !== pipe * 5) broken.push(`${t} baseline: ${plug} plugins / ${pipe} pipelines`);
      if (!byId('pipeline_pack').availableForTiers.includes(t)) continue;
      const [p2, g2] = [pipe + g.pipelines!, plug + g.plugins!];
      if (g2 !== p2 * 5) broken.push(`${t} + pipeline_pack: ${g2} plugins / ${p2} pipelines`);
    }
    expect(broken).toEqual([]);
  });
});

describe('upgrading always beats assembling the next tier out of packs', () => {
  /**
   * Cheapest pack route to close one dimension's gap from `lo` to `up`, as a
   * LOWER BOUND on what a buyer would actually pay: only bundles purchasable on
   * `lo` count, `maxQuantity` can make a gap uncloseable at any price, and a
   * multi-dimension pack is credited against every dimension it grants so the
   * sum never double-counts.
   */
  function closeGap(lo: QuotaTier, up: QuotaTier, dim: string, credited: Map<string, number>) {
    const have = cap(lo, dim) + (credited.get(dim) ?? 0);
    const want = cap(up, dim);
    if (want === -1) return { cents: 0, uncloseable: `${dim} (unlimited above)` };
    if (have === -1 || have >= want) return { cents: 0 };
    const options = bundles
      .filter((b) => b.availableForTiers.includes(lo) && grantOf(b, dim) > 0)
      .map((b) => {
        const k = Math.ceil((want - have) / grantOf(b, dim));
        const limit = b.stackable ? (b.maxQuantity ?? Infinity) : 1;
        return k <= limit ? { b, k, cents: unitsCost(b, k) } : null;
      })
      .filter((x): x is { b: BundleConfig; k: number; cents: number } => x !== null);
    if (options.length === 0) return { cents: 0, uncloseable: dim };
    const best = options.reduce((a, b) => (b.cents < a.cents ? b : a));
    for (const d of Object.keys(best.b.grants)) {
      credited.set(d, (credited.get(d) ?? 0) + grantOf(best.b, d) * best.k);
    }
    return { cents: best.cents };
  }

  const DIMS = ['pipelines', 'plugins', 'apiCalls', 'aiCalls', 'listings', 'storageBytes', 'seats'];

  it.each(LADDER.slice(0, -1).map((lo, i) => [lo, LADDER[i + 1]!] as const))(
    '%s -> %s costs less as an upgrade than as packs', (lo, up) => {
      const delta = plan(up).prices.monthly - plan(lo).prices.monthly;
      const credited = new Map<string, number>();
      let basket = 0;
      const uncloseable: string[] = [];
      // Pipelines first: pipeline_pack also grants plugins, and crediting it
      // before the plugins row is what keeps this a lower bound rather than a
      // double count.
      for (const dim of DIMS) {
        const r = closeGap(lo, up, dim, credited);
        basket += r.cents;
        if (r.uncloseable) uncloseable.push(r.uncloseable);
      }
      // Feature add-ons the upper tier includes and the lower one must buy.
      const upFeatures = new Set(plan(up).features);
      const loFeatures = new Set(plan(lo).features);
      for (const b of bundles) {
        const f = (b.features ?? []).filter((x) => upFeatures.has(x) && !loFeatures.has(x));
        if (f.length > 0 && b.availableForTiers.includes(lo)) basket += b.prices.monthly;
      }
      expect({
        step: `${lo} -> ${up}`,
        upgradeIsCheaper: basket > delta,
        upgrade: `$${(delta / 100).toFixed(2)}`,
        packs: `$${(basket / 100).toFixed(2)}`,
        alsoUnbuyable: uncloseable,
      }).toEqual({
        step: `${lo} -> ${up}`,
        upgradeIsCheaper: true,
        upgrade: `$${(delta / 100).toFixed(2)}`,
        packs: `$${(basket / 100).toFixed(2)}`,
        alsoUnbuyable: uncloseable,
      });
    });
});

describe('retention packs are exempt, and the exemption stays narrow', () => {
  it.each(RETENTION)('%s grants only non-quota-metered dimensions', (id) => {
    const metered = Object.keys(byId(id).grants)
      .filter((d) => (VALID_QUOTA_TYPES as readonly string[]).includes(d));
    expect({ id, metered }).toEqual({ id, metered: [] });
  });
});

describe('every combo is reachable, discounted, and consistent', () => {
  const basketOf = (combo: { bundleIds: readonly string[]; minQuantities?: Record<string, number> }) =>
    combo.bundleIds.reduce((sum, id) => {
      const b = bundles.find((x) => x.id === id);
      return sum + (b ? b.prices.monthly * (combo.minQuantities?.[id] ?? 1) : 0);
    }, 0);

  it('can actually be bought — every combo has a tier where ALL members are purchasable', () => {
    // A combo only forms when the account holds every member, so if the
    // members share no purchasable tier it is permanently inert and nothing
    // reports it. That happened to the Analytics Suite: `advanced_reporting`
    // is INCLUDED in Business and therefore not purchasable there, so the
    // Suite could never form on Business even though its other two members
    // could — a Business account paid full list while Team got 30% off.
    const unreachable = comboDiscounts.map((combo) => {
      const tiersWithAll = STANDARD_TIERS.filter((t) =>
        combo.bundleIds.every((id) => bundles.find((b) => b.id === id)?.availableForTiers.includes(t)));
      return tiersWithAll.length === 0 ? combo.id : null;
    }).filter(Boolean);
    expect(unreachable).toEqual([]);
  });

  it('bills annual at 10x monthly, the two-months-free convention', () => {
    // WITHIN THE ROUNDING STEP, not exactly. Every price now snaps up to a whole
    // dollar or .99, and 10x a `.99` monthly price is a `.90` annual one — which
    // is where most of this catalog's odd cents came from. So the convention is
    // asserted against the snapped product rather than the raw one: the annual
    // price must be the rounded form of 10x monthly, and may exceed it by at most
    // the 98-cent step the rule can move a figure.
    const off = comboDiscounts
      .filter((c) => {
        const target = c.prices.monthly * 10;
        return c.prices.annual < target || c.prices.annual - target > 98;
      })
      .map((c) => `${c.id}: $${(c.prices.monthly / 100).toFixed(2)}/mo but $${(c.prices.annual / 100).toFixed(2)}/yr`);
    expect(off).toEqual([]);
  });

  it('prices every plan, bundle and combo on a whole dollar or .99', () => {
    // ONE rule for everything a customer sees. It is asserted across all three
    // catalogs because the odd cents were never authored — they were derived, by
    // the 10x annual convention, by combo prices set as "30% off the basket", and
    // by percentage reductions. `envCents` snaps at the single point every price
    // flows through, so this is what proves no path routes around it.
    const bad: string[] = [];
    const check = (label: string, cents: number) => {
      if (cents > 0 && cents % 100 !== 0 && cents % 100 !== 99) bad.push(`${label} = ${cents}`);
    };
    for (const p of plans) { check(`plan ${p.id} monthly`, p.prices.monthly); check(`plan ${p.id} annual`, p.prices.annual); }
    for (const b of bundles) { check(`bundle ${b.id} monthly`, b.prices.monthly); check(`bundle ${b.id} annual`, b.prices.annual); }
    for (const c of comboDiscounts) { check(`combo ${c.id} monthly`, c.prices.monthly); check(`combo ${c.id} annual`, c.prices.annual); }
    expect(bad).toEqual([]);
  });

  it('discounts every basket by about 30%, so no combo is quietly a better deal', () => {
    // Not a law of nature — but every combo is near 30%, and an outlier is far
    // more likely to be a repricing that forgot its combo than a deliberate
    // choice. A member's price change moves the basket, not the combo price.
    //
    // A BAND rather than exactly 30, because the whole-dollar-or-.99 rule snaps
    // the combined price UP, which shrinks the credit: `throughput_bundle` lands
    // at 27.7% and `scale_bundle` at 28.1% on small baskets where a 98-cent step
    // is a larger share. The band is one-sided on purpose — a combo may be LESS
    // generous than 30% by rounding, but anything deeper than 30% is a real
    // mispricing, since nothing in the rounding rule can increase a discount.
    const odd = comboDiscounts.map((c) => {
      const basket = basketOf(c);
      if (basket === 0) return `${c.id}: basket is 0`;
      const pct = (1 - c.prices.monthly / basket) * 100;
      return pct > 30.001 || pct < 27
        ? `${c.id}: ${pct.toFixed(1)}% off ($${(basket / 100).toFixed(2)} -> $${(c.prices.monthly / 100).toFixed(2)})`
        : null;
    }).filter(Boolean);
    expect(odd).toEqual([]);
  });
});

describe('every combo is cheaper than buying its members separately', () => {
  it('prices each combo below its basket', () => {
    const bad = comboDiscounts.map((combo) => {
      const basket = combo.bundleIds.reduce((sum, id) => {
        const b = bundles.find((x) => x.id === id);
        const min = combo.minQuantities?.[id] ?? 1;
        return sum + (b ? b.prices.monthly * min : 0);
      }, 0);
      return combo.prices.monthly >= basket
        ? `${combo.id}: $${(combo.prices.monthly / 100).toFixed(2)} >= basket $${(basket / 100).toFixed(2)}`
        : null;
    }).filter(Boolean);
    expect(bad).toEqual([]);
  });
});
