// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the AWS Marketplace registration flow:
 *  - POST /billing/marketplace/resolve — banks a short-lived pending registration
 *    (does NOT create a subscription; there's no org to bind to yet).
 *  - POST /billing/marketplace/claim — binds a pending registration to the
 *    caller's authenticated org, creating the subscription.
 *
 * Security/policy regression lock-in: nothing here may persist or return the
 * customer's AWS **account id** (repo policy). The subscription is keyed on the
 * caller's real orgId; the opaque `customerIdentifier` lives only in metadata.
 *
 * Extracts the route handler from the router and drives it directly with mock
 * req/res — no HTTP server.
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
  incCounter: jest.fn(),
  withRoute: (handler: Function) => async (req: any, res: any) =>
    handler({ req, res, ctx: { log: jest.fn() }, orgId: req.orgId, userId: req.userId }),
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: { marketplace: { snsTopicArn: undefined } },
}));

const mockCalculatePeriodEnd = jest.fn(() => new Date('2026-08-01T00:00:00.000Z'));
const mockCreateBillingEvent = jest.fn(async () => undefined);
const mockSyncEntitlements = jest.fn(async () => undefined);
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  recordReactivatePlanMissing: async () => undefined,
  MANAGEABLE_SUBSCRIPTION_STATUSES: ['active', 'trialing', 'past_due'],
  calculatePeriodEnd: (...a: unknown[]) => mockCalculatePeriodEnd(...a),
  createBillingEvent: (...a: unknown[]) => mockCreateBillingEvent(...a),
  syncEntitlements: (...a: unknown[]) => mockSyncEntitlements(...a),
  applyTierIncludedAddonPrune: () => [],
  applyPlanTierChange: () => async () => undefined,
  finalizePrunedAddons: async () => undefined,
}));

// prune/plan-change helpers moved to addon-prune.js (imported by marketplace route now).
jest.unstable_mockModule('../src/helpers/addon-prune.js', () => ({
  applyTierIncludedAddonPrune: () => [],
  applyPlanTierChange: () => async () => undefined,
  finalizePrunedAddons: async () => undefined,
}));

jest.unstable_mockModule('../src/helpers/marketplace-helpers.js', () => ({
  verifySNSSignature: jest.fn(),
  confirmSNSSubscription: jest.fn(),
  mapActionToStatus: jest.fn(),
}));

const mockPlanFindOne = jest.fn();
jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: { findOne: (...a: unknown[]) => mockPlanFindOne(...a) },
}));

const mockSubscriptionFindOne = jest.fn();
const mockSubscriptionCreate = jest.fn();
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: {
    findOne: (...a: unknown[]) => mockSubscriptionFindOne(...a),
    create: (...a: unknown[]) => mockSubscriptionCreate(...a),
  },
}));

const mockPendingCreate = jest.fn();
const mockPendingFindOneAndDelete = jest.fn();
const mockPendingDeleteMany = jest.fn(async () => ({ deletedCount: 0 }));
jest.unstable_mockModule('../src/models/marketplace-pending-registration.js', () => ({
  MarketplacePendingRegistration: {
    create: (...a: unknown[]) => mockPendingCreate(...a),
    // resolve supersedes prior unclaimed rows; claim atomically consumes.
    deleteMany: (...a: unknown[]) => mockPendingDeleteMany(...a),
    findOneAndDelete: (...a: unknown[]) => mockPendingFindOneAndDelete(...a),
  },
  PENDING_REGISTRATION_TTL_MS: 1_800_000,
}));

jest.unstable_mockModule('../src/models/webhook-dedupe.js', () => ({
  claimWebhookEvent: jest.fn(),
  markWebhookEventDone: jest.fn(),
  releaseWebhookEvent: jest.fn(),
}));

// The provider must be a real AWSMarketplaceProvider *instance* for the route's
// `instanceof` guard, with the two methods the resolve flow calls stubbed.
const mockResolveRegistrationToken = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockGetEntitlements = jest.fn<(...a: unknown[]) => Promise<unknown>>();
class FakeAWSMarketplaceProvider {
  resolveRegistrationToken(...a: unknown[]) { return mockResolveRegistrationToken(...a); }
  getEntitlements(...a: unknown[]) { return mockGetEntitlements(...a); }
}
jest.unstable_mockModule('../src/providers/aws-marketplace-provider.js', () => ({
  AWSMarketplaceProvider: FakeAWSMarketplaceProvider,
}));

const mockGetPaymentProvider = jest.fn<() => unknown>();
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => mockGetPaymentProvider(),
}));

const { createMarketplaceRoutes } = await import('../src/routes/marketplace.js');

const CUSTOMER_ID = 'cust-ABC123opaque';
const AWS_ACCOUNT_ID = '111122223333'; // must NEVER appear anywhere we persist/return

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

/** Deep scan for the string 'awsAccountId' as an object key. */
function hasAwsAccountIdKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasAwsAccountIdKey);
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'awsAccountId') return true;
      if (hasAwsAccountIdKey(v)) return true;
    }
  }
  return false;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPaymentProvider.mockReturnValue(new FakeAWSMarketplaceProvider());
  // Resolve returns ONLY the opaque identifier + product code (no account id).
  mockResolveRegistrationToken.mockResolvedValue({ customerIdentifier: CUSTOMER_ID, productCode: 'prod-1' });
  mockGetEntitlements.mockResolvedValue([{ isEntitled: true, planId: 'team', dimension: 'team-dim' }]);
  mockPlanFindOne.mockResolvedValue({ _id: 'team', tier: 'team', name: 'Team', isActive: true });
  mockSubscriptionFindOne.mockResolvedValue(null); // no existing active subscription
  mockPendingCreate.mockImplementation(async (doc: any) => doc);
  mockSubscriptionCreate.mockImplementation(async (doc: any) => ({
    ...doc,
    _id: { toString: () => 'sub-created-1' },
    addons: [],
  }));
});

describe('POST /marketplace/resolve', () => {
  const handler = getHandler('post', '/marketplace/resolve');

  it('banks a pending registration keyed on customerIdentifier — no subscription, no AWS account id', async () => {
    const req: any = { body: { 'x-amzn-marketplace-token': 'tok', 'awsAccountId': AWS_ACCOUNT_ID }, query: {} };
    const res = mockRes();
    await handler(req, res);

    // resolve must NOT create a subscription (there's no org to bind to yet).
    expect(mockSubscriptionCreate).not.toHaveBeenCalled();
    expect(mockPendingCreate).toHaveBeenCalledTimes(1);

    const pending = mockPendingCreate.mock.calls[0][0] as any;
    expect(pending.awsCustomerIdentifier).toBe(CUSTOMER_ID);
    expect(pending.planId).toBe('team');
    expect(hasAwsAccountIdKey(pending)).toBe(false);
  });

  it('returns a registrationRef + planName and leaks neither the AWS account id nor the customerIdentifier', async () => {
    const req: any = { body: { 'x-amzn-marketplace-token': 'tok' }, query: {} };
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalled();
    const [, status, data] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(201);
    const pending = mockPendingCreate.mock.calls[0][0] as any;
    expect((data as any).alreadyRegistered).toBe(false);
    expect((data as any).registrationRef).toBe(pending._id);
    expect((data as any).planName).toBe('Team');
    // The opaque handle is the ONLY thing the browser gets — no AWS identity.
    expect((data as any).customerIdentifier).toBeUndefined();
    expect(hasAwsAccountIdKey(data)).toBe(false);
  });

  it('short-circuits to alreadyRegistered when the customer is already bound', async () => {
    mockSubscriptionFindOne.mockResolvedValueOnce({
      _id: { toString: () => 'sub-x' }, orgId: 'org-existing', planId: 'team', status: 'active',
    });
    const req: any = { body: { 'x-amzn-marketplace-token': 'tok' }, query: {} };
    const res = mockRes();
    await handler(req, res);

    const [, status, data] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(200);
    expect((data as any).alreadyRegistered).toBe(true);
    expect(mockPendingCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionCreate).not.toHaveBeenCalled();
  });

  it('rejects a body-supplied orgId (no pre-binding on the unauthenticated route)', async () => {
    const req: any = { body: { 'x-amzn-marketplace-token': 'tok', orgId: 'attacker-org' }, query: {} };
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 400, expect.stringContaining('orgId'), expect.anything());
    expect(mockPendingCreate).not.toHaveBeenCalled();
  });

  it('derives interval=annual from a long-term entitlement into the pending record', async () => {
    mockGetEntitlements.mockResolvedValue([
      { isEntitled: true, planId: 'team', dimension: 'team-dim', expirationDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
    ]);
    await handler({ body: { 'x-amzn-marketplace-token': 'tok' }, query: {} }, mockRes());
    expect((mockPendingCreate.mock.calls[0][0] as any).interval).toBe('annual');
  });

  it('defaults interval=monthly when the entitlement carries no term', async () => {
    await handler({ body: { 'x-amzn-marketplace-token': 'tok' }, query: {} }, mockRes());
    expect((mockPendingCreate.mock.calls[0][0] as any).interval).toBe('monthly');
  });
});

describe('POST /marketplace/claim', () => {
  const handler = getHandler('post', '/marketplace/claim');
  const PENDING = {
    _id: 'ref-1', awsCustomerIdentifier: CUSTOMER_ID, awsProductCode: 'prod-1',
    planId: 'team', dimension: 'team-dim', interval: 'monthly',
  };

  it('binds the pending registration to the CALLER\'s org and consumes it', async () => {
    mockPendingFindOneAndDelete.mockResolvedValue(PENDING);
    const req: any = { body: { registrationRef: 'ref-1' }, orgId: 'org-real', userId: 'user-1' };
    const res = mockRes();
    await handler(req, res);

    expect(mockSubscriptionCreate).toHaveBeenCalledTimes(1);
    const created = mockSubscriptionCreate.mock.calls[0][0] as any;
    expect(created.orgId).toBe('org-real'); // the real org, NOT the customer id
    expect(created.metadata.awsCustomerIdentifier).toBe(CUSTOMER_ID);
    expect(hasAwsAccountIdKey(created)).toBe(false);

    // Tier synced against the real org; the ref is consumed atomically by the
    // findOneAndDelete (single-use even under a race).
    expect(mockSyncEntitlements).toHaveBeenCalledWith('org-real', 'team', 'user-1', 'sub-created-1', expect.anything());
    expect(mockPendingFindOneAndDelete).toHaveBeenCalledWith({ _id: 'ref-1' });

    const [, status] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(201);
  });

  it('410s when the registration is missing or expired', async () => {
    mockPendingFindOneAndDelete.mockResolvedValue(null);
    const req: any = { body: { registrationRef: 'gone' }, orgId: 'org-real', userId: 'user-1' };
    await handler(req, mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 410, expect.any(String), expect.anything());
    expect(mockSubscriptionCreate).not.toHaveBeenCalled();
  });

  it('409s when the AWS customer is already bound to another org', async () => {
    mockPendingFindOneAndDelete.mockResolvedValue(PENDING);
    mockSubscriptionFindOne.mockResolvedValueOnce({ _id: { toString: () => 'x' }, orgId: 'other', status: 'active' });
    const req: any = { body: { registrationRef: 'ref-1' }, orgId: 'org-real', userId: 'user-1' };
    await handler(req, mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 409, expect.stringContaining('already linked'), expect.anything());
    expect(mockSubscriptionCreate).not.toHaveBeenCalled();
  });

  it('409s when the caller org already has an active subscription', async () => {
    mockPendingFindOneAndDelete.mockResolvedValue(PENDING);
    mockSubscriptionFindOne
      .mockResolvedValueOnce(null) // not bound elsewhere
      .mockResolvedValueOnce({ _id: { toString: () => 'y' }, orgId: 'org-real', status: 'active' }); // org already active
    const req: any = { body: { registrationRef: 'ref-1' }, orgId: 'org-real', userId: 'user-1' };
    await handler(req, mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 409, expect.stringContaining('already has an active'), expect.anything());
    expect(mockSubscriptionCreate).not.toHaveBeenCalled();
  });

  it('400s when registrationRef is missing', async () => {
    const req: any = { body: {}, orgId: 'org-real', userId: 'user-1' };
    await handler(req, mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 400, expect.any(String), expect.anything());
  });
});
