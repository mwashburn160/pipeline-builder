// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The frontend's `TIER_LIMITS` fallback must equal api-core's real tier limits.
 *
 * `frontend/src/components/quotas/constants.ts` keeps a hardcoded copy whose own
 * comment says "Mirrors the backend DEFAULT_TIER_LIMITS — keep in sync". It is
 * overlaid by server-supplied limits at runtime, so a drifted copy does not
 * break the page outright — it just prefills the quota-admin editor's per-tier
 * presets with numbers that are no longer the product's. An admin who clicks a
 * preset then SAVES stale limits onto a real org, and nothing anywhere reports
 * it. That is the failure this guards: wrong-but-plausible, written by a human
 * who trusted the UI.
 *
 * It had NOT drifted when this test was added (checked against git), so this
 * pins a property that currently holds rather than papering over a break — the
 * tier numbers had simply never been changed since the copy was made, and the
 * first change to them is exactly when a hand-sync fails.
 *
 * Only the four DISPLAYED quota types are compared, because that is all the
 * fallback carries; `unlimited` is excluded since it is the billing-off default
 * and is never offered as a preset.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * api-core's limits are read from SOURCE, not imported. Two separate reasons,
 * and the second only showed up in the full build:
 *
 *  1. The api-core BARREL pulls in Express transitively (content-disposition
 *     touches TextDecoder, which jsdom does not define), so importing it fails
 *     the suite at LOAD with an error naming nothing to do with quotas.
 *  2. The obvious dodge — a deep `@pipeline-builder/api-core/lib/...` import —
 *     passes a targeted `jest --testPathPatterns` run and then FAILS the real
 *     frontend test target with "Must use import to load ES Module". The
 *     frontend transpiles its own TS to CommonJS and does not transform
 *     node_modules, so the workspace package's ESM output cannot be required.
 *     That pattern works in api-server/platform suites (which run as ESM) and
 *     is the trap here.
 *
 * So this matches its two siblings — seat-remedy.test.ts and the tier-catalog
 * block in quota-tier-presets.test.ts both parse api-core's source for exactly
 * this reason. `DEFAULT_TIER_LIMITS` is also the RIGHT target: it is what the
 * frontend table says it mirrors, where `QUOTA_TIERS` is env-override-aware and
 * would make this test depend on the ambient environment.
 */
const API_CORE = join(__dirname, '..', '..', 'packages', 'api-core', 'src', 'types', 'quota-tiers.ts');

function coreLimits(): Record<string, Record<string, number>> {
  const src = readFileSync(API_CORE, 'utf-8');
  const block = /const DEFAULT_TIER_LIMITS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
  if (!block) throw new Error('DEFAULT_TIER_LIMITS not found in api-core quota-tiers.ts');
  const out: Record<string, Record<string, number>> = {};
  let current: string | null = null;
  for (const line of block[1]!.split('\n')) {
    const open = /^ {2}(\w+):\s*\{/.exec(line);
    if (open) { current = open[1]!; out[current] = {}; continue; }
    const field = /^\s+(\w+):\s*(-?[\d_]+)/.exec(line);
    // `storageBytes: 2 * GB` is skipped by the numeric pattern, which is fine —
    // the four compared fields are all plain integers.
    if (field && current) out[current]![field[1]!] = Number(field[2]!.replace(/_/g, ''));
  }
  return out;
}

/** Parsed once. Named for what it IS, so nobody reads it as the real import. */
const CORE_LIMITS = coreLimits();

const CONSTANTS = join(__dirname, '..', 'src', 'components', 'quotas', 'constants.ts');
const TIERS = ['developer', 'pro', 'team', 'business', 'enterprise'] as const;
const FIELDS = ['pipelines', 'plugins', 'apiCalls', 'aiCalls'] as const;

/**
 * Parse the fallback table out of the source rather than importing it: it is a
 * module-private const behind a `@/` path alias, and reading the text is also
 * what proves the literal an author edits is the one under test.
 */
function fallback(): Record<string, Record<string, number>> {
  const src = readFileSync(CONSTANTS, 'utf-8');
  const block = /const TIER_LIMITS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
  expect(block).not.toBeNull();
  const out: Record<string, Record<string, number>> = {};
  for (const line of block![1].split('\n')) {
    const m = /^\s*(\w+):\s*\{(.+)\},\s*$/.exec(line);
    if (!m) continue;
    const fields: Record<string, number> = {};
    for (const [, k, v] of m[2].matchAll(/(\w+):\s*(-?\d+)/g)) fields[k] = Number(v);
    out[m[1]] = fields;
  }
  return out;
}

describe('the frontend tier-limit fallback mirrors api-core', () => {
  it('parses the table at all (guards a vacuous pass)', () => {
    // Without this, a renamed const or a reformatted table would yield an empty
    // object and every comparison below would pass by comparing nothing.
    const fb = fallback();
    expect(Object.keys(fb)).toEqual(expect.arrayContaining([...TIERS]));
    for (const t of TIERS) expect(Object.keys(fb[t])).toEqual(expect.arrayContaining([...FIELDS]));
  });

  it.each(TIERS)('%s matches the real limits', (tier) => {
    const fb = fallback()[tier];
    const real = CORE_LIMITS[tier] ?? {};
    const mine = Object.fromEntries(FIELDS.map((f) => [f, fb[f]]));
    const theirs = Object.fromEntries(FIELDS.map((f) => [f, real[f]]));
    expect({ tier, ...mine }).toEqual({ tier, ...theirs });
  });
});

describe('the tier ladder keeps its invariants', () => {
  const limits = (t: typeof TIERS[number]) => CORE_LIMITS[t] ?? {};

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

  it('keeps a paid tier worth more than the cheapest plan plus one add-on pack', () => {
    // The inversion that existed for AI: a free account plus one $19.99 AI pack
    // (+2,500) exceeded Team's entire 2,500 allowance, so the add-on strictly
    // dominated the tier it was meant to complement.
    // Mirrors `ai_pack`'s grant in api/billing/src/config/billing-config.ts.
    // Hand-copied because a jsdom frontend suite cannot import a service's
    // config; api/billing/test/bundle-sizing.test.ts is what actually holds the
    // pack catalog and the tier ladder in lockstep, against the real values.
    const AI_PACK = 500;
    expect(limits('team').aiCalls).toBeGreaterThan(limits('developer').aiCalls + AI_PACK);
  });
});
