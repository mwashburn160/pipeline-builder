// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-layer tests for GET /billing/usage.
 *
 * The pure period/cost/rollup math lives in `buildUsageRollup` and is covered
 * exhaustively by `usage-helpers.test.ts`. This suite covers the ROUTE wiring
 * the helper tests can't see:
 *   - the auth middleware is applied (allowOrgHeaderOverride)
 *   - the active subscription + plan are read and threaded into the rollup
 *     builder in the exact shape it expects
 *   - the caller's Authorization header is forwarded (or defaulted to '')
 *   - free / unsubscribed and plan-missing orgs still get a rollup
 *   - the builder's result is serialized verbatim with 200
 *
 * `buildUsageRollupFor` and the Mongoose models are mocked; we assert on the
 * arguments the route hands the builder and on the emitted status/body.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendSuccess = jest.fn((res: any, status: number, data: unknown) => {
  res.status(status).json({ success: true, statusCode: status, data });
});

// requireAuth records the options it was constructed with so we can assert the
// route opts into header-based org override.
const mockRequireAuth = jest.fn((_opts: unknown) => (_req: any, _res: any, next: () => void) => next());

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  requireAuth: (...a: unknown[]) => mockRequireAuth(...a),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function) => async (req: any, res: any) =>
    handler({ req, res, ctx: { log: jest.fn() }, orgId: req.orgId }),
}));

const mockBuildUsageRollupFor = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/helpers/usage-helpers.js', () => ({
  buildUsageRollupFor: (...a: unknown[]) => mockBuildUsageRollupFor(...a),
}));

// The route now widens the sub lookup to the manageable (non-terminal) set via
// the shared const. Mock billing-helpers so importing it here doesn't drag in
// the real config module (which throws without MONGODB_URI); re-export the real
// constant so the `$in` filter isn't `undefined`.
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  MANAGEABLE_SUBSCRIPTION_STATUSES: ['active', 'trialing', 'past_due'],
}));

// Subscription.findOne(...).lean()  and  Plan.findById(...).lean()
const mockSubscriptionLean = jest.fn<() => Promise<unknown>>();
const mockSubscriptionFindOne = jest.fn(() => ({ lean: () => mockSubscriptionLean() }));
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { findOne: (...a: unknown[]) => mockSubscriptionFindOne(...(a as [])) },
}));

const mockPlanLean = jest.fn<() => Promise<unknown>>();
const mockPlanFindById = jest.fn(() => ({ lean: () => mockPlanLean() }));
jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: { findById: (...a: unknown[]) => mockPlanFindById(...(a as [])) },
}));

const { createUsageRoutes } = await import('../src/routes/usage.js');

const ROLLUP = { period: {}, subscription: null, usage: { plugins: {} }, cost: { subscriptionCents: 0, currency: 'USD' } };

const router = createUsageRoutes();
// requireAuth runs at route-construction (module load) time, so capture its
// args before beforeEach's clearAllMocks wipes the record.
const requireAuthOptsAtLoad = mockRequireAuth.mock.calls.map((c) => c[0]);

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

const activeSub = {
  currentPeriodStart: new Date('2026-05-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
  interval: 'monthly',
  planId: 'plan-pro',
  status: 'active',
};
const planDoc = { name: 'Pro', tier: 'pro', prices: { monthly: 4900, annual: 49000 } };

beforeEach(() => {
  jest.clearAllMocks();
  mockBuildUsageRollupFor.mockResolvedValue(ROLLUP);
  mockSubscriptionLean.mockResolvedValue(activeSub);
  mockPlanLean.mockResolvedValue(planDoc);
});

describe('GET /usage — authorization', () => {
  it('is guarded by requireAuth with allowOrgHeaderOverride', () => {
    expect(requireAuthOptsAtLoad).toContainEqual({ allowOrgHeaderOverride: true });
  });
});

describe('GET /usage — rollup wiring', () => {
  const rawHandler = getHandler('get', '/usage');
  // Real Express requests always carry `req.query`; these minimal unit reqs don't,
  // so default it here (a case can still pass its own `query` to exercise the
  // period-override params). Keeps every call site free of boilerplate.
  const handler = (req: any, res: any) => rawHandler({ query: {}, ...req }, res);

  it('threads the active subscription + plan into the rollup builder and returns it with 200', async () => {
    const res = mockRes();
    await handler({ headers: { authorization: 'Bearer user-tok' }, orgId: 'org-1' }, res);

    expect(mockSubscriptionFindOne).toHaveBeenCalledWith({
      orgId: 'org-1',
      status: { $in: expect.arrayContaining(['active', 'trialing', 'past_due']) },
    });
    expect(mockPlanFindById).toHaveBeenCalledWith('plan-pro');
    expect(mockBuildUsageRollupFor).toHaveBeenCalledWith(
      'org-1',
      'Bearer user-tok',
      {
        currentPeriodStart: activeSub.currentPeriodStart,
        currentPeriodEnd: activeSub.currentPeriodEnd,
        interval: 'monthly',
        planId: 'plan-pro',
      },
      { name: 'Pro', tier: 'pro', prices: { monthly: 4900, annual: 49000 } },
      null, // no period override (no query params)
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const [, status, data] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(200);
    expect(data).toBe(ROLLUP); // serialized verbatim
  });

  it('resolves the real plan for a trialing org (previously null → developer defaults)', async () => {
    // A trialing sub is in the manageable set; the widened lookup now returns it
    // so the rollup reflects the real plan/window instead of the $0 developer
    // fallback the bare status:'active' filter produced.
    mockSubscriptionLean.mockResolvedValue({ ...activeSub, status: 'trialing' });
    const res = mockRes();
    await handler({ headers: { authorization: 'Bearer user-tok' }, orgId: 'org-trial' }, res);

    expect(mockSubscriptionFindOne).toHaveBeenCalledWith({
      orgId: 'org-trial',
      status: { $in: expect.arrayContaining(['active', 'trialing', 'past_due']) },
    });
    expect(mockPlanFindById).toHaveBeenCalledWith('plan-pro');
    const [, , subArg, planArg] = mockBuildUsageRollupFor.mock.calls[0];
    expect(subArg).toMatchObject({ planId: 'plan-pro' });
    expect(planArg).toMatchObject({ tier: 'pro' });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('passes null subscription/plan for a free / unsubscribed org and skips the plan lookup', async () => {
    mockSubscriptionLean.mockResolvedValue(null);
    const res = mockRes();
    await handler({ headers: { authorization: 'Bearer user-tok' }, orgId: 'org-free' }, res);

    expect(mockPlanFindById).not.toHaveBeenCalled();
    expect(mockBuildUsageRollupFor).toHaveBeenCalledWith('org-free', 'Bearer user-tok', null, null, null);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('passes a null plan when the subscription references a missing plan', async () => {
    mockPlanLean.mockResolvedValue(null);
    const res = mockRes();
    await handler({ headers: { authorization: 'Bearer user-tok' }, orgId: 'org-1' }, res);

    const [, , subArg, planArg] = mockBuildUsageRollupFor.mock.calls[0];
    expect(subArg).toMatchObject({ planId: 'plan-pro' });
    expect(planArg).toBeNull();
  });

  it('forwards an empty auth header when the request carries none', async () => {
    const res = mockRes();
    await handler({ headers: {}, orgId: 'org-1' }, res);

    expect(mockBuildUsageRollupFor).toHaveBeenCalledWith('org-1', '', expect.anything(), expect.anything(), null);
  });

  it('threads a caller-supplied period override from periodStart/periodEnd query params', async () => {
    const res = mockRes();
    await handler(
      { headers: { authorization: 'Bearer user-tok' }, orgId: 'org-1', query: { periodStart: '2026-01-01', periodEnd: '2026-02-01' } },
      res,
    );

    const override = mockBuildUsageRollupFor.mock.calls[0][4];
    expect(override).toEqual({ start: new Date('2026-01-01'), end: new Date('2026-02-01') });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects a malformed period date with 400 and never builds the rollup', async () => {
    const res = mockRes();
    await handler(
      { headers: { authorization: 'Bearer user-tok' }, orgId: 'org-1', query: { periodStart: 'not-a-date' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockBuildUsageRollupFor).not.toHaveBeenCalled();
  });
});
