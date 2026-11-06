// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The frontend's tier-limit fallback, and the tier ladder's product invariants.
 *
 * WHAT CHANGED. This suite used to parse the SOURCE TEXT of two files — a
 * hand-written `TIER_LIMITS` table in `frontend/src/components/quotas/constants.ts`
 * and `DEFAULT_TIER_LIMITS` in api-core — and assert the numbers matched. The
 * table was a copy under a "keep in sync" comment, and the failure it guarded was
 * quiet: the server's effective limits are overlaid at runtime, so a drifted copy
 * only surfaced as a quota-admin preset an admin clicked and SAVED onto a real
 * org.
 *
 * The limits now live in a dependency-free module the browser imports
 * (`@pipeline-builder/api-core/tier-limits`), the frontend PROJECTS them onto the
 * quota types it renders, and there is no second copy to drift. So the first half
 * of this suite is no longer a parity check between two literals — it checks the
 * projection itself, which is the only thing left that can be wrong (a missing
 * key, or an `as` cast hiding one).
 *
 * The ladder invariants below are the part worth keeping, and they are STRONGER
 * for being imported: the old parse skipped `storageBytes` entirely, because
 * `2 * GB` is not a number literal.
 */

import { describe, it, expect } from '@jest/globals';
import { DEFAULT_TIER_LIMITS } from '@pipeline-builder/api-core/tier-limits';
import { QUOTA_KEYS, TIER_PRESETS } from '../src/components/quotas/constants';
import { ALL_TIER_KEYS, TIER_KEYS } from '../src/lib/tiers';

describe('the frontend tier-limit fallback projects api-core', () => {
  it('carries every tier and every displayed quota type', () => {
    // Guards a vacuous pass: an empty projection would satisfy the comparison
    // below by comparing nothing.
    //
    // Compared against API-CORE's tier set, not the frontend's own
    // `ALL_TIER_KEYS`, because the projection is built by iterating that list and
    // cast to `Record<QuotaTier, …>` — a tier missing from the frontend's
    // `TIER_META` would be missing from the presets, and the cast would say
    // nothing. Checking it against the list it was built from would be vacuous.
    expect(Object.keys(TIER_PRESETS).sort()).toEqual(Object.keys(DEFAULT_TIER_LIMITS).sort());
    for (const tier of ALL_TIER_KEYS) {
      expect(Object.keys(TIER_PRESETS[tier].limits).sort()).toEqual([...QUOTA_KEYS].sort());
    }
  });

  it.each([...ALL_TIER_KEYS])('%s prefills the real code defaults', (tier) => {
    const mine = TIER_PRESETS[tier].limits;
    const theirs = DEFAULT_TIER_LIMITS[tier];
    for (const key of QUOTA_KEYS) {
      expect({ tier, key, value: mine[key] }).toEqual({ tier, key, value: theirs[key] });
    }
  });
});

describe('the tier ladder keeps its invariants', () => {
  // The SELLABLE tiers, in ladder order. `unlimited` is excluded: it is the
  // billing-off default, every limit is -1, and it is never offered as a preset.
  const TIERS = TIER_KEYS;
  const limits = (t: typeof TIERS[number]) => DEFAULT_TIER_LIMITS[t];

  it('gives every tier exactly 5 plugins per pipeline', () => {
    // The product rule. Plugin and pipeline ADD-ON packs already embody it
    // (pipeline_pack +5 x 5 = 25 = plugin_pack +25), so a tier that breaks the
    // ratio also makes the packs incoherent.
    const broken = TIERS
      .map((t) => ({ t, pipelines: limits(t).pipelines, plugins: limits(t).plugins }))
      .filter((r) => r.plugins !== r.pipelines * 5)
      .map((r) => `${r.t}: ${r.plugins} plugins for ${r.pipelines} pipelines`);
    expect(broken).toEqual([]);
  });

  it('never gives a more expensive tier LESS per seat', () => {
    // The regression this was introduced to fix: API and AI allowances used to
    // peak at Pro and fall through Team to Enterprise, so the most expensive
    // plan gave each user the least — the first thing an enterprise buyer
    // computes.
    for (const field of ['apiCalls', 'aiCalls'] as const) {
      const perSeat = TIERS.map((t) => ({ t, v: Math.floor(limits(t)[field] / limits(t).seats) }));
      // Compare only the multi-seat tiers: Pro is deliberately a single-seat
      // power-user plan and is allowed a higher per-seat figure than Team.
      const multi = perSeat.filter((r) => limits(r.t).seats > 1);
      for (let i = 1; i < multi.length; i++) {
        expect({ field, from: multi[i - 1].t, to: multi[i].t, ok: multi[i].v >= multi[i - 1].v })
          .toEqual({ field, from: multi[i - 1].t, to: multi[i].t, ok: true });
      }
    }
  });

  it('never shrinks a limit as the ladder climbs', () => {
    // Now checkable for EVERY limit, including `storageBytes`, which the old
    // source-text parse could not read (`2 * GB` is not a literal). -1 is
    // unlimited, so it sorts above every finite value rather than below it.
    const rank = (v: number) => (v === -1 ? Number.POSITIVE_INFINITY : v);
    const shrinks: string[] = [];
    for (const field of Object.keys(DEFAULT_TIER_LIMITS.developer) as (keyof typeof DEFAULT_TIER_LIMITS.developer)[]) {
      for (let i = 1; i < TIERS.length; i++) {
        const lo = limits(TIERS[i - 1])[field];
        const hi = limits(TIERS[i])[field];
        if (rank(hi) < rank(lo)) shrinks.push(`${field}: ${TIERS[i - 1]} ${lo} → ${TIERS[i]} ${hi}`);
      }
    }
    expect(shrinks).toEqual([]);
  });

  it('keeps a paid tier worth more than the cheapest plan plus one add-on pack', () => {
    // The inversion this guards against: a free account plus one AI pack must not
    // reach the allowance of a paid tier, or the add-on strictly dominates the
    // tier it was meant to complement.
    //
    // Mirrors `ai_pack`'s grant in api/billing/src/config/billing-config.ts.
    // Hand-copied because a jsdom frontend suite cannot import a service's
    // config; api/billing/test/bundle-sizing.test.ts is what actually holds the
    // pack catalog and the tier ladder in lockstep, against the real values —
    // and this constant had drifted to 500 against a real grant of 100, with a
    // comment citing figures (+2,500 against "Team's entire 2,500") from a tier
    // ladder that no longer exists. It passed at either value, which is exactly
    // why nothing caught it: a stale threshold in a guard still goes green.
    const AI_PACK = 100;
    expect(limits('team').aiCalls).toBeGreaterThan(limits('developer').aiCalls + AI_PACK);
  });
});
