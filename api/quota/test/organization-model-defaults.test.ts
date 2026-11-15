// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * models/organization.ts — the schema defaults (platform seeds real orgs; see
 * the model's SCOPE note). A new document gets the developer tier and a
 * zero-usage window resetting in the future for EVERY quota dimension, but NO
 * limit: an absent limit is the org's tier preset, resolved at read time, and a
 * static default would be persisted onto a hydrated org by its next `save()`.
 * Built in memory only — no database.
 */

import { describe, expect, it } from '@jest/globals';

process.env.MONGODB_URI = 'mongodb://localhost:27017/test';

const { Organization } = await import('../src/models/organization.js');

describe('Organization schema defaults', () => {
  it('seeds the developer tier and a future reset for every usage dimension, but no limit', () => {
    const before = Date.now();
    const org = new Organization({ name: 'Acme', slug: 'acme' });
    expect(org.tier).toBe('developer');
    expect(org.parentOrgId).toBeNull();
    expect(org.deletedAt).toBeNull();
    expect(org.quotas.plugins).toBeUndefined();
    expect(org.quotas.listings).toBeUndefined();
    for (const dim of ['plugins', 'pipelines', 'apiCalls', 'aiCalls', 'storageBytes', 'dashboards', 'alertRules', 'alertDestinations', 'idpConfigs', 'listings'] as const) {
      const usage = org.usage[dim];
      expect({ dim, used: usage.used }).toEqual({ dim, used: 0 });
      expect(new Date(usage.resetAt).getTime()).toBeGreaterThan(before);
    }
  });

  it('a partially supplied usage entry still defaults its reset date', () => {
    const org = new Organization({ name: 'B', slug: 'b', usage: { plugins: { used: 3 } } });
    expect(org.usage.plugins.used).toBe(3);
    expect(org.usage.plugins.resetAt).toBeInstanceOf(Date);
  });

  it('a hydrated org missing a limit does not have one written by its next save', () => {
    // The failure this pins: a static `default:` was applied on hydrate and
    // persisted by `save()`, so editing a Pro org's name wrote Developer's cap
    // for every quota type the org had not been backfilled with.
    const org = Organization.hydrate({ _id: 'o1', name: 'Acme', slug: 'acme', tier: 'pro', quotas: { plugins: 25 } });
    org.name = 'Acme 2';
    const delta = (org as unknown as { $__delta: () => [unknown, { $set?: Record<string, unknown> }] }).$__delta();
    const set = delta[1].$set ?? {};
    expect(Object.keys(set).filter((k) => k.startsWith('quotas.'))).toEqual([]);
    expect(org.quotas.automationCalls).toBeUndefined();
  });

  it('rejects an unknown tier', async () => {
    await expect(new Organization({ name: 'C', slug: 'c', tier: 'platinum' }).validate()).rejects.toMatchObject({ errors: { tier: expect.anything() } });
  });
});
