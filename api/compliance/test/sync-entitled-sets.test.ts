// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `ComplianceRuleSubscriptionService.syncEntitledSets` — the
 * idempotent bulk reconcile behind the machine `PUT /entitlements/:orgId` leg.
 *
 * Verifies:
 *  - entitled sets → subscribe + activate every set-tagged published rule
 *  - non-entitled sets → deactivate the org's existing subscriptions (bulk)
 *  - idempotency: a re-sync when everything is already active is a no-op
 *  - only genuine transitions are returned (for accurate auditing)
 *  - system org is inert
 *
 * The DB-touching primitives (findPublishedRuleIdsBySetTag / getSubscribedRuleIds
 * / bulkSubscribeActive / bulkSetActive) are spied on the instance, so this
 * isolates the reconcile orchestration. Entitled sets are granted via ONE
 * batched `bulkSubscribeActive` per set (not a subscribe + setActive per rule).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isSystemOrgId: (orgId?: string) => orgId === '000000000000000000000001',
}));

jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  complianceRuleService: { invalidateRulesCache: jest.fn(async () => undefined) },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: { complianceRule: {}, complianceRuleSubscription: {} },
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withTenantTx: (cb: (t: unknown) => Promise<unknown>) => cb({}),
  drizzleCount: (r: unknown) => r,
}));

const { ComplianceRuleSubscriptionService } = await import('../src/services/subscription-service.js');

const STANDARD = ['s1', 's2', 's3'];
const ADVANCED = ['a1', 'a2'];

describe('syncEntitledSets', () => {
  let svc: InstanceType<typeof ComplianceRuleSubscriptionService>;
  let findBySetTag: ReturnType<typeof jest.spyOn>;
  let getActive: ReturnType<typeof jest.spyOn>;
  let bulkSubscribeActive: ReturnType<typeof jest.spyOn>;
  let bulkSetActive: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    svc = new ComplianceRuleSubscriptionService();
    findBySetTag = jest.spyOn(svc, 'findPublishedRuleIdsBySetTag').mockImplementation(async (tag: string) => {
      if (tag === 'set:standard') return [...STANDARD];
      if (tag === 'set:advanced') return [...ADVANCED];
      return [];
    });
    getActive = jest.spyOn(svc, 'getSubscribedRuleIds').mockResolvedValue([]);
    bulkSubscribeActive = jest.spyOn(svc, 'bulkSubscribeActive').mockResolvedValue(undefined);
    bulkSetActive = jest.spyOn(svc, 'bulkSetActive').mockImplementation(async (_o, ids: string[]) => ids);
  });

  it('is inert for the system org', async () => {
    const res = await svc.syncEntitledSets('000000000000000000000001', ['standard', 'advanced']);
    expect(res).toEqual({ activated: [], deactivated: [] });
    expect(findBySetTag).not.toHaveBeenCalled();
  });

  it('batch subscribes + activates every rule of an entitled set (fresh org)', async () => {
    getActive.mockResolvedValue([]); // nothing active yet
    const res = await svc.syncEntitledSets('org-1', ['standard'], 'u1');

    // standard rules batch subscribed + activated; advanced (not entitled) deactivated
    expect(bulkSubscribeActive).toHaveBeenCalledWith('org-1', STANDARD, 'u1');
    expect(bulkSetActive).toHaveBeenCalledWith('org-1', ADVANCED, false, 'u1');
    expect(res.activated).toEqual(STANDARD);
    expect(res.deactivated).toEqual([]); // advanced rows weren't active, so no real change
  });

  it('activates both sets when both are entitled (one batch per set)', async () => {
    const res = await svc.syncEntitledSets('org-1', ['standard', 'advanced'], 'u1');
    expect(bulkSubscribeActive).toHaveBeenCalledWith('org-1', STANDARD, 'u1');
    expect(bulkSubscribeActive).toHaveBeenCalledWith('org-1', ADVANCED, 'u1');
    expect(bulkSubscribeActive).toHaveBeenCalledTimes(2);
    expect(bulkSetActive).not.toHaveBeenCalled();
    expect(res.activated).toEqual([...STANDARD, ...ADVANCED]);
  });

  it('deactivates a non-entitled set the org currently enforces', async () => {
    // Org had all advanced rules active; now entitled to standard only.
    getActive.mockResolvedValue([...ADVANCED]);
    const res = await svc.syncEntitledSets('org-1', ['standard'], 'u1');
    expect(bulkSetActive).toHaveBeenCalledWith('org-1', ADVANCED, false, 'u1');
    expect(res.deactivated).toEqual(ADVANCED);
  });

  it('is idempotent — a re-sync of already-active rules changes nothing', async () => {
    // Everything already active.
    getActive.mockResolvedValue([...STANDARD, ...ADVANCED]);
    const res = await svc.syncEntitledSets('org-1', ['standard', 'advanced'], 'u1');
    expect(bulkSubscribeActive).not.toHaveBeenCalled();
    expect(res.activated).toEqual([]);
    expect(res.deactivated).toEqual([]);
  });

  it('empty entitlement deactivates all currently-enforced curated rules', async () => {
    getActive.mockResolvedValue([...STANDARD, ...ADVANCED]);
    const res = await svc.syncEntitledSets('org-1', [], 'u1');
    expect(bulkSubscribeActive).not.toHaveBeenCalled();
    expect(bulkSetActive).toHaveBeenCalledWith('org-1', STANDARD, false, 'u1');
    expect(bulkSetActive).toHaveBeenCalledWith('org-1', ADVANCED, false, 'u1');
    expect(res.deactivated.sort()).toEqual([...STANDARD, ...ADVANCED].sort());
  });
});
