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
 * The SNS endpoint carries AWS Marketplace LICENSE EVENTS (EventBridge →
 * platform-owned SNS topic), so the Notification cases drive EventBridge event
 * bodies. `verifySNSSignature`/`confirmSNSSubscription` are stubbed (the real
 * ones do network + crypto).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule, handlerGetter } from '@pipeline-builder/api-core/testing';
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

const mockIncCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: (...a: unknown[]) => mockIncCounter(...a),
  withRoute: (handler: Function) => async (req: any, res: any) =>
    handler({ req, res, ctx: { log: jest.fn<AnyFn>() }, orgId: req.orgId }),
}));

// Mutable so a test can flip the expected SNS topic ARN.
const TOPIC = 'arn:aws:sns:us-east-1:0:pipeline-builder-marketplace-events';
const mockConfig = { marketplace: { eventsTopicArn: TOPIC, productCode: 'prod-1' } };
jest.unstable_mockModule('../src/config.js', () => ({ config: mockConfig }));

const mockCalculatePeriodEnd = jest.fn((..._args: unknown[]) => new Date('2026-08-01T00:00:00.000Z'));
const mockCreateBillingEvent = jest.fn(async (..._args: unknown[]) => undefined);
const mockRecordReactivate = jest.fn(async (..._args: unknown[]) => undefined);
const mockSyncEntitlements = jest.fn(async (..._args: unknown[]) => undefined);
// Double-billing prune: default no-op (returns []); a dedicated test overrides it.
const mockApplyTierIncludedAddonPrune = jest.fn(
  (_sub: { addons?: Array<{ bundleId: string; quantity: number }> }) => [] as Array<{ bundleId: string; features: string[] }>,
);
const mockFinalizePrunedAddons = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
// Faithful re-implementation of applyPlanTierChange (deferred sync → plan_changed
// event → prune finalize) so the entitlement-update path's downstream calls stay
// observable on the existing spies. Marketplace threads authHeader `''`.
const mockApplyPlanTierChange = jest.fn((subscription: any, plan: { tier: string }, opts: any) => async () => {
  const auth = opts.authHeader ?? 'Bearer service-token';
  await mockSyncEntitlements(subscription.orgId, plan.tier, auth, subscription._id.toString(), subscription.addons ?? []);
  if (opts.event) {
    await mockCreateBillingEvent(subscription.orgId, opts.event.type, opts.event.details, subscription._id.toString(), opts.actorId);
  } else {
    await mockCreateBillingEvent(subscription.orgId, 'plan_changed', { oldPlanId: opts.oldPlanId, newPlanId: opts.newPlanId, ...opts.eventDetails }, subscription._id.toString(), opts.actorId);
  }
  await mockFinalizePrunedAddons(opts.pruned, subscription.addons ?? [], {
    orgId: subscription.orgId, subscriptionId: subscription._id.toString(), interval: subscription.interval, externalId: subscription.externalId, actorId: opts.actorId, source: opts.source,
  });
});
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  recordReactivatePlanMissing: (...a: unknown[]) => mockRecordReactivate(...a),
  calculatePeriodEnd: (...a: unknown[]) => mockCalculatePeriodEnd(...a),
  createBillingEvent: (...a: unknown[]) => mockCreateBillingEvent(...a),
}));
jest.unstable_mockModule('../src/helpers/entitlement-sync.js', () => ({
  syncEntitlements: (...a: unknown[]) => mockSyncEntitlements(...a),
}));

jest.unstable_mockModule('../src/helpers/addon-prune.js', () => ({
  applyPlanTierChange: mockApplyPlanTierChange,
  applyTierIncludedAddonPrune: (...a: unknown[]) => mockApplyTierIncludedAddonPrune(...(a as [{ addons?: Array<{ bundleId: string; quantity: number }> }])),
  finalizePrunedAddons: (...a: unknown[]) => mockFinalizePrunedAddons(...a),
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

const mockClaimWebhookEvent = jest.fn<(...a: unknown[]) => Promise<string | null>>();
const mockMarkWebhookEventDone = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockReleaseWebhookEvent = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockWebhookEventStatus = jest.fn<(...a: unknown[]) => Promise<string | null>>();
jest.unstable_mockModule('../src/models/webhook-dedupe.js', () => ({
  claimWebhookEvent: (...a: unknown[]) => mockClaimWebhookEvent(...a),
  markWebhookEventDone: (...a: unknown[]) => mockMarkWebhookEventDone(...a),
  releaseWebhookEvent: (...a: unknown[]) => mockReleaseWebhookEvent(...a),
  webhookEventStatus: (...a: unknown[]) => mockWebhookEventStatus(...a),
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
const mockVerifySNSSignature = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockConfirmSNSSubscription = jest.fn<(...a: unknown[]) => Promise<void>>();
jest.unstable_mockModule('../src/helpers/marketplace-helpers.js', () => ({
  verifySNSSignature: (...a: unknown[]) => mockVerifySNSSignature(...a),
  confirmSNSSubscription: (...a: unknown[]) => mockConfirmSNSSubscription(...a),
}));

const { createMarketplaceRoutes } = await import('../src/routes/marketplace.js');

const LICENSE_ID = 'l-c650855e87734887b28b61decef25bef';
// The form ResolveCustomer returns, which is what billing stores…
const LICENSE = `arn:aws:license-manager::111122223333:license:${LICENSE_ID}`;
// …and the form AWS's EventBridge examples show. Matching is on the l-… id.
const EVENT_ARN = `aws:license-manager:us-east-1:111122223333:${LICENSE_ID}`;

const router = createMarketplaceRoutes();

const getHandler = handlerGetter(router);

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
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
    // Real subscriptions always carry an interval (schema default 'monthly'); the
    // entitlement-update path re-derives it from the entitlement term, so the
    // fixture must set it or an interval-drift re-cadence would spuriously fire.
    interval: 'monthly',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
    addons: [],
    metadata: { provider: 'aws-marketplace', awsLicenseArn: LICENSE },
    save: jest.fn(async () => undefined),
    ...over,
  };
}

/** Entitlement expiration ~1 year out → deriveMarketplaceInterval reads 'annual'
 *  (its threshold is ~6 months). */
const ANNUAL_EXP = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

/** Entitlement expiration ~2 months out → deriveMarketplaceInterval reads 'monthly'
 *  (below the ~6-month threshold). Simulates an aging annual term whose remaining
 *  horizon has shrunk into the back half. */
const SHORT_EXP = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

/** SNS envelope with the fields the handler validates present by default. */
function snsEnvelope(over: Record<string, unknown> = {}) {
  return {
    Type: 'Notification',
    MessageId: 'msg-1',
    Signature: 'sig',
    TopicArn: TOPIC,
    ...over,
  };
}

/** Wrap an AWS Marketplace EventBridge event as the `Message` string SNS delivers. */
function event(detailType: string, detail: Record<string, unknown> = {}) {
  return JSON.stringify({
    'version': '0',
    'source': 'aws.agreement-marketplace',
    'detail-type': detailType,
    'detail': {
      agreement: { id: 'agmt-1' },
      product: { code: 'prod-1', id: 'prod-abc' },
      license: { arn: EVENT_ARN },
      ...detail,
    },
  });
}
const UPDATED = 'License Updated - Manufacturer';
const DEPROVISIONED = 'License Deprovisioned - Manufacturer';

beforeEach(() => {
  jest.clearAllMocks();
  // Fail-closed topic check requires a configured topic that matches the
  // default envelope's TopicArn; individual tests override to exercise mismatch.
  mockConfig.marketplace.eventsTopicArn = TOPIC;
  mockGetPaymentProvider.mockReturnValue(new FakeAWSMarketplaceProvider());
  mockVerifySNSSignature.mockResolvedValue(true);
  mockConfirmSNSSubscription.mockResolvedValue(undefined);
  mockClaimWebhookEvent.mockResolvedValue('claim-tok'); // first delivery by default (claim token)
  mockMarkWebhookEventDone.mockResolvedValue(undefined);
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

  it('rejects a message from any topic but the license-events topic with 403', async () => {
    const res = mockRes();
    await handler({ body: snsEnvelope({ TopicArn: 'arn:aws:sns:us-east-1:287250355862:aws-mp-subscription-notification-prod' }) }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockClaimWebhookEvent).not.toHaveBeenCalled();
  });

  it('matches the topic exactly (no prefix match)', async () => {
    const res = mockRes();
    await handler({ body: snsEnvelope({ TopicArn: `${TOPIC}-evil` }) }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockClaimWebhookEvent).not.toHaveBeenCalled();
  });

  it('fails closed: rejects with 403 when no events topic is configured', async () => {
    // An unset expected topic must NOT skip the check — otherwise a validly
    // signed message from any attacker-owned SNS topic would be accepted.
    mockConfig.marketplace.eventsTopicArn = '';
    const res = mockRes();
    await handler({ body: snsEnvelope({ TopicArn: '', Message: event(DEPROVISIONED) }) }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockClaimWebhookEvent).not.toHaveBeenCalled();
    expect(mockSubscriptionFindOne).not.toHaveBeenCalled();
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
    mockClaimWebhookEvent.mockResolvedValue(null); // already processed
    mockWebhookEventStatus.mockResolvedValue('done');
    const res = mockRes();
    await handler({ body: snsEnvelope({ Type: 'Notification', Message: event(DEPROVISIONED) }) }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const [, , data] = mockSendSuccess.mock.calls[0];
    expect((data as any).message).toBe('Duplicate message acknowledged');
    // No processing occurred — and no marker is (re)written for a duplicate.
    expect(mockSubscriptionFindOne).not.toHaveBeenCalled();
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
    expect(mockReleaseWebhookEvent).not.toHaveBeenCalled();
    expect(mockMarkWebhookEventDone).not.toHaveBeenCalled();
  });

  it('answers 503 (retry) — not 200 — when a concurrent delivery holds a LIVE claim', async () => {
    mockClaimWebhookEvent.mockResolvedValue(null);
    mockWebhookEventStatus.mockResolvedValue('in_progress');
    const res = mockRes();
    res.setHeader = jest.fn<AnyFn>();
    await handler({ body: snsEnvelope({ Type: 'Notification', Message: event(DEPROVISIONED) }) }, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
    expect(mockMarkWebhookEventDone).not.toHaveBeenCalled();
  });

  it('writes the durable done-marker only AFTER a delivery is processed', async () => {
    const res = mockRes();
    await handler({ body: snsEnvelope({ Type: 'Notification', Message: event(DEPROVISIONED) }) }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Two-phase: claim first, then promote to the durable marker post-processing.
    expect(mockClaimWebhookEvent).toHaveBeenCalledWith('sns', 'msg-1');
    expect(mockMarkWebhookEventDone).toHaveBeenCalledWith('sns', 'msg-1');
    expect(mockReleaseWebhookEvent).not.toHaveBeenCalled();
  });

  it('releases the idempotency claim when processing throws, then returns 500', async () => {
    mockSubscriptionFindOne.mockImplementation(() => { throw new Error('db down'); });
    const res = mockRes();
    await handler({ body: snsEnvelope({ Type: 'Notification', Message: event(DEPROVISIONED) }) }, res);

    expect(mockClaimWebhookEvent).toHaveBeenCalledWith('sns', 'msg-1');
    // The claim is released so SNS's retry re-processes rather than being
    // dropped as a duplicate — and the done-marker is NOT written on failure
    // (a mid-process crash instead relies on the in-progress lease expiring).
    expect(mockReleaseWebhookEvent).toHaveBeenCalledWith('sns', 'msg-1', 'claim-tok');
    expect(mockMarkWebhookEventDone).not.toHaveBeenCalled();
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

describe('POST /marketplace/sns — License Deprovisioned', () => {
  const handler = getHandler('post', '/marketplace/sns');

  it('cancels the subscription found by license id and downgrades it to developer', async () => {
    const doc = subDoc({ status: 'active' });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: event(DEPROVISIONED) }) }, res);

    // Found by the l-… id (the event spells the ARN differently), then by the stored ARN.
    expect(mockSubscriptionFindOne).toHaveBeenNthCalledWith(1, {
      'metadata.awsLicenseArn': { $regex: `[:/]${LICENSE_ID}$`, $options: 'i' },
    });
    expect(mockSubscriptionFindOne).toHaveBeenNthCalledWith(2, { 'metadata.awsLicenseArn': LICENSE });
    expect(doc.status).toBe('canceled');
    expect(doc.cancelAtPeriodEnd).toBe(false);
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(mockSyncEntitlements).toHaveBeenCalledWith('org-1', 'developer', '', 'sub-1');
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_canceled',
      expect.objectContaining({ reason: 'license_deprovisioned', previousStatus: 'active', newStatus: 'canceled', licenseId: LICENSE_ID }),
      'sub-1',
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('takes the NEWEST subscription for the license (sort createdAt desc)', async () => {
    const sortSpy = jest.fn((..._args: unknown[]) => Promise.resolve(subDoc()));
    mockSubscriptionFindOne.mockReturnValue({ sort: sortSpy });
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: event(DEPROVISIONED) }) }, res);

    expect(sortSpy).toHaveBeenCalledWith({ createdAt: -1 });
  });

  it('is a no-op for a subscription that is already canceled', async () => {
    const doc = subDoc({ status: 'canceled' });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: event(DEPROVISIONED) }) }, res);

    expect(doc.save).not.toHaveBeenCalled();
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('acks with 200 (no side-effects) for a license no subscription carries', async () => {
    mockSubscriptionFindOne.mockReturnValue(query(null));
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: event(DEPROVISIONED) }) }, res);

    expect(mockSubscriptionFindOne).toHaveBeenCalledTimes(1);
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // The rule matches every product this seller account lists.
  it('ignores an event for a different product', async () => {
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: event(DEPROVISIONED, { product: { code: 'other' } }) }) }, res);

    expect(mockSubscriptionFindOne).not.toHaveBeenCalled();
    expect(mockIncCounter).toHaveBeenCalledWith('billing_marketplace_product_code_mismatch_total', { source: 'eventbridge' });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('ignores an event with no license ARN', async () => {
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: event(DEPROVISIONED, { license: {} }) }) }, res);

    expect(mockSubscriptionFindOne).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('takes no action on agreement events (each is followed by a License event)', async () => {
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: event('Purchase Agreement Ended - Proposer') }) }, res);

    expect(mockSubscriptionFindOne).not.toHaveBeenCalled();
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('acks (and ignores) a Notification whose body is not a Marketplace event', async () => {
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: JSON.stringify({ hello: 'world' }) }) }, res);

    expect(mockSubscriptionFindOne).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('POST /marketplace/sns — License Updated', () => {
  const handler = getHandler('post', '/marketplace/sns');

  it('re-checks entitlements and upgrades the plan when the entitled plan changed', async () => {
    const doc = subDoc({ status: 'active', planId: 'developer' });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    mockGetEntitlements.mockResolvedValue([{ isEntitled: true, planId: 'team', dimension: 'team-dim' }]);
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: event(UPDATED) }) }, res);

    expect(mockGetEntitlements).toHaveBeenCalledWith(LICENSE);
    expect(doc.planId).toBe('team');
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(mockSyncEntitlements).toHaveBeenCalledWith('org-1', 'team', '', 'sub-1', []);
    // Routed through applyPlanTierChange now — the plan_changed row carries a
    // trailing (undefined) actorId on the system SNS path.
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'plan_changed',
      expect.objectContaining({ oldPlanId: 'developer', newPlanId: 'team' }),
      'sub-1', undefined,
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('prunes on a marketplace upgrade but is EXEMPT from provider line-item removal (metered add-ons)', async () => {
    const doc = subDoc({ status: 'active', planId: 'developer', interval: 'monthly', externalId: 'aws_sub_x', addons: [{ bundleId: 'bulk_operations', quantity: 1 }] });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    mockGetEntitlements.mockResolvedValue([{ isEntitled: true, planId: 'team', dimension: 'team-dim' }]);
    // team bundles in bulk_operations → dropped locally; the marketplace provider does
    // NOT push line items (finalizePrunedAddons treats it as a no-op removal).
    const reduced: Array<{ bundleId: string; quantity: number }> = [];
    const pruned = [{ bundleId: 'bulk_operations', features: ['bulk_operations'] }];
    mockApplyTierIncludedAddonPrune.mockImplementationOnce((s: any) => { s.addons = reduced; return pruned; });

    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: event(UPDATED) }) }, res);

    expect(doc.planId).toBe('team');
    expect(doc.addons).toEqual(reduced);
    // The auto-prune trail is still recorded (finance reconciliation), just with
    // no actorId (system path). The exemption is inside finalizePrunedAddons.
    expect(mockFinalizePrunedAddons).toHaveBeenCalledWith(
      pruned,
      reduced,
      expect.objectContaining({ orgId: 'org-1', subscriptionId: 'sub-1', externalId: 'aws_sub_x' }),
    );
    expect((mockFinalizePrunedAddons.mock.calls[0][2] as any).actorId).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('is a no-op when the entitled plan AND cadence are unchanged (no save/sync/event)', async () => {
    const doc = subDoc({ status: 'active', planId: 'team', interval: 'monthly' });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    // No expirationDate → deriveMarketplaceInterval reads 'monthly' = current cadence.
    mockGetEntitlements.mockResolvedValue([{ isEntitled: true, planId: 'team', dimension: 'team-dim' }]);
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: event(UPDATED) }) }, res);

    expect(doc.save).not.toHaveBeenCalled();
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('re-cadences interval + period on an interval-ONLY move (same plan, monthly→annual)', async () => {
    const doc = subDoc({ status: 'active', planId: 'team', interval: 'monthly' });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    // Same plan, but a ~1yr term → annual cadence.
    mockGetEntitlements.mockResolvedValue([{ isEntitled: true, planId: 'team', dimension: 'team-dim', expirationDate: ANNUAL_EXP }]);
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: event(UPDATED) }) }, res);

    // Cadence re-derived + period advanced; persisted.
    expect(doc.interval).toBe('annual');
    // Period end = AWS's own term end (the entitlement expiry), not a wall-clock guess.
    expect(doc.currentPeriodEnd).toEqual(ANNUAL_EXP);
    expect(doc.save).toHaveBeenCalledTimes(1);
    // No tier change → no entitlement sync, but an interval_changed row is recorded.
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'interval_changed',
      expect.objectContaining({ provider: 'aws-marketplace', oldInterval: 'monthly', newInterval: 'annual' }),
      'sub-1',
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('ADVANCES the period to the entitlement expiry on a same-plan renewal (still entitled)', async () => {
    const doc = subDoc({ status: 'active', planId: 'team', interval: 'annual', currentPeriodEnd: new Date(Date.now() - 86_400_000) });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    mockGetEntitlements.mockResolvedValue([{ isEntitled: true, planId: 'team', dimension: 'team-dim', expirationDate: ANNUAL_EXP }]);
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: event(UPDATED) }) }, res);

    expect(doc.currentPeriodEnd).toEqual(ANNUAL_EXP);
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
  });

  it('keeps an annual sub ANNUAL when the shrinking horizon (<180d) would derive monthly — no re-cadence, no period reset', async () => {
    // An annual term aging into its back half has exp-now < 180d, so a naive
    // re-derivation reads 'monthly' and would flip the sub, reset the period, and
    // mis-price credits. The update path must NOT shorten an existing interval from
    // the horizon alone.
    // RELATIVE to now, deliberately. This was the absolute '2026-12-01T00:00:00.000Z'
    // while SHORT_EXP is `Date.now() + 60d` — so the two converged and, on
    // 2026-10-02, SHORT_EXP overtook it. The period then legitimately advanced to
    // the later entitlement expiry and this assertion began failing every run, for
    // a reason that reads as a 10-minute clock delta rather than an expired
    // fixture. Must stay comfortably AFTER SHORT_EXP: the point of the case is a
    // sub whose period end is still in the future while the entitlement horizon
    // has shrunk under 180d.
    const originalPeriodEnd = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000);
    const doc = subDoc({ status: 'active', planId: 'team', interval: 'annual', currentPeriodEnd: originalPeriodEnd });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    // Same plan, but a <180d remaining horizon → deriveMarketplaceInterval reads 'monthly'.
    mockGetEntitlements.mockResolvedValue([{ isEntitled: true, planId: 'team', dimension: 'team-dim', expirationDate: SHORT_EXP }]);
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: event(UPDATED) }) }, res);

    // Interval unchanged, period untouched, nothing persisted or re-keyed.
    expect(doc.interval).toBe('annual');
    expect(doc.currentPeriodEnd).toBe(originalPeriodEnd);
    expect(doc.save).not.toHaveBeenCalled();
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
    // No interval_changed row (or any billing event) for a phantom shortening.
    expect(mockCreateBillingEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('re-cadences interval AND syncs the new tier when a plan change also moves the cadence', async () => {
    const doc = subDoc({ status: 'active', planId: 'developer', interval: 'monthly' });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    mockGetEntitlements.mockResolvedValue([{ isEntitled: true, planId: 'team', dimension: 'team-dim', expirationDate: ANNUAL_EXP }]);
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: event(UPDATED) }) }, res);

    expect(doc.planId).toBe('team');
    expect(doc.interval).toBe('annual');
    expect(mockSyncEntitlements).toHaveBeenCalledWith('org-1', 'team', '', 'sub-1', []);
    // plan_changed carries the new interval as a detail...
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'plan_changed',
      expect.objectContaining({ oldPlanId: 'developer', newPlanId: 'team', interval: 'annual' }),
      'sub-1', undefined,
    );
    // ...and a distinct interval_changed row records the cadence move.
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'interval_changed',
      expect.objectContaining({ oldInterval: 'monthly', newInterval: 'annual' }),
      'sub-1',
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('does NOT sync when the new entitlement maps to an unknown/inactive plan', async () => {
    const doc = subDoc({ status: 'active', planId: 'developer' });
    mockSubscriptionFindOne.mockReturnValue(query(doc));
    mockGetEntitlements.mockResolvedValue([{ isEntitled: true, planId: 'ghost', dimension: 'x' }]);
    mockPlanFindOne.mockResolvedValue(null); // plan lookup fails
    const res = mockRes();
    await handler({ body: snsEnvelope({ Message: event(UPDATED) }) }, res);

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
    await handler({ body: snsEnvelope({ Message: event(UPDATED) }) }, res);

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

  it('returns 404 when the subscription carries no license', async () => {
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
    expect(mockGetEntitlements).toHaveBeenCalledWith(LICENSE);
    expect(res.status).toHaveBeenCalledWith(200);
    const [, status, data] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(200);
    expect(data).toEqual({
      licenseArn: LICENSE,
      entitlements,
      currentPlanId: 'team',
    });
  });
});
