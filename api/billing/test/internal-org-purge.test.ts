// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * billing's org-purge cascade leg (`BILLING_INTERNAL.purgeOrg`) and the shared
 * teardown behind it (`purgeOrgBilling`).
 *
 * What is pinned here:
 *  - every billable subscription is cancelled at the provider BEFORE the local
 *    rows go, and the org's subscriptions + events are dropped;
 *  - a subscription whose provider cancel FAILS is kept (with its events) and
 *    reported in `remaining` — a 200 the platform leg reads as NOT an ack, so
 *    the retry cancels it again instead of the provider billing on, untracked;
 *  - a cancel refused because the provider already ended the subscription is
 *    not a failure (the provider's own view is consulted);
 *  - a store failure is a 500; every outcome writes one `org.data.purge` row.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { routeHandler, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockRecordAudit = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockRecordAudit,
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json({ success: true, data }); return res; },
  sendError: (res: any, status: number, message: string) => { res.status(status).json({ success: false, message }); return res; },
  sendBadRequest: (res: any, message: string) => { res.status(400).json({ success: false, message }); return res; },
}));

const mockSubscriptionFind = jest.fn<AnyFn>();
const mockSubscriptionDeleteMany = jest.fn<AnyFn>();
const mockSubscriptionDistinct = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { find: mockSubscriptionFind, deleteMany: mockSubscriptionDeleteMany, distinct: mockSubscriptionDistinct },
}));
const mockEventDeleteMany = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/billing-event.js', () => ({
  BillingEvent: { deleteMany: mockEventDeleteMany },
}));

const mockCancel = jest.fn<AnyFn>();
const mockGetSubscription = jest.fn<AnyFn>();
let providerHasGet = true;
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => (providerHasGet
    ? { cancelSubscription: mockCancel, getSubscription: mockGetSubscription }
    : { cancelSubscription: mockCancel }),
}));

const { createInternalOrgPurgeRoutes } = await import('../src/routes/internal-org-purge.js');

const handler = routeHandler(createInternalOrgPurgeRoutes(), 'post', '/internal/orgs/:orgId/purge');

function makeRes() {
  const res: any = {};
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  return res;
}

const sub = (id: string, externalId?: string) => ({ _id: id, planId: 'pro', externalId });
/** The purge's subscription delete: terminal rows, plus the billable rows it cancelled. */
const subDeleteFilter = (...cancelled: string[]) => ({
  orgId: 'org-9',
  $or: [{ status: { $nin: ['active', 'trialing', 'past_due'] } }, { _id: { $in: cancelled } }],
});
/** What is left after the delete. */
const survivors = (...ids: string[]) => mockSubscriptionDistinct.mockResolvedValue(ids);
const billable = (...subs: unknown[]) => mockSubscriptionFind.mockReturnValue({ limit: jest.fn<AnyFn>().mockResolvedValue(subs) });
const call = async (orgId = 'org-9') => {
  const res = makeRes();
  await handler({ params: { orgId } }, res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  providerHasGet = true;
  mockCancel.mockResolvedValue(undefined);
  mockGetSubscription.mockResolvedValue({ status: 'active' });
  mockSubscriptionDeleteMany.mockResolvedValue({ deletedCount: 1 });
  mockSubscriptionDistinct.mockResolvedValue([]);
  mockEventDeleteMany.mockResolvedValue({ deletedCount: 3 });
});

describe('POST /billing/internal/orgs/:orgId/purge', () => {
  it('cancels at the provider, drops the rows, and acks with empty `remaining`', async () => {
    billable(sub('sub-1', 'ext-1'));
    const res = await call();

    expect(mockSubscriptionFind).toHaveBeenCalledWith({
      orgId: 'org-9', status: { $in: expect.arrayContaining(['active', 'trialing', 'past_due']) },
    });
    expect(mockCancel).toHaveBeenCalledWith('ext-1');
    expect(mockSubscriptionDeleteMany).toHaveBeenCalledWith(subDeleteFilter('sub-1'));
    expect(mockEventDeleteMany).toHaveBeenCalledWith({ orgId: 'org-9' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { orgId: 'org-9', tables: { subscriptions: 1, billingEvents: 3 }, remaining: {} },
    });
    // The removed subscription is mirrored, attributed to the system actor.
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'billing.subscription.delete', actorId: 'system', orgId: 'org-9', targetId: 'sub-1',
    }));
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'org.data.purge',
      actorId: 'system',
      affectedOrgId: 'org-9',
      targetId: 'org-9',
      details: { owner: 'billing', tables: { subscriptions: 1, billingEvents: 3 } },
    }));
  });

  it('a subscription with no provider id is dropped without a cancel', async () => {
    billable(sub('sub-local'));
    await call();
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockSubscriptionDeleteMany).toHaveBeenCalledWith(subDeleteFilter('sub-local'));
  });

  it('KEEPS a subscription whose provider cancel failed and reports it in `remaining` (not an ack)', async () => {
    billable(sub('sub-ok', 'ext-ok'), sub('sub-stuck', 'ext-stuck'));
    mockCancel.mockImplementation(async (ext: unknown) => { if (ext === 'ext-stuck') throw new Error('stripe down'); });
    survivors('sub-stuck');
    const res = await call();

    expect(mockSubscriptionDeleteMany).toHaveBeenCalledWith(subDeleteFilter('sub-ok'));
    expect(mockEventDeleteMany).toHaveBeenCalledWith({ orgId: 'org-9', subscriptionId: { $nin: ['sub-stuck'] } });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { orgId: 'org-9', tables: { subscriptions: 1, billingEvents: 3 }, remaining: { subscriptions: 1 } },
    });
    // Only the cancelled one is recorded as removed; the purge row is a failure.
    const removed = mockRecordAudit.mock.calls.filter(([e]: any[]) => e.action === 'billing.subscription.delete').map(([e]: any[]) => e.targetId);
    expect(removed).toEqual(['sub-ok']);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'org.data.purge', outcome: 'failure', details: expect.objectContaining({ remaining: { subscriptions: 1 } }),
    }));
  });

  it('a cancel refused because the provider already ended the subscription lets the row go', async () => {
    billable(sub('sub-gone', 'ext-gone'));
    mockCancel.mockRejectedValue(new Error('cannot update a canceled subscription'));
    mockGetSubscription.mockResolvedValue({ status: 'canceled' });
    const res = await call();
    expect(mockGetSubscription).toHaveBeenCalledWith('ext-gone');
    expect(mockSubscriptionDeleteMany).toHaveBeenCalledWith(subDeleteFilter('sub-gone'));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ remaining: {} }) }));
  });

  it('keeps the row when the provider view is unknown (lookup throws, or the provider has none)', async () => {
    billable(sub('sub-x', 'ext-x'));
    mockCancel.mockRejectedValue(new Error('stripe down'));
    mockGetSubscription.mockRejectedValue(new Error('stripe down'));
    await call();
    expect(mockSubscriptionDeleteMany).toHaveBeenLastCalledWith(subDeleteFilter());

    providerHasGet = false;
    await call();
    expect(mockSubscriptionDeleteMany).toHaveBeenLastCalledWith(subDeleteFilter());
  });

  it('never drops a row that went billable AFTER the sweep read — it survives and is retained', async () => {
    // The sweep read an empty billable set, then a checkout webhook activated an
    // `incomplete` row. A blanket `{ orgId }` delete would wipe it, uncancelled,
    // while the provider bills on; the status-scoped delete leaves it, and the
    // leg is not acked.
    billable();
    survivors('sub-late');
    const res = await call();

    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockSubscriptionDeleteMany).toHaveBeenCalledWith(subDeleteFilter());
    expect(mockEventDeleteMany).toHaveBeenCalledWith({ orgId: 'org-9', subscriptionId: { $nin: ['sub-late'] } });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ remaining: { subscriptions: 1 } }),
    }));
  });

  it('a store failure is a 500 (the leg retries) and a failure row', async () => {
    billable();
    mockSubscriptionDeleteMany.mockRejectedValue(new Error('mongo down'));
    const res = await call();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'org.data.purge', outcome: 'failure', details: { owner: 'billing', error: 'mongo down' },
    }));
  });

  it('never lets a throwing audit recorder turn the ack into an error', async () => {
    billable();
    mockRecordAudit.mockImplementation(() => { throw new Error('audit sink down'); });
    const res = await call();
    expect(res.status).toHaveBeenCalledWith(200);
    mockRecordAudit.mockReset();
  });

  it('400s without an org id and touches nothing', async () => {
    const res = makeRes();
    await handler({ params: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSubscriptionFind).not.toHaveBeenCalled();
  });
});
