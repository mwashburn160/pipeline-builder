// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Service-level tests for the curated-set surface of the subscription service:
 *  - `autoSubscribeToPublished` SKIPS `set:*`-tagged published rules (onboarding
 *    only hands out the baseline catalog; entitled sets come from the lifecycle).
 *  - `getActiveEntitledSets` returns the DISTINCT set names among an org's
 *    ACTIVE published-rule subscriptions (the drift-read shape billing GETs).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Rows the mocked SELECTs return, swapped per test.
let selectRows: unknown[] = [];
// Captured insert payload from autoSubscribeToPublished.
let insertedValues: Array<{ ruleId: string }> = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isSystemOrgId: (orgId?: string) => orgId === '000000000000000000000001',
}));

jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  complianceRuleService: { invalidateRulesCache: jest.fn(async () => undefined) },
}));

// A chainable tx whose terminal call resolves to `selectRows`. `insert` captures
// the values for assertion and resolves an inserted-id row per value.
function makeTx() {
  const terminal = {
    from: () => terminal,
    innerJoin: () => terminal,
    where: () => Promise.resolve(selectRows),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(selectRows).then(resolve),
  };
  return {
    select: () => terminal,
    insert: () => ({
      values: (vals: Array<{ ruleId: string }>) => {
        insertedValues = vals;
        return { onConflictDoNothing: () => ({ returning: () => Promise.resolve(vals.map((v) => ({ id: v.ruleId }))) }) };
      },
    }),
  };
}

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: { complianceRule: {}, complianceRuleSubscription: {} },
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withTenantTx: (cb: (t: unknown) => Promise<unknown>) => cb(makeTx()),
  drizzleCount: (r: unknown) => r,
}));

const { subscriptionService } = await import('../src/services/subscription-service.js');

beforeEach(() => {
  jest.clearAllMocks();
  selectRows = [];
  insertedValues = [];
});

describe('autoSubscribeToPublished — skips curated (set-tagged) rules', () => {
  it('only auto-subscribes baseline (un-tagged) published rules', async () => {
    selectRows = [
      { id: 'base-1', tags: [] },
      { id: 'base-2', tags: ['quality'] },
      { id: 'std-1', tags: ['set:standard'] },
      { id: 'adv-1', tags: ['set:advanced', 'security'] },
    ];
    const count = await subscriptionService.autoSubscribeToPublished('org-a', 'u1');
    const ids = insertedValues.map((v) => v.ruleId).sort();
    expect(ids).toEqual(['base-1', 'base-2']);
    expect(count).toBe(2);
  });

  it('inserts nothing when every published rule is curated', async () => {
    selectRows = [
      { id: 'std-1', tags: ['set:standard'] },
      { id: 'adv-1', tags: ['set:advanced'] },
    ];
    const count = await subscriptionService.autoSubscribeToPublished('org-a', 'u1');
    expect(count).toBe(0);
    expect(insertedValues).toEqual([]);
  });
});

describe('getActiveEntitledSets — distinct active set names', () => {
  it('returns the distinct KNOWN set names, sorted, ignoring unknowns', async () => {
    selectRows = [
      { tags: ['set:standard', 'quality'] },
      { tags: ['set:advanced'] },
      { tags: ['set:standard'] }, // duplicate → deduped
      { tags: ['set:bogus'] }, // unknown → dropped
      { tags: ['no-set'] },
    ];
    const sets = await subscriptionService.getActiveEntitledSets('org-a');
    expect(sets).toEqual(['advanced', 'standard']);
  });

  it('is empty for the system org (owns the library, never subscribes)', async () => {
    const sets = await subscriptionService.getActiveEntitledSets('000000000000000000000001');
    expect(sets).toEqual([]);
  });

  it('is empty when the org enforces no curated rules', async () => {
    selectRows = [{ tags: ['quality'] }, { tags: [] }];
    const sets = await subscriptionService.getActiveEntitledSets('org-a');
    expect(sets).toEqual([]);
  });
});
