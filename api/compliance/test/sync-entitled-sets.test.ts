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
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isSystemOrgId: (orgId?: string) => orgId === '000000000000000000000001',
}));

jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  complianceRuleService: { invalidateRulesCache: jest.fn(async () => undefined) },
}));

// The reconcile runs on ONE tx: record every statement it executes (the
// advisory lock) and hand the same handle to every primitive.
const executed: unknown[] = [];
const TX = { execute: async (q: unknown) => { executed.push(q); return { rows: [] }; } };
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema: { complianceRule: {}, complianceRuleSubscription: {} },
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withTenantTx: (cb: (t: unknown) => Promise<unknown>) => cb(TX),
  drizzleCount: (r: unknown) => r,
}));

const getLastOccurredAt = jest.fn<(...a: unknown[]) => Promise<Date | null>>(async () => null);
const recordWatermark = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../src/services/entitlement-watermark-store.js', () => ({
  entitlementWatermarkStore: { getLastOccurredAt, record: recordWatermark },
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
    expect(res).toEqual({ skipped: false, activated: [], deactivated: [] });
    expect(findBySetTag).not.toHaveBeenCalled();
  });

  it('batch subscribes + activates every rule of an entitled set (fresh org)', async () => {
    getActive.mockResolvedValue([]); // nothing active yet
    const res = await svc.syncEntitledSets('org-1', ['standard'], 'u1');

    // standard rules batch subscribed + activated; advanced (not entitled) deactivated
    expect(bulkSubscribeActive).toHaveBeenCalledWith('org-1', STANDARD, 'u1', TX);
    expect(bulkSetActive).toHaveBeenCalledWith('org-1', ADVANCED, false, 'u1', TX);
    expect(res.activated).toEqual(STANDARD);
    expect(res.deactivated).toEqual([]); // advanced rows weren't active, so no real change
  });

  it('activates both sets when both are entitled (one batch per set)', async () => {
    const res = await svc.syncEntitledSets('org-1', ['standard', 'advanced'], 'u1');
    expect(bulkSubscribeActive).toHaveBeenCalledWith('org-1', STANDARD, 'u1', TX);
    expect(bulkSubscribeActive).toHaveBeenCalledWith('org-1', ADVANCED, 'u1', TX);
    expect(bulkSubscribeActive).toHaveBeenCalledTimes(2);
    expect(bulkSetActive).not.toHaveBeenCalled();
    expect(res.activated).toEqual([...STANDARD, ...ADVANCED]);
  });

  it('deactivates a non-entitled set the org currently enforces', async () => {
    // Org had all advanced rules active; now entitled to standard only.
    getActive.mockResolvedValue([...ADVANCED]);
    const res = await svc.syncEntitledSets('org-1', ['standard'], 'u1');
    expect(bulkSetActive).toHaveBeenCalledWith('org-1', ADVANCED, false, 'u1', TX);
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
    expect(bulkSetActive).toHaveBeenCalledWith('org-1', STANDARD, false, 'u1', TX);
    expect(bulkSetActive).toHaveBeenCalledWith('org-1', ADVANCED, false, 'u1', TX);
    expect(res.deactivated.sort()).toEqual([...STANDARD, ...ADVANCED].sort());
  });

  it('takes a per-org advisory lock on the reconcile transaction', async () => {
    executed.length = 0;
    await svc.syncEntitledSets('org-1', ['standard'], 'u1');
    expect(executed).toHaveLength(1);
    expect(JSON.stringify(executed[0])).toContain('pg_advisory_xact_lock');
    // Every primitive ran on that SAME tx.
    expect(getActive).toHaveBeenCalledWith('org-1', TX);
    expect(findBySetTag).toHaveBeenCalledWith('set:standard', TX);
  });

  it('SKIPS (no reconcile, no record) a push not newer than the watermark — checked inside the locked tx', async () => {
    getLastOccurredAt.mockResolvedValueOnce(new Date('2026-09-02T00:00:00Z'));
    const res = await svc.syncEntitledSets('org-1', ['standard'], 'u1', { occurredAt: new Date('2026-09-01T00:00:00Z') });
    expect(res).toEqual({ skipped: true, activated: [], deactivated: [] });
    expect(getLastOccurredAt).toHaveBeenCalledWith(TX, 'org-1');
    expect(bulkSubscribeActive).not.toHaveBeenCalled();
    expect(recordWatermark).not.toHaveBeenCalled();
  });

  it('applies a newer push and records the watermark on the SAME tx', async () => {
    getLastOccurredAt.mockResolvedValueOnce(new Date('2026-09-01T00:00:00Z'));
    const at = new Date('2026-09-02T00:00:00Z');
    const res = await svc.syncEntitledSets('org-1', ['standard'], 'u1', { occurredAt: at });
    expect(res.skipped).toBe(false);
    expect(bulkSubscribeActive).toHaveBeenCalled();
    expect(recordWatermark).toHaveBeenCalledWith(TX, 'org-1', at);
  });
});
