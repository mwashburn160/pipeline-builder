// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The offer SURFACES (docs/plans/sales-agent.md F4, F8).
 *
 * The assertions here are the ones a typecheck cannot make:
 *
 *  - a manual trigger is RECORDED as manual. "Mixing them silently corrupts the
 *    only measurement that matters", and an earlier version of this passed
 *    `'agent'` while its own doc comment claimed otherwise — a defect no test or
 *    typecheck would ever have caught, and one that quietly poisons the lift
 *    number rather than breaking anything;
 *  - the trigger does NOT force an offer: it runs the same decision the cycle
 *    runs and reports the refusal;
 *  - declining and dismissing hit different writes on the SAME account's rows;
 *  - an exclusion needs a reason, because a bare list of org ids cannot tell an
 *    expired negotiation from a permanent one.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Before any import of `src/config.js`, which throws without it when billing is
// enabled — and the enabled shape is the only one that serves these routes.
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-offers-routes';

const mockSendSuccess = jest.fn();
const mockSendError = jest.fn();
const mockSendBadRequest = jest.fn();
const mockAuditRecord = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockAuditRecord,
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  sendBadRequest: mockSendBadRequest,
  requireAuth: (_opts?: unknown) => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSystemOrgPermission: () => [(_req: unknown, _res: unknown, next: () => void) => next()],
  getParam: (params: Record<string, string>, key: string) => params[key],
  actorId: (a: { userId?: string }) => a.userId ?? 'anon',
  parsePage: () => ({ limit: 50, offset: 0 }),
  OFFERS_AGENT_ACTOR_ID: 'offers-agent',
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (routeFn: (c: unknown) => Promise<unknown>) => async (req: { user?: { sub?: string; organizationId?: string } }, res: unknown) =>
    routeFn({ req, res, ctx: { log: jest.fn() }, orgId: req.user?.organizationId || '', userId: req.user?.sub || '' }),
}));

const mockRunForAccount = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/helpers/offers-run.js', () => ({
  runForAccount: mockRunForAccount,
}));

jest.unstable_mockModule('../src/helpers/offers-outcome.js', () => ({
  measureLift: async () => ({
    offered: { accounts: 10, sent: 10, conversions: 2, conversionRate: 0.2 },
    holdout: { accounts: 2, sent: 0, conversions: 0, conversionRate: 0 },
    lift: 0.2,
    skuMatch: {},
    timeToConversion: {},
  }),
}));

jest.unstable_mockModule('../src/helpers/root-org-guard.js', () => ({
  refuseTeamBilling: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockOfferUpdate = jest.fn<(...a: unknown[]) => unknown>();
const mockOfferFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUpdateMany = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/models/offer.js', () => ({
  Offer: {
    findOneAndUpdate: mockOfferUpdate,
    findOne: mockOfferFindOne,
    updateMany: mockUpdateMany,
    find: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) }),
    countDocuments: async () => 0,
    aggregate: async () => [],
  },
}));

// Promise-returning, or `mockResolvedValue` infers `never` and only
// `typecheck:tests` says so.
const mockExclusionUpsert = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockExclusionDelete = jest.fn<(...a: unknown[]) => unknown>();
jest.unstable_mockModule('../src/models/offer-exclusion.js', () => ({
  OfferExclusion: {
    find: () => ({ sort: () => ({ lean: async () => [] }) }),
    findOneAndUpdate: mockExclusionUpsert,
    findOneAndDelete: mockExclusionDelete,
  },
}));

jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { findOne: () => ({ lean: async () => ({ orgId: 'acct-1', planId: 'pro', interval: 'monthly', addons: [] }) }) },
}));

const { createOfferRoutes } = await import('../src/routes/offers.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
const router: any = createOfferRoutes();
function handler(method: string, routePath: string) {
  const layer = router.stack.find((l: any) => l.route?.path === routePath && l.route?.methods?.[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
const call = (h: Function, req: any) => h({ ...req, params: req.params || {}, query: req.query || {}, user: req.user || { sub: 'u-1', organizationId: 'acct-1' } }, {});
/* eslint-enable @typescript-eslint/no-explicit-any */

const OPEN_OFFER = {
  _id: { toString: () => 'offer-1' },
  orgId: 'acct-1',
  offerType: 'pack',
  targetBundles: [],
  rationale: ['sustained_pressure'],
  status: 'sent',
  subject: 's',
  body: 'b',
  sentAt: new Date('2026-11-01T00:00:00Z'),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockOfferUpdate.mockReturnValue({ lean: async () => ({ ...OPEN_OFFER }) });
  mockOfferFindOne.mockReturnValue({ sort: () => ({ lean: async () => null }) });
  mockUpdateMany.mockResolvedValue({ modifiedCount: 3 });
});

describe('the D14 recall', () => {
  it('withdraws the AGENT\'s unanswered offers in the window by default', async () => {
    await call(handler('post', '/admin/offers/withdraw'), { body: { sinceMinutes: 60 } });
    const [filter, update] = mockUpdateMany.mock.calls[0] as [Record<string, unknown>, Record<string, Record<string, unknown>>];
    expect(filter).toMatchObject({ actorId: 'offers-agent', status: 'sent' });
    expect(update.$set).toMatchObject({ status: 'withdrawn' });
    // `sentAt` is deliberately untouched: an operator's mistake must not become
    // a licence to contact the account again immediately.
    expect(update.$set).not.toHaveProperty('sentAt');
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 200, { withdrawn: 3, actor: 'offers-agent', sinceMinutes: 60 });
  });

  it('touches only UNANSWERED offers — a purchase is not ours to unwind', async () => {
    await call(handler('post', '/admin/offers/withdraw'), { body: { sinceMinutes: 60 } });
    const [filter] = mockUpdateMany.mock.calls[0] as [Record<string, unknown>];
    expect(filter.status).toBe('sent');
  });

  it('bounds the window, so a recall cannot rewrite months of outcome history', async () => {
    await call(handler('post', '/admin/offers/withdraw'), { body: { sinceMinutes: 7 * 24 * 60 + 1 } });
    expect(mockSendBadRequest).toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('requires a window at all', async () => {
    for (const body of [{}, { sinceMinutes: 0 }, { sinceMinutes: -5 }, { sinceMinutes: 'all' }]) {
      mockSendBadRequest.mockClear();
      mockUpdateMany.mockClear();
      await call(handler('post', '/admin/offers/withdraw'), { body });
      expect(mockSendBadRequest).toHaveBeenCalled();
      expect(mockUpdateMany).not.toHaveBeenCalled();
    }
  });

  it('can recall a NAMED actor instead of the agent', async () => {
    await call(handler('post', '/admin/offers/withdraw'), { body: { sinceMinutes: 30, actor: 'user-42' } });
    const [filter] = mockUpdateMany.mock.calls[0] as [Record<string, unknown>];
    expect(filter.actorId).toBe('user-42');
  });

  it('audits the recall by WINDOW and actor, under the operator who did it', async () => {
    await call(handler('post', '/admin/offers/withdraw'), { body: { sinceMinutes: 60 } });
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({
      action: 'billing.offer.withdrawn',
      actorId: 'u-1',
      details: { recalledActor: 'offers-agent', sinceMinutes: 60, withdrawn: 3 },
    }));
  });

  it('reports zero rather than failing when the window is empty', async () => {
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    await call(handler('post', '/admin/offers/withdraw'), { body: { sinceMinutes: 5 } });
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 200, expect.objectContaining({ withdrawn: 0 }));
  });
});

describe('the manual trigger', () => {
  it('records the decision as MANUAL, never as the agent\'s', async () => {
    mockRunForAccount.mockResolvedValue({
      decision: { orgId: 'acct-1', chosen: { offerType: 'pack', rationale: [] }, status: 'sent', holdout: false },
      recorded: true,
      delivered: true,
    });
    await call(handler('post', '/admin/offers/trigger/:orgId'), { params: { orgId: 'acct-1' } });
    expect(mockRunForAccount).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'acct-1' }),
      expect.any(Date),
      'manual',
      // …and attributed to the operator who asked, not to the agent (D14).
      'u-1',
    );
  });

  it('reports a SUPPRESSION as the answer rather than forcing an offer', async () => {
    mockRunForAccount.mockResolvedValue({
      decision: { orgId: 'acct-1', chosen: null, status: 'suppressed', reason: 'quiet_period', holdout: false },
      recorded: true,
    });
    await call(handler('post', '/admin/offers/trigger/:orgId'), { params: { orgId: 'acct-1' } });
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 200, expect.objectContaining({
      decision: expect.objectContaining({ status: 'suppressed', reason: 'quiet_period' }),
    }));
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({
      action: 'billing.offer.trigger',
      details: expect.objectContaining({ status: 'suppressed', reason: 'quiet_period' }),
    }));
  });

  it('distinguishes "could not be evaluated" from "refused"', async () => {
    // No plan, no profile: deliberately NOT a suppression, which would mean the
    // rules had considered it and inflate the metric that says they are too tight.
    mockRunForAccount.mockResolvedValue(null);
    await call(handler('post', '/admin/offers/trigger/:orgId'), { params: { orgId: 'acct-1' } });
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 200, { decision: null });
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ status: 'not_evaluated' }),
    }));
  });
});

describe('decline and dismiss are different writes', () => {
  it('decline resolves the offer and records the reason', async () => {
    await call(handler('post', '/offers/:id/decline'), { params: { id: 'offer-1' }, body: { reason: 'too expensive' } });
    const [filter, update] = mockOfferUpdate.mock.calls[0] as [Record<string, unknown>, Record<string, Record<string, unknown>>];
    // Scoped to the caller's own account AND to a still-OPEN offer: declining a
    // redeemed one would rewrite a conversion as a refusal.
    expect(filter).toMatchObject({ _id: 'offer-1', orgId: 'acct-1', status: 'sent' });
    expect(update.$set).toMatchObject({ status: 'declined', declineReason: 'too expensive' });
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.offer.declined' }));
  });

  it('dismiss hides it WITHOUT resolving it', async () => {
    await call(handler('post', '/offers/:id/dismiss'), { params: { id: 'offer-1' } });
    const [, update] = mockOfferUpdate.mock.calls[0] as [unknown, Record<string, Record<string, unknown>>];
    expect(Object.keys(update.$set!)).toEqual(['dismissedAt']);
    expect(update.$set).not.toHaveProperty('status');
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.offer.dismissed' }));
  });

  it('declining accepts no reason at all — requiring one would push accounts to dismiss instead', async () => {
    await call(handler('post', '/offers/:id/decline'), { params: { id: 'offer-1' }, body: {} });
    const [, update] = mockOfferUpdate.mock.calls[0] as [unknown, Record<string, Record<string, unknown>>];
    expect(update.$set).not.toHaveProperty('declineReason');
  });

  it('404s rather than creating anything when the offer is not open', async () => {
    mockOfferUpdate.mockReturnValue({ lean: async () => null });
    await call(handler('post', '/offers/:id/decline'), { params: { id: 'gone' }, body: {} });
    expect(mockSendError).toHaveBeenCalledWith({}, 404, expect.any(String), 'NOT_FOUND');
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });
});

describe('the account\'s own read', () => {
  it('answers offer: null rather than 404 — no offer is the NORMAL state', async () => {
    await call(handler('get', '/offers'), {});
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 200, expect.objectContaining({ offer: null }));
    expect(mockSendError).not.toHaveBeenCalled();
  });

  it('reports no quiet period when nothing is holding the account back', async () => {
    await call(handler('get', '/offers'), {});
    const body = mockSendSuccess.mock.calls[0]![2] as { quietUntil: unknown };
    expect(body.quietUntil).toBeNull();
  });
});

describe('the do-not-offer veto', () => {
  it('refuses an exclusion with no reason', async () => {
    await call(handler('put', '/admin/offers/exclusions/:orgId'), { params: { orgId: 'acct-9' }, body: {} });
    expect(mockSendBadRequest).toHaveBeenCalled();
    expect(mockExclusionUpsert).not.toHaveBeenCalled();
  });

  it('records who vetoed and why', async () => {
    mockExclusionUpsert.mockResolvedValue({});
    await call(handler('put', '/admin/offers/exclusions/:orgId'), {
      params: { orgId: 'acct-9' }, body: { reason: 'in contract negotiation' },
    });
    expect(mockExclusionUpsert).toHaveBeenCalledWith(
      { orgId: 'acct-9' },
      { $set: { reason: 'in contract negotiation', actorId: 'u-1' } },
      { upsert: true },
    );
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({
      action: 'billing.offer.exclusion.set',
      affectedOrgId: 'acct-9',
    }));
  });

  it('404s when lifting a veto that is not there, rather than reporting success', async () => {
    mockExclusionDelete.mockReturnValue({ lean: async () => null });
    await call(handler('delete', '/admin/offers/exclusions/:orgId'), { params: { orgId: 'acct-9' } });
    expect(mockSendError).toHaveBeenCalledWith({}, 404, expect.any(String), 'NOT_FOUND');
  });
});
