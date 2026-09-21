// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `QuotaService.findAtRisk` — the cross-org alerting scan.
 *
 * It used to read each org's OWN summarized numbers, which for a pooled account
 * are the wrong ones twice over:
 *
 *   - a TEAM's own limits are -1, so it read as "unlimited" and was skipped
 *     entirely — a team could sit at 100% of the account's cap and never appear;
 *   - a ROOT showed only its OWN usage rather than the subtree's, so an account
 *     at 95% of its pooled cap looked idle.
 *
 * Either way the alerting cron stayed silent for exactly the accounts it exists
 * to catch. The per-org `/quotas/:orgId/at-risk` route already pooled; this is
 * the cross-org scan brought in line, through the same `pooledStatusFromRows`
 * enforcement uses, so the gate and the alert cannot disagree.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  VALID_QUOTA_TYPES: ['plugins', 'pipelines'],
}));

const find = jest.fn();
jest.unstable_mockModule('../src/models/organization.js', () => ({
  Organization: { find, findOneAndUpdate: jest.fn(), findById: jest.fn() },
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    quota: {
      resetDays: 30,
      poolFallbackTtlMs: 0,
      defaults: { pipelines: 10, plugins: 10, apiCalls: 1000, aiCalls: 100 },
    },
  },
}));

const { quotaService } = await import('../src/services/quota-service.js');

const future = new Date(Date.now() + 86_400_000); // live period

interface Row {
  _id: string;
  name: string;
  slug: string;
  tier: string;
  parentOrgId?: string | null;
  quotas?: Record<string, number>;
  usage?: Record<string, { used: number; resetAt: Date }>;
}

/** Feed the paged `Organization.find()` chain one page at a time. */
function withRows(pages: Row[][]) {
  let call = 0;
  find.mockImplementation(() => ({
    select: () => ({
      sort: () => ({
        skip: () => ({
          limit: () => ({ lean: async () => pages[call++] ?? [] }),
        }),
      }),
    }),
  }));
}

const root = (id: string, quotas: Record<string, number>, used: Record<string, number> = {}): Row => ({
  _id: id, name: id, slug: id, tier: 'team', parentOrgId: null,
  quotas,
  usage: Object.fromEntries(Object.entries(used).map(([k, v]) => [k, { used: v, resetAt: future }])),
});

/** A team: its OWN limits are -1, which is the whole trap. */
const team = (id: string, parentOrgId: string, used: Record<string, number> = {}): Row => ({
  _id: id, name: id, slug: id, tier: 'team', parentOrgId,
  quotas: { plugins: -1, pipelines: -1 },
  usage: Object.fromEntries(Object.entries(used).map(([k, v]) => [k, { used: v, resetAt: future }])),
});

beforeEach(() => { jest.clearAllMocks(); });

describe('QuotaService.findAtRisk', () => {
  it('counts a team\'s usage against the ROOT cap and reports the root', async () => {
    // Root is at 10/100 alone — nowhere near the threshold. The team's 85 is
    // what puts the ACCOUNT at 95%, and the team's own row says "unlimited".
    withRows([[root('acct', { plugins: 100 }, { plugins: 10 }), team('t1', 'acct', { plugins: 85 })]]);

    const entries = await quotaService.findAtRisk(80, 1000);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ orgId: 'acct', type: 'plugins', used: 95, limit: 100, percent: 95 });
  });

  it('reports the account ONCE, not once per team', async () => {
    withRows([[
      root('acct', { plugins: 100 }, { plugins: 10 }),
      team('t1', 'acct', { plugins: 45 }),
      team('t2', 'acct', { plugins: 45 }),
    ]]);

    const entries = await quotaService.findAtRisk(80, 1000);

    expect(entries.map((e) => e.orgId)).toEqual(['acct']);
  });

  it('never reports a team in its own right, even at 100% of the pooled cap', async () => {
    withRows([[root('acct', { plugins: 100 }), team('t1', 'acct', { plugins: 100 })]]);

    const entries = await quotaService.findAtRisk(80, 1000);

    expect(entries.every((e) => e.orgId === 'acct')).toBe(true);
  });

  it('still reports a flat org from its own numbers', async () => {
    withRows([[root('flat', { plugins: 100 }, { plugins: 95 })]]);

    const entries = await quotaService.findAtRisk(80, 1000);

    expect(entries).toMatchObject([{ orgId: 'flat', percent: 95 }]);
  });

  it('skips an unlimited ROOT cap however much the subtree uses', async () => {
    withRows([[root('acct', { plugins: -1 }, { plugins: 10 }), team('t1', 'acct', { plugins: 9999 })]]);
    expect(await quotaService.findAtRisk(80, 1000)).toEqual([]);
  });

  it('emits one row per breached dimension', async () => {
    withRows([[root('acct', { plugins: 100, pipelines: 100 }, { plugins: 90, pipelines: 100 })]]);

    const entries = await quotaService.findAtRisk(80, 1000);

    expect(entries.map((e) => e.type).sort()).toEqual(['pipelines', 'plugins']);
  });

  it('ranks by percent, worst first', async () => {
    withRows([[
      root('a', { plugins: 100 }, { plugins: 81 }),
      root('b', { plugins: 100 }, { plugins: 99 }),
    ]]);

    expect((await quotaService.findAtRisk(80, 1000)).map((e) => e.orgId)).toEqual(['b', 'a']);
  });

  it('pages to exhaustion, and groups a team with a root from an EARLIER page', async () => {
    // The reason grouping cannot happen per page: a full first page forces a
    // second fetch, and the team whose usage breaches the cap lands on it.
    withRows([
      [root('acct', { plugins: 100 }, { plugins: 10 })],
      [team('t1', 'acct', { plugins: 85 })],
      [],
    ]);

    const entries = await quotaService.findAtRisk(80, 1);

    expect(entries).toMatchObject([{ orgId: 'acct', percent: 95 }]);
  });

  it('survives a corrupted parent chain instead of hanging', async () => {
    // A cycle must not spin the walk forever — an alerting scan that never
    // returns is worse than one that mis-groups a row.
    const a: Row = { ...team('a', 'b'), quotas: { plugins: 100 }, usage: { plugins: { used: 95, resetAt: future } } };
    const b: Row = { ...team('b', 'a') };
    withRows([[a, b]]);

    await expect(quotaService.findAtRisk(80, 1000)).resolves.toBeDefined();
  });
});
