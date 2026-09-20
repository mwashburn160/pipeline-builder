// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pkg#9 — the quota-admin editor's tier presets are served from the platform
 * `/config` payload (env-override-aware) with the hardcoded table as a fail-soft
 * fallback. `buildTierPresets` overlays server-provided limits onto that fallback:
 * undefined → fallback unchanged; a partial payload merges per-field; the static
 * `TIER_PRESETS` export is the fallback source.
 */

import { buildTierPresets, pillClassFor, TIER_KEYS, TIER_PRESETS } from '../src/components/quotas/constants';
import {
  ALL_TIER_KEYS, TIER_KEYS as SELECTABLE_TIER_KEYS, TIER_META, getTierMeta, tierAllowsTeams,
} from '../src/lib/tiers';

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
