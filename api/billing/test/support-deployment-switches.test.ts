// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * `SUPPORT_ENABLED` and `SUPPORT_PREMIUM_ENABLED` — the two deployment switches
 * that decide whether support is sellable here at all.
 *
 * BOTH DEFAULT ON. The default assumes the vendor's own deployment, where
 * support is the product. What the switches exist for is the deployment that
 * does NOT staff it:
 *
 *  - A self-hosted install has no vendor behind it, so it must set
 *    `SUPPORT_ENABLED=false` or it advertises a purchasable SKU that routes
 *    nowhere.
 *  - A deployment with no overnight rota should set
 *    `SUPPORT_PREMIUM_ENABLED=false`, since premium sells 24x7 COVERAGE — a
 *    staffing commitment, not a code path.
 *
 * `isActive: false` is the mechanism, deliberately: the addon catalog, the combo
 * validator and the Marketplace dimension check all already filter on it, so the
 * row stays in the catalog (keeping its dimension valid and the ladder
 * documented) while being unpurchasable.
 */

import { describe, it, expect, afterEach } from '@jest/globals';

const TOUCHED = ['SUPPORT_ENABLED', 'SUPPORT_PREMIUM_ENABLED', 'BILLING_ENABLED', 'MONGODB_URI'] as const;
const original = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

/** Load a FRESH copy of the catalog under `env`. */
async function loadBundles(env: Record<string, string>) {
  for (const k of TOUCHED) delete process.env[k];
  process.env.MONGODB_URI = 'mongodb://test:27017/billing';
  Object.assign(process.env, env);
  const mod = await import(`../src/config/billing-config.js?env=${Math.random()}`);
  const cfg = (mod as { loadBillingConfig: () => { bundles: { id: string; isActive: boolean }[] } }).loadBillingConfig();
  return new Map(cfg.bundles.filter((b) => b.id.startsWith('support_')).map((b) => [b.id, b.isActive]));
}

afterEach(() => {
  for (const k of TOUCHED) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe('SUPPORT_ENABLED', () => {
  it('is ON by default — every level sellable with no env set', async () => {
    const b = await loadBundles({});
    expect(b.get('support_standard')).toBe(true);
    expect(b.get('support_priority')).toBe(true);
    expect(b.get('support_premium')).toBe(true);
  });

  it('is independent of BILLING_ENABLED', async () => {
    // Deliberately NOT coupled: an operator who staffs support on a
    // billing-disabled install still gets the SKUs, and one who does not sets
    // SUPPORT_ENABLED=false regardless of billing.
    const b = await loadBundles({ BILLING_ENABLED: 'false' });
    expect(b.get('support_standard')).toBe(true);
  });

  it('can be set explicitly OFF with billing on — a deployment that sells no support', async () => {
    const b = await loadBundles({ SUPPORT_ENABLED: 'false' });
    expect(b.get('support_standard')).toBe(false);
    expect(b.get('support_priority')).toBe(false);
    expect(b.get('support_premium')).toBe(false);
  });

  it('keeps the rows IN the catalog when disabled, only marking them inactive', async () => {
    // The Marketplace dimension map is checked in BOTH directions: a dimension
    // for a bundle that does not exist fails too. Dropping the rows entirely
    // would therefore turn a deployment switch into a catalog contract break.
    const b = await loadBundles({ SUPPORT_ENABLED: 'false' });
    expect([...b.keys()].sort()).toEqual(['support_premium', 'support_priority', 'support_standard']);
  });
});

describe('SUPPORT_PREMIUM_ENABLED', () => {
  it('is ON by default', async () => {
    const b = await loadBundles({});
    expect(b.get('support_premium')).toBe(true);
  });

  it('withdraws ONLY premium when disabled, leaving the other two sellable', async () => {
    // The switch a deployment without an overnight rota uses: the ladder keeps
    // its business-hours levels and loses the one that promises 24x7.
    const b = await loadBundles({ SUPPORT_PREMIUM_ENABLED: 'false' });
    expect(b.get('support_premium')).toBe(false);
    expect(b.get('support_standard')).toBe(true);
    expect(b.get('support_priority')).toBe(true);
  });

  it('cannot enable premium while support as a whole is off', async () => {
    // Otherwise a half-configured deployment would sell the 24x7 level and
    // nothing else — the one combination with no coherent ladder behind it.
    const b = await loadBundles({ SUPPORT_ENABLED: 'false', SUPPORT_PREMIUM_ENABLED: 'true' });
    expect(b.get('support_premium')).toBe(false);
  });
});
