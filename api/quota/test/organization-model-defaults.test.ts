// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * models/organization.ts — the schema defaults behind the unprovisioned-org
 * fallback read (platform seeds real orgs; see the model's SCOPE note). A new
 * document gets the developer tier, the configured default limits, and a
 * zero-usage window resetting in the future for EVERY quota dimension. Built
 * in memory only — no database.
 */

import { describe, expect, it } from '@jest/globals';

process.env.MONGODB_URI = 'mongodb://localhost:27017/test';

const { Organization } = await import('../src/models/organization.js');
const { config } = await import('../src/config.js');

describe('Organization schema defaults', () => {
  it('seeds the developer tier, default limits and a future reset for every usage dimension', () => {
    const before = Date.now();
    const org = new Organization({ name: 'Acme', slug: 'acme' });
    expect(org.tier).toBe('developer');
    expect(org.parentOrgId).toBeNull();
    expect(org.deletedAt).toBeNull();
    expect(org.quotas.plugins).toBe(config.quota.defaults.plugins);
    expect(org.quotas.listings).toBe(config.quota.defaults.listings);
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

  it('rejects an unknown tier', async () => {
    await expect(new Organization({ name: 'C', slug: 'c', tier: 'platinum' }).validate()).rejects.toMatchObject({ errors: { tier: expect.anything() } });
  });
});
