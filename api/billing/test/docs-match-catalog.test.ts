// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * docs/billing-providers.md's copy-paste maps must match the live billing catalog.
 *
 * Those blocks exist to be pasted into a real `.env`, so a stale one is not a
 * documentation nit — it is a misconfiguration shipped to whoever trusted it. The
 * failure is silent in both directions: a bundle missing from STRIPE_PRICE_MAP is
 * GRANTED AND NEVER CHARGED, and one missing from the Marketplace dimension map is
 * granted and never metered. Neither errors; both just quietly give the product away.
 *
 * This has already happened once. `stakeholder_reports` shipped and the doc kept
 * describing 13 add-ons — wrong in the Stripe table, the price-map example, the
 * stated count and both Marketplace maps — until someone read them side by side.
 *
 * EVERY occurrence is checked, not the first. The doc carries each map twice (the
 * step-by-step block and the consolidated paste block), and two copies that disagree
 * is exactly the drift a first-match check would wave through.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { loadBillingConfig } from '../src/config/billing-config.js';

const DOC = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'billing-providers.md'), 'utf8');
const INTERVALS = ['monthly', 'annual'] as const;

/** Every `VAR='{...}'` literal in the doc, parsed. Throws with the var name on bad JSON. */
function literals(varName: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re = new RegExp(`${varName}='(\\{[\\s\\S]*?\\})'`, 'g');
  for (const m of DOC.matchAll(re)) {
    try {
      out.push(JSON.parse(m[1]) as Record<string, unknown>);
    } catch (e) {
      throw new Error(`${varName} example is not valid JSON: ${(e as Error).message}`);
    }
  }
  return out;
}

const catalog = loadBillingConfig();
/** Bundles that cost something — the ones a provider must be able to charge for. */
const pricedBundles = catalog.bundles.filter((b) => (b.prices?.monthly ?? 0) > 0);

describe('billing-providers.md matches the catalog', () => {
  it('has the maps at all (guards the guard)', () => {
    expect(literals('STRIPE_PRICE_MAP').length).toBeGreaterThan(0);
    expect(literals('AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP').length).toBeGreaterThan(0);
    expect(literals('AWS_MARKETPLACE_DIMENSION_PRICE_MAP').length).toBeGreaterThan(0);
    expect(pricedBundles.length).toBeGreaterThan(0);
  });

  it('every STRIPE_PRICE_MAP example covers every chargeable plan and bundle', () => {
    // Same rule validate-provider-config.ts applies at boot, asserted at build time.
    const want: string[] = [];
    for (const p of catalog.plans) {
      if (p.tier === 'unlimited') continue; // billing-disabled default, never sold
      for (const iv of INTERVALS) if ((p.prices?.[iv] ?? 0) > 0) want.push(`${p.id}_${iv}`);
    }
    for (const b of catalog.bundles) {
      for (const iv of INTERVALS) if ((b.prices?.[iv] ?? 0) > 0) want.push(`${b.id}_${iv}`);
    }
    const missing = literals('STRIPE_PRICE_MAP')
      .flatMap((m, i) => want.filter((k) => !(k in m)).map((k) => `example#${i + 1}: ${k}`));
    expect(missing).toEqual([]);
  });

  it('every bundle-dimension example covers every sellable bundle', () => {
    const missing = literals('AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP')
      .flatMap((m, i) => pricedBundles.filter((b) => !(b.id in m)).map((b) => `example#${i + 1}: ${b.id}`));
    expect(missing).toEqual([]);
  });

  it('prices every mapped dimension, at the catalog price', () => {
    const dimMaps = literals('AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP');
    const priceMaps = literals('AWS_MARKETPLACE_DIMENSION_PRICE_MAP');
    const problems: string[] = [];
    priceMaps.forEach((pm, i) => {
      const dims = dimMaps[Math.min(i, dimMaps.length - 1)];
      for (const b of pricedBundles) {
        const dim = dims[b.id] as string | undefined;
        if (!dim) continue; // covered by the previous test
        if (!(dim in pm)) { problems.push(`example#${i + 1}: ${dim} has no price`); continue; }
        if (pm[dim] !== b.prices.monthly) {
          problems.push(`example#${i + 1}: ${dim}=${String(pm[dim])} but catalog says ${b.prices.monthly}`);
        }
      }
    });
    expect(problems).toEqual([]);
  });
});
