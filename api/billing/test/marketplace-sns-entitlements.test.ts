// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-layer tests for the AWS Marketplace endpoints that the existing
 * `marketplace-routes.test.ts` does NOT cover:
 *
 *   POST /billing/marketplace/sns          — SNS webhook (validation, signature,
 *                                             topic check, idempotency claim/
 *                                             release, and the notification /
 *                                             entitlement-update side-effects)
 *   GET  /billing/marketplace/entitlements — authenticated entitlement read
 *
 * The provider is a real `AWSMarketplaceProvider` *instance* (so the route's
 * `instanceof` guard passes) with `getEntitlements` stubbed. Mongoose models are
 * mocked; `syncEntitlements`/`createBillingEvent` are spies we assert on.
 *
 * `mapActionToStatus` is the REAL helper (imported before the module is mocked,
 * ESM-jest style) so the action→status mapping is exercised end-to-end, while
 * `verifySNSSignature`/`confirmSNSSubscription` are stubbed (the real ones do
 * network + crypto).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendSuccess = jest.fn((res: any, status: number, data: unknown) => {
  res.status(status).json({ success: true, statusCode: status, data });
});
const mockSendError = jest.fn((res: any, status: number, msg: string) => {
  res.status(status).json({ success: false, statusCode: status, message: msg });
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  requireAuth: () => (_req: any, _res: any, next: () => void) => next(),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function) => async (req: any, res: any) =>
    handler({ req, res, ctx: { log: jest.fn() }, orgId: req.orgId }),
}));

// Mutable so a test can flip the expected SNS topic ARN.
const mockConfig = { marketplace: { snsTopicArn: '' as string } };
jest.unstable_mockModule('../src/config.js', () => ({ config: mockConfig }));

const mockCalculatePeriodEnd = jest.fn(() => new Date('2026-08-01T00:00:00.000Z'));
const mockCreateBillingEvent = jest.fn(async () => undefined);
const mockSyncEntitlements = jest.fn(async () => undefined);
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  calculatePeriodEnd: (...a: unknown[]) => mockCalculatePeriodEnd(...a),
  createBillingEvent: (...a: unknown[]) => mockCreateBillingEvent(...a),
  syncEntitlements: (...a: unknown[]) => mockSyncEntitlements(...a),
}));

const mockPlanFindOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockPlanFindById = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: {
    findOne: (...a: unknown[]) => mockPlanFindOne(...a),
    findById: (...a: unknown[]) => mockPlanFindById(...a),
  },
}));

const mockSubscriptionFindOne = jest.fn<(...a: unknown[]) => unknown>();
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { findOne: (...a: unknown[]) => mockSubscriptionFindOne(...a) },
}));

const mockClaimWebhookEvent = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockReleaseWebhookEvent = jest.fn<(...a: unknown[]) => Promise<void>>();
jest.unstable_mockModule('../src/models/webhook-dedupe.js', () => ({
  claimWebhookEvent: (...a: unknown[]) => mockClaimWebhookEvent(...a),
  releaseWebhookEvent: (...a: unknown[]) => mockReleaseWebhookEvent(...a),
}));

const mockGetEntitlements = jest.fn<(...a: unknown[]) => Promise<unknown>>();
class FakeAWSMarketplaceProvider {
  getEntitlements(...a: unknown[]) { return mockGetEntitlements(...a); }
  resolveRegistrationToken() { return Promise.resolve({}); }
}
jest.unstable_mockModule('../src/providers/aws-marketplace-provider.js', () => ({
  AWSMarketplaceProvider: FakeAWSMarketplaceProvider,
}));

const mockGetPaymentProvider = jest.fn<() => unknown>();
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => mockGetPaymentProvider(),
}));

// The SNS side-effects need signature/confirm stubbed, but the REAL
// action→status mapping. Import the real module first, then mock it.
const { mapActionToStatus: realMapActionToStatus } = await import('../src/helpers/marketplace-helpers.js');
const mockVerifySNSSignature = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockConfirmSNSSubscription = jest.fn<(...a: unknown[]) => Promise<void>>();
jest.unstable_mockModule('../src/helpers/marketplace-helpers.js', () => ({
  verifySNSSignature: (...a: unknown[]) => mockVerifySNSSignature(...a),
  confirmSNSSubscription: (...a: unknown[]) => mockConfirmSNSSubscription(...a),
  mapActionToStatus: realMapActionToStatus,
}));

const { createMarketplaceRoutes } = await import('../src/routes/marketplace.js');

const CUSTOMER_ID = 'cust-OPAQUE-xyz';

const router = createMarketplaceRoutes();

function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/**
 * A findOne query stub that is BOTH awaitable (handleEntitlementUpdate /
 * GET entitlements await it directly) and `.sort()`-chainable (the status-
 * change notification path calls `.sort({ createdAt: -1 })`).
 */
function query(doc: unknown): any {
  return {
    sort: () => Promise.resolve(doc),
    then: (resolve: any, reject: any) => Promise.resolve(doc).then(resolve, reject),
  };
}

/** Build a subscription doc with a spied `.save()`. */
function subDoc(over: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'sub-1' },
    orgId: 'org-1',
    planId: 'developer',
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
    addons: [],
    metadata: { provider: 'aws-marketplace', awsCustomerIdentifier: CUSTOMER_ID },
    save: jest.fn(async () => undefined),
    ...over,
  };
}

/** SNS envelope with the fields the handler validates present by default. */
function snsEnvelope(over: Record<string, unknown> = {}) {
  return {
    Type: 'Notification',
    MessageId: 'msg-1',
    Signature: 'sig',
    TopicArn: 'arn:aws:sns:us-east-1:0:topic',
    ...over,
  };
}

/** Wrap a marketplace notification as the `Message` string SNS delivers. */
function notification(action: string, over: Record<string, unknown> = {}) {
  return JSON.stringify({
    'action': action,
    'customer-identifier': CUSTOMER_ID,
    'product-code': 'prod-1',
    ...over,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.marketplace.snsTopicArn = '';
  mockGetPaymentProvider.mockReturnValue(new FakeAWSMarketplaceProvider());
  mockVerifySNSSignature.mockResolvedValue(true);
  mockConfirmSNSSubscription.mockResolvedValue(undefined);
  mockClaimWebhookEvent.mockResolvedValue(true); // first delivery by default
  mockReleaseWebhookEvent.mockResolvedValue(undefined);
  mockSubscriptionFindOne.mockReturnValue(query(subDoc()));
  mockPlanFindOne.mockResolvedValue({ _id: 'team', tier: 'team', name: 'Team', isActive: true });
  mockPlanFindById.mockResolvedValue({ _id: 'team', tier: 'team', name: 'Team', isActive: true });
  mockGetEntitlements.mockResolvedValue([{ isEntitled: true, planId: 'team', dimension: 'team-dim' }]);
});

describe('POST /marketplace/sns — validation & security', () => {
  const handler = getHandler('post', '/marketplace/sns');

  it('rejects a message missing required envelope fields with 400', async () => {
    const res = mockRes();
    await handler({ body: { Type: 'Notification' /* no MessageId/Signature */ } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockVerifySNSSignature).not.toHaveBeenCalled();
    expect(mockClaimWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature with 403 and never claims the event', async () => {
    mockVerifySNSSignature.mockResolvedValue(false);
    const res = mockRes();
    await handler({ body: snsEnvelope() }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockClaimWebhookEvent).not.toHaveBeenCalled();
    expect(mockSubscriptionFindOne).not.toHaveBeenCalled();
  });

  it('rejects a message from an unexpected topic ARN with 403', async () => {
    mockConfig.marketplace.snsTopicArn = 'arn:aws:sns:us-east-1:0:EXPECTED';
    const res = mockRes();
    await handler({ body: snsEnvelope({ TopicArn: 'arn:aws:sns:us-east-1:0:OTHER' }) }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockClaimWebhookEvent).not.toHaveBeenCalled();
  });

  it('parses a text/plain (string) SNS body before validating', async () => {
    const res = mockRes();
    await handler({ body: JSON.stringify(snsEnvelope({ Type: 'UnsubscribeConfirmation' })) }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const [, status, data] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(200);
    expect((data as any).message).toBe('Unsubscribe acknowledged');
  });
});

describe('POST /marketplace/sns — idempotency', () => {
  const handler = getHandler('post', '/marketplace/sns');

  it('short-circuits a duplicate delivery with 200 and skips all side-effects', async () => {
    mockClaimWebhookEvent.mockResolvedValue(false); // already processed
    const res = mockRes();
    await handler({ body: snsEnvelope({ Type: 'Notification', Message: notification('unsubscribe-success') }) }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const [, , data] = mockSendSuccess.mock.calls[0];
    expect((data as any).message).toBe('Duplicate message acknowledged');
    // No processing occurred.
    expect(mockSubscriptionFindOne).not.toHaveBeenCalled();
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
    expect(mockReleaseWebhookEvent).not.toHaveBeenCalled();
  });

  it('releases the idempotency claim when processing throws, then returns 500', async () => {
    mockSubscriptionFindOne.mockImplementation(() => { throw new Error('db down'); });
    const res = mockRes();
    await handler({ body: snsEnvelope({ Type: 'Notification', Message: notification('unsubscribe-success') }) }, res);

    expect(mockClaimWebhookEvent).toHaveBeenCalledWith('sns', 'msg-1');
    // The claim is released so SNS's retry re-processes rather than being
    // dropped as a duplicate.
    expect(mockReleaseWebhookEvent).toHaveBeenCalledWith('sns', 'msg-1');
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('POST /marketplace/sns — SubscriptionConfirmation', () => {
  const handler = getHandler('post', '/marketplace/sns');

  it('confirms the subscription via SubscribeURL and returns 200', async () => {
    const res = mockRes();
    await handler({
      body: snsEnvelope({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://sns.example/confirm' }),
    }, res);

    expect(mockConfirmSNSSubscription).toHaveBeenCalledWith('https://sns.example/confirm');
    expect(res.status).toHaveBeenCalledWith(200);
    const [, , data] = mockSendSuccess.mock.calls[0];
    expect((data as any).message).toBe('Subscription confirmed');
  });
});

describe('POST /marketplace/sns — Notification status changes', () => {
  const handler = getHandler('post', '/marketplace/sns');

  it('an immediate cancel (unsubscribe-success) downgrades to developer + logs cancellation', async () => {
    const doc = subDoc({ status: 'active' });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: notification('unsubscribe-success') }) }, res);

    expect(doc.status).toBe('canceled');
    expect(doc.save).toHaveBeenCalledTimes(1);
    // Immediate downgrade to the free tier.
    expect(mockSyncEntitlements).toHaveBeenCalledWith('org-1', 'developer', '', 'sub-1');
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_canceled', expect.objectContaining({ newStatus: 'canceled' }), 'sub-1',
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('a soft cancel (unsubscribe-pending) sets cancelAtPeriodEnd and does NOT downgrade now', async () => {
    const doc = subDoc({ status: 'active' });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: notification('unsubscribe-pending') }) }, res);

    expect(doc.status).toBe('active');
    expect(doc.cancelAtPeriodEnd).toBe(true);
    expect(doc.save).toHaveBeenCalledTimes(1);
    // Org paid through the period — no immediate tier strip.
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_canceled',
      expect.objectContaining({ pendingDowngradeAt: doc.currentPeriodEnd }),
      'sub-1',
    );
  });

  it('a reactivation (canceled → subscribe-success) re-syncs the plan tier + logs reactivation', async () => {
    const doc = subDoc({ status: 'canceled', planId: 'team', addons: [{ bundleId: 'seat_pack', quantity: 1 }] });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: notification('subscribe-success') }) }, res);

    expect(doc.status).toBe('active');
    expect(mockPlanFindById).toHaveBeenCalledWith('team');
    expect(mockSyncEntitlements).toHaveBeenCalledWith(
      'org-1', 'team', '', 'sub-1', [{ bundleId: 'seat_pack', quantity: 1 }],
    );
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_reactivated', expect.any(Object), 'sub-1',
    );
  });

  it('an ordinary status change (active → subscribe-success) logs subscription_updated only', async () => {
    const doc = subDoc({ status: 'active' });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: notification('subscribe-success') }) }, res);

    expect(mockSyncEntitlements).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_updated', expect.any(Object), 'sub-1',
    );
  });

  it('takes the NEWEST subscription for the customer (sort createdAt desc)', async () => {
    const sortSpy = jest.fn(() => Promise.resolve(subDoc()));
    mockSubscriptionFindOne.mockReturnValue({ sort: sortSpy });
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: notification('subscribe-success') }) }, res);

    expect(mockSubscriptionFindOne).toHaveBeenCalledWith({ 'metadata.awsCustomerIdentifier': CUSTOMER_ID });
    expect(sortSpy).toHaveBeenCalledWith({ createdAt: -1 });
  });

  it('acks with 200 (no throw) when no subscription matches the customer', async () => {
    mockSubscriptionFindOne.mockReturnValue(query(null));
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: notification('unsubscribe-success') }) }, res);

    expect(mockSyncEntitlements).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('acks with 200 and no side-effects for an unknown/unmapped action', async () => {
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: notification('some-unmapped-action') }) }, res);

    // mapActionToStatus returns null → warn + return, before any DB lookup.
    expect(mockSubscriptionFindOne).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('POST /marketplace/sns — entitlement-updated', () => {
  const handler = getHandler('post', '/marketplace/sns');

  it('re-checks entitlements and upgrades the plan when the entitled plan changed', async () => {
    const doc = subDoc({ status: 'active', planId: 'developer' });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    mockGetEntitlements.mockResolvedValue([{ isEntitled: true, planId: 'team', dimension: 'team-dim' }]);
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: notification('entitlement-updated') }) }, res);

    expect(mockGetEntitlements).toHaveBeenCalledWith(CUSTOMER_ID);
    expect(doc.planId).toBe('team');
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(mockSyncEntitlements).toHaveBeenCalledWith('org-1', 'team', '', 'sub-1', []);
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'plan_changed',
      expect.objectContaining({ oldPlanId: 'developer', newPlanId: 'team' }),
      'sub-1',
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('is a no-op when the entitled plan is unchanged (no save/sync/event)', async () => {
    const doc = subDoc({ status: 'active', planId: 'team' });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    mockGetEntitlements.mockResolvedValue([{ isEntitled: true, planId: 'team', dimension: 'team-dim' }]);
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: notification('entitlement-updated') }) }, res);

    expect(doc.save).not.toHaveBeenCalled();
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('does NOT sync when the new entitlement maps to an unknown/inactive plan', async () => {
    const doc = subDoc({ status: 'active', planId: 'developer' });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    mockGetEntitlements.mockResolvedValue([{ isEntitled: true, planId: 'ghost', dimension: 'x' }]);
    mockPlanFindOne.mockResolvedValue(null); // plan lookup fails
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: notification('entitlement-updated') }) }, res);

    expect(doc.save).not.toHaveBeenCalled();
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('syncs unconditionally on an entitlement DOWNGRADE — the route layer has no over-cap gate', async () => {
    // AWS is the source of truth for marketplace entitlements: a downgrade is
    // applied even if pooled usage now exceeds the lower tier's caps (unlike the
    // self-serve addons/subscriptions routes, which gate via checkEntitlementOvercap).
    const doc = subDoc({ status: 'active', planId: 'team' });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    mockGetEntitlements.mockResolvedValue([{ isEntitled: true, planId: 'developer', dimension: 'dev' }]);
    mockPlanFindOne.mockResolvedValue({ _id: 'developer', tier: 'developer', name: 'Developer', isActive: true });
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: notification('entitlement-updated') }) }, res);

    expect(doc.planId).toBe('developer');
    expect(mockSyncEntitlements).toHaveBeenCalledWith('org-1', 'developer', '', 'sub-1', []);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('GET /marketplace/entitlements', () => {
  const handler = getHandler('get', '/marketplace/entitlements');

  it('returns 400 when the active provider is not an AWS Marketplace provider', async () => {
    mockGetPaymentProvider.mockReturnValue({ notMarketplace: true });
    const res = mockRes();
    await handler({ orgId: 'org-1' }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });

  it('returns 404 when the org has no marketplace subscription', async () => {
    mockSubscriptionFindOne.mockReturnValue(query(null));
    const res = mockRes();
    await handler({ orgId: 'org-1' }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });

  it('returns 404 when the subscription is missing an aws customer identifier', async () => {
    mockSubscriptionFindOne.mockReturnValue(query(subDoc({ metadata: { provider: 'aws-marketplace' } })));
    const res = mockRes();
    await handler({ orgId: 'org-1' }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });

  it('returns the live entitlements + current plan for the org (200)', async () => {
    const entitlements = [{ isEntitled: true, planId: 'team', dimension: 'team-dim' }];
    mockGetEntitlements.mockResolvedValue(entitlements);
    mockSubscriptionFindOne.mockReturnValue(query(subDoc({ planId: 'team' })));
    const res = mockRes();
    await handler({ orgId: 'org-1' }, res);

    // Looks up the org's marketplace subscription, keyed on orgId.
    expect(mockSubscriptionFindOne).toHaveBeenCalledWith({ 'orgId': 'org-1', 'metadata.provider': 'aws-marketplace' });
    expect(mockGetEntitlements).toHaveBeenCalledWith(CUSTOMER_ID);
    expect(res.status).toHaveBeenCalledWith(200);
    const [, status, data] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(200);
    expect(data).toEqual({
      customerIdentifier: CUSTOMER_ID,
      entitlements,
      currentPlanId: 'team',
    });
  });
});
