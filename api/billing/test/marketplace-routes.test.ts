// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /billing/marketplace/resolve (registration redirect endpoint).
 *
 * Security/policy regression lock-in: the created Subscription must be keyed on
 * AWS Marketplace's opaque `customerIdentifier` — NEVER the customer's AWS
 * account id. Repo policy forbids persisting AWS account ids, and using the
 * account id as the tenant key would leak it into quota/audit stores. This
 * suite asserts orgId === customerIdentifier and that no `awsAccountId` appears
 * in the persisted document or the response body.
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
  withRoute: (handler: Function) => async (req: any, res: any) =>
    handler({ req, res, ctx: { log: jest.fn() }, orgId: req.orgId }),
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: { marketplace: { snsTopicArn: undefined } },
}));

const mockCalculatePeriodEnd = jest.fn(() => new Date('2026-08-01T00:00:00.000Z'));
const mockCreateBillingEvent = jest.fn(async () => undefined);
const mockSyncEntitlements = jest.fn(async () => undefined);
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  calculatePeriodEnd: (...a: unknown[]) => mockCalculatePeriodEnd(...a),
  createBillingEvent: (...a: unknown[]) => mockCreateBillingEvent(...a),
  syncEntitlements: (...a: unknown[]) => mockSyncEntitlements(...a),
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

jest.unstable_mockModule('../src/models/webhook-dedupe.js', () => ({
  claimWebhookEvent: jest.fn(),
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
  mockSubscriptionCreate.mockImplementation(async (doc: any) => ({
    ...doc,
    _id: { toString: () => 'sub-created-1' },
    addons: [],
  }));
});

describe('POST /marketplace/resolve', () => {
  const handler = getHandler('post', '/marketplace/resolve');

  it('keys the subscription orgId on customerIdentifier, never the AWS account id', async () => {
    const req: any = { body: { 'x-amzn-marketplace-token': 'tok', 'awsAccountId': AWS_ACCOUNT_ID }, query: {} };
    const res = mockRes();
    await handler(req, res);

    expect(mockSubscriptionCreate).toHaveBeenCalledTimes(1);
    const createdDoc = mockSubscriptionCreate.mock.calls[0][0] as any;

    // orgId is the opaque customer identifier — NOT the AWS account id.
    expect(createdDoc.orgId).toBe(CUSTOMER_ID);
    expect(createdDoc.orgId).not.toBe(AWS_ACCOUNT_ID);
    // The persisted doc carries the identifier in metadata but no account id.
    expect(createdDoc.metadata.awsCustomerIdentifier).toBe(CUSTOMER_ID);
    expect(hasAwsAccountIdKey(createdDoc)).toBe(false);
  });

  it('does not include awsAccountId anywhere in the response body', async () => {
    const req: any = { body: { 'x-amzn-marketplace-token': 'tok' }, query: {} };
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalled();
    const [, status, data] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(201);
    expect(hasAwsAccountIdKey(data)).toBe(false);
    // Response echoes the opaque identifier + the customer-keyed orgId.
    expect((data as any).subscription.orgId).toBe(CUSTOMER_ID);
    expect((data as any).customerIdentifier).toBe(CUSTOMER_ID);
  });

  it('syncs entitlements against the customer-identifier orgId', async () => {
    const req: any = { body: { 'x-amzn-marketplace-token': 'tok' }, query: {} };
    const res = mockRes();
    await handler(req, res);

    expect(mockSyncEntitlements).toHaveBeenCalledWith(
      CUSTOMER_ID, 'team', '', 'sub-created-1', expect.anything(),
    );
  });
});
