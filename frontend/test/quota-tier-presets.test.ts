// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pkg#9 — the quota-admin editor's tier presets are served from the platform
 * `/config` payload (env-override-aware) with the hardcoded table as a fail-soft
 * fallback. `buildTierPresets` overlays server-provided limits onto that fallback:
 * undefined → fallback unchanged; a partial payload merges per-field; the static
 * `TIER_PRESETS` export is the fallback source.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from '@jest/globals';
import { buildTierPresets, TIER_KEYS, TIER_PRESETS } from '../src/components/quotas/constants';
import {
  ALL_TIER_KEYS, TIER_KEYS as SELECTABLE_TIER_KEYS, TEAM_CAPABLE_TIERS, TIER_META, getTierMeta, tierAllowsTeams,
} from '../src/lib/tiers';

/**
 * api-core's tier catalog, read from SOURCE rather than imported: the package
 * barrel pulls in express, which does not load under jsdom. Same approach as
 * seat-remedy.test.ts, which already guards `SEAT_PACK_TIERS` this way.
 */
const CORE = readFileSync(path.join(__dirname, '../../packages/api-core/src/types/quota-tiers.ts'), 'utf8');

/** The `QuotaTier` union members. `VALID_TIERS` is DERIVED (Object.keys), so the
 *  type union is the only literal list of tiers in that file. */
function coreTiers(): string[] {
  const m = /export type QuotaTier =([^;]*);/.exec(CORE);
  if (!m) throw new Error('QuotaTier union not found in api-core quota-tiers.ts');
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
}

/** A named exported array literal from the same file. */
function coreList(name: string): string[] {
  const m = new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(CORE);
  if (!m) throw new Error(`${name} not found in api-core quota-tiers.ts`);
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
}

/** The quota pages' tier pill is the shared TIER_META one. */
const pillClassFor = (tier: string) => getTierMeta(tier).pillClass;

describe('buildTierPresets (pkg#9 server-sourced tier presets)', () => {
  it('returns the hardcoded fallback when no server presets are provided', () => {
    expect(buildTierPresets(undefined)).toBe(TIER_PRESETS);
  });

  it('overlays server-provided limits over the fallback', () => {
    const built = buildTierPresets({
      pro: { pipelines: 999, plugins: 888, apiCalls: 777_000, aiCalls: 666 },
    });
    // Pro reflects the server's env-override values...
    expect(built.pro.limits).toEqual({ pipelines: 999, plugins: 888, apiCalls: 777_000, aiCalls: 666 });
    // ...while labels/descriptions/colors stay local (not server-sourced).
    expect(built.pro.label).toBe(TIER_PRESETS.pro.label);
    expect(built.pro.color).toBe(TIER_PRESETS.pro.color);
    // A tier the server omitted keeps its hardcoded fallback limits.
    expect(built.developer.limits).toEqual(TIER_PRESETS.developer.limits);
  });

  it('merges per-field: an omitted field keeps the fallback value', () => {
    const built = buildTierPresets({ team: { pipelines: 50 } as never });
    expect(built.team.limits.pipelines).toBe(50);
    // plugins/apiCalls/aiCalls fall back to the hardcoded table.
    expect(built.team.limits.plugins).toBe(TIER_PRESETS.team.limits.plugins);
    expect(built.team.limits.apiCalls).toBe(TIER_PRESETS.team.limits.apiCalls);
  });

  it('ignores non-numeric / non-finite server values (fail-soft)', () => {
    const built = buildTierPresets({
      enterprise: { pipelines: NaN as never, plugins: 'x' as never, apiCalls: 123 },
    });
    expect(built.enterprise.limits.pipelines).toBe(TIER_PRESETS.enterprise.limits.pipelines);
    expect(built.enterprise.limits.plugins).toBe(TIER_PRESETS.enterprise.limits.plugins);
    expect(built.enterprise.limits.apiCalls).toBe(123);
  });
});

/**
 * `unlimited` is the DEFAULT tier on a billing-disabled install, so on those
 * deployments it is not an edge case — it is what every org is on. It has to
 * survive every tier map and picker, and never be offered as a purchase.
 */
describe('the `unlimited` tier', () => {
  it('has its own pill rather than falling through to developer\'s', () => {
    expect(pillClassFor('unlimited')).not.toBe(pillClassFor('developer'));
    expect(pillClassFor('unlimited')).toMatch(/slate/);
  });

  it('gives every other tier a distinct pill too', () => {
    const pills = (['developer', 'pro', 'team', 'enterprise', 'unlimited'] as const).map(pillClassFor);
    expect(new Set(pills).size).toBe(pills.length);
  });

  it('is a preset with a real label, not a blank', () => {
    expect(TIER_PRESETS.unlimited.label).toBe('Unlimited');
    expect(TIER_PRESETS.unlimited.limits.pipelines).toBe(-1);
  });

  it('is never offered as a selectable tier', () => {
    expect(TIER_KEYS).not.toContain('unlimited');
  });
});

/**
 * `unlimited` outside the quota screens. Every tier map that a billing-disabled
 * install walks through has to name it: it is not an exotic state there, it is
 * the only state.
 */
describe('`unlimited` across the tier maps', () => {
  it('may parent a team — the backend\'s most permissive tier', () => {
    expect(tierAllowsTeams('unlimited')).toBe(true);
    expect(tierAllowsTeams('team')).toBe(true);
    expect(tierAllowsTeams('enterprise')).toBe(true);
    expect(tierAllowsTeams('pro')).toBe(false);
    expect(tierAllowsTeams('developer')).toBe(false);
    expect(tierAllowsTeams(undefined)).toBe(false);
  });

  it('is offered by filters (ALL_TIER_KEYS) but never by pickers (TIER_KEYS)', () => {
    expect(ALL_TIER_KEYS).toContain('unlimited');
    expect(SELECTABLE_TIER_KEYS).not.toContain('unlimited');
    // A filter must be able to name every tier a row can actually be on.
    for (const tier of Object.keys(TIER_META)) expect(ALL_TIER_KEYS).toContain(tier);
  });

  it('has its own badge colour, so a tier pill never reads as Developer', () => {
    const colors = ALL_TIER_KEYS.map((t) => getTierMeta(t).badgeColor);
    expect(new Set(colors).size).toBe(colors.length);
    expect(getTierMeta('unlimited').badgeColor).not.toBe(getTierMeta('developer').badgeColor);
  });

  it('resolves through getTierMeta rather than falling back to developer', () => {
    expect(getTierMeta('unlimited').label).toBe('Unlimited');
    // An unknown string still falls back, which is the intended safety net.
    expect(getTierMeta('nonsense').key).toBe('developer');
  });
});

/**
 * The frontend keeps its OWN tier catalog in src/lib/tiers.ts — labels, colours
 * and sort order are presentation and do not belong in api-core. But three of
 * its lists are copies of api-core's, and until this block only ONE of them was
 * guarded (`SEAT_PACK_TIERS`, in seat-remedy.test.ts).
 *
 * Both unguarded ones had already drifted:
 *  - `TIER_KEYS` omitted a newly added tier, so it was absent from EVERY picker
 *    (change-tier, create-org, quota presets) while the backend sold it.
 *  - `TEAM_CAPABLE_TIERS` has a comment recording an earlier drift that hid
 *    "Create team" on every billing-disabled deployment.
 *
 * Presentation stays local; membership is asserted against api-core.
 */
describe('tier catalog — frontend mirror of api-core', () => {
  it('parses api-core at all (guards a vacuous pass)', () => {
    // Without this, a renamed export or reformatted union yields [] and every
    // comparison below passes by comparing nothing.
    expect(coreTiers().length).toBeGreaterThan(1);
    expect(coreList('TEAM_CAPABLE_TIERS').length).toBeGreaterThan(0);
  });

  it('knows every tier api-core defines (ALL_TIER_KEYS)', () => {
    expect([...ALL_TIER_KEYS].sort()).toEqual(coreTiers().sort());
  });

  it('offers every SELLABLE tier in pickers — api-core minus `unlimited`', () => {
    // This is the one that broke: a tier present in api-core but missing here is
    // unreachable in the UI even though the backend fully supports it.
    expect([...SELECTABLE_TIER_KEYS].sort()).toEqual(coreTiers().filter((t) => t !== 'unlimited').sort());
    // The quota page re-exports the same list; keep the two from diverging.
    expect([...TIER_KEYS].sort()).toEqual([...SELECTABLE_TIER_KEYS].sort());
  });

  it('allows teams on exactly the tiers api-core does', () => {
    const core = coreList('TEAM_CAPABLE_TIERS');
    expect([...TEAM_CAPABLE_TIERS].sort()).toEqual(core.sort());
    // And the helper agrees with the list for every tier, not just the members.
    for (const tier of coreTiers()) {
      expect({ tier, allows: tierAllowsTeams(tier) }).toEqual({ tier, allows: core.includes(tier) });
    }
  });

  it('gives every api-core tier display metadata and a unique sort position', () => {
    // A tier with no TIER_META renders as developer's colour via getTierMeta's
    // fallback, which is silent and wrong rather than loud.
    const sorts = coreTiers().map((t) => {
      expect(Object.keys(TIER_META)).toContain(t);
      return TIER_META[t as keyof typeof TIER_META].sort;
    });
    expect(new Set(sorts).size).toBe(sorts.length);
  });
});
