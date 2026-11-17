// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Handler bodies of routes/campaigns — system-org only, but a campaign sets how
 * much the business may give away, so the money rules are pinned here:
 *  - create never overwrites (a same-slug POST would re-budget a running campaign);
 *  - an inverted window is refused on create AND on edit (edit used to skip it);
 *  - a budget cannot be lowered below what is already committed;
 *  - end deactivates every code in the campaign, and every write is audited.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendSuccess = jest.fn();
const mockSendError = jest.fn();
const mockSendBadRequest = jest.fn();
const mockRecordAudit = jest.fn();
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockRecordAudit,
  sendSuccess: mockSendSuccess,
  // The list route answers through the shared paginated envelope; recorded on
  // `mockSendSuccess` so the list assertions read the body the client receives.
  sendPaginatedNested: (res: unknown, key: string, data: unknown[], o: { total: number; limit: number; offset: number }) =>
    mockSendSuccess(res, 200, { [key]: data, pagination: { ...o, hasMore: o.offset + data.length < o.total } }),
  sendError: mockSendError,
  sendBadRequest: mockSendBadRequest,
  requireAuth: () => passThrough,
  requireSystemOrgPermission: () => [passThrough],
  getParam: (params: Record<string, string>, key: string) => params[key],
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (routeFn: (c: unknown) => Promise<unknown>) => async (req: { user?: { sub?: string; organizationId?: string } }, res: unknown) =>
    routeFn({ req, res, ctx: { log: jest.fn() }, orgId: req.user?.organizationId || '', userId: req.user?.sub || '' }),
}));

let discountsOn = true;
jest.unstable_mockModule('../src/helpers/discount-helpers.js', () => ({ discountsEnabled: () => discountsOn }));

const mockEndCampaign = jest.fn<(id: string) => Promise<number>>();
const mockLedgerSpend = jest.fn<(id: string) => Promise<unknown>>();
jest.unstable_mockModule('../src/helpers/campaign.js', () => ({
  normalizeCampaignId: (raw: string) => raw.trim().toLowerCase(),
  endCampaign: mockEndCampaign,
  aggregateCampaignLedgerSpend: mockLedgerSpend,
}));

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const store = new Map<string, Row>();
const mockCreate = jest.fn(async (doc: Row) => { const row = { ...doc, createdAt: new Date(), updatedAt: new Date() }; store.set(doc._id, row); return row; });
const mockFindByIdAndUpdate = jest.fn(async (id: string, u: { $set?: Row; $unset?: Row }, _opts?: unknown) => {
  const row = store.get(id);
  if (!row) return null;
  Object.assign(row, u.$set ?? {});
  for (const k of Object.keys(u.$unset ?? {})) delete row[k];
  return row;
});
let listed: Row[] = [];
const mockFind = jest.fn((_filter: unknown) => ({ sort: () => ({ skip: () => ({ limit: async () => listed }) }) }));
jest.unstable_mockModule('../src/models/campaign.js', () => ({
  Campaign: {
    create: mockCreate,
    exists: async (q: { _id: string }) => (store.has(q._id) ? { _id: q._id } : null),
    findById: async (id: string) => store.get(id) ?? null,
    findByIdAndUpdate: mockFindByIdAndUpdate,
    find: mockFind,
    countDocuments: jest.fn(async () => listed.length),
  },
}));
const mockDiscountCount = jest.fn<(q: Record<string, unknown>) => Promise<number>>();
jest.unstable_mockModule('../src/models/discount.js', () => ({ Discount: { countDocuments: mockDiscountCount } }));

const { createCampaignRoutes } = await import('../src/routes/campaigns.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
const router: any = createCampaignRoutes();
function handler(method: string, routePath: string) {
  const layer = router.stack.find((l: any) => l.route?.path === routePath && l.route?.methods?.[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
const call = (h: Function, req: any = {}) =>
  h({ params: {}, query: {}, body: {}, user: { sub: 'staff-1', organizationId: 'system' }, ...req }, {});
/* eslint-enable @typescript-eslint/no-explicit-any */

const seed = (over: Row = {}) => {
  const row = { _id: 'summer26', name: 'Summer', budgetCents: 10_000, spentCents: 2_500, grantsCount: 5, exclusive: false, isActive: true, createdAt: new Date(), updatedAt: new Date(), ...over };
  store.set(row._id, row);
  return row;
};

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  listed = [];
  discountsOn = true;
});

describe('feature flag', () => {
  it('404s the whole campaign surface when discounts are off', () => {
    discountsOn = false;
    const gate = router.stack.find((l: { route?: unknown; handle: Function }) => !l.route).handle;
    const next = jest.fn();
    gate({}, {}, next);
    expect(mockSendError).toHaveBeenCalledWith({}, 404, 'Discounts are not enabled', 'NOT_FOUND');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('POST /admin/campaigns', () => {
  it('creates with a normalised slug id, zero spend, and an audit row', async () => {
    await call(handler('post', '/admin/campaigns'), { body: { id: 'Summer26', name: 'Summer', budgetCents: 10_000, exclusive: true } });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ _id: 'summer26', spentCents: 0, grantsCount: 0, isActive: true, createdBy: 'staff-1' }));
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'billing.campaign.create', targetId: 'summer26', details: { campaign: 'summer26', budgetCents: 10_000, exclusive: true },
    }));
    const [, status, body] = mockSendSuccess.mock.calls[0] as [unknown, number, { campaign: Row }];
    expect(status).toBe(201);
    expect(body.campaign).toMatchObject({ id: 'summer26', remainingCents: 10_000, open: true, budgetExhausted: false });
  });

  it('never overwrites an existing campaign (409)', async () => {
    seed();
    await call(handler('post', '/admin/campaigns'), { body: { id: 'SUMMER26', name: 'Again', budgetCents: 99 } });
    expect(mockSendError).toHaveBeenCalledWith({}, 409, "Campaign 'summer26' already exists", 'DUPLICATE_ENTRY');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses an inverted window', async () => {
    await call(handler('post', '/admin/campaigns'), { body: { id: 'x', name: 'X', startsAt: '2026-12-01T00:00:00Z', endsAt: '2026-11-01T00:00:00Z' } });
    expect(mockSendBadRequest).toHaveBeenCalledWith({}, 'startsAt must be before endsAt', 'VALIDATION_ERROR');
  });

  it.each([
    [{ name: 'no id' }],
    [{ id: 'x', name: 'X', budgetCents: 0 }],
    [{ id: 'x', name: 'X', budgetCents: 1.5 }],
  ])('rejects an invalid body %p', async (body) => {
    await call(handler('post', '/admin/campaigns'), { body });
    expect(mockSendBadRequest).toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('GET /admin/campaigns', () => {
  it('lists with pagination and an active filter', async () => {
    listed = [seed(), seed({ _id: 'old', isActive: false })];
    await call(handler('get', '/admin/campaigns'), { query: { active: 'true', limit: '10' } });
    expect(mockFind).toHaveBeenCalledWith({ isActive: true });
    const [, , body] = mockSendSuccess.mock.calls[0] as [unknown, number, { campaigns: Row[]; pagination: Row }];
    expect(body.campaigns).toHaveLength(2);
    expect(body.pagination).toMatchObject({ total: 2, limit: 10, offset: 0 });
  });

  it('derives budgetExhausted / open from the numbers', async () => {
    listed = [seed({ spentCents: 10_000 })];
    await call(handler('get', '/admin/campaigns'), { query: { active: 'false' } });
    expect(mockFind).toHaveBeenCalledWith({ isActive: false });
    const [, , body] = mockSendSuccess.mock.calls[0] as [unknown, number, { campaigns: Row[] }];
    expect(body.campaigns[0]).toMatchObject({ remainingCents: 0, budgetExhausted: true, open: false });
  });
});

describe('GET /admin/campaigns/:id', () => {
  it('returns the campaign with its code counts and the LEDGER spend', async () => {
    seed();
    mockLedgerSpend.mockResolvedValue({ cents: 2_400, grants: 5 });
    mockDiscountCount.mockResolvedValueOnce(4).mockResolvedValueOnce(3);
    await call(handler('get', '/admin/campaigns/:id'), { params: { id: 'SUMMER26' } });
    const [, , body] = mockSendSuccess.mock.calls[0] as [unknown, number, Row];
    expect(body.codes).toEqual({ total: 4, active: 3 });
    expect(body.ledgerSpend).toEqual({ cents: 2_400, grants: 5 });
  });

  it('404s an unknown campaign', async () => {
    await call(handler('get', '/admin/campaigns/:id'), { params: { id: 'nope' } });
    expect(mockSendError).toHaveBeenCalledWith({}, 404, 'Campaign not found', 'NOT_FOUND');
  });
});

describe('PUT /admin/campaigns/:id', () => {
  const put = (body: Row, id = 'summer26') => call(handler('put', '/admin/campaigns/:id'), { params: { id }, body });

  it('updates only the provided fields and audits them', async () => {
    seed();
    await put({ name: 'Summer sale', exclusive: true });
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith('summer26', { $set: { name: 'Summer sale', exclusive: true } }, { new: true });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.campaign.update', details: { campaign: 'summer26', name: 'Summer sale', exclusive: true } }));
  });

  it('400s an empty edit', async () => {
    await put({});
    expect(mockSendError).toHaveBeenCalledWith({}, 400, 'No updatable fields provided', 'VALIDATION_ERROR');
  });

  it('refuses a budget below what is already committed', async () => {
    seed({ spentCents: 2_500 });
    await put({ budgetCents: 2_000 });
    expect(mockSendBadRequest).toHaveBeenCalledWith({}, 'Budget cannot be set below the 2500c already committed', 'VALIDATION_ERROR');
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('allows a budget exactly at the committed spend', async () => {
    seed({ spentCents: 2_500 });
    await put({ budgetCents: 2_500 });
    expect(mockFindByIdAndUpdate).toHaveBeenCalled();
  });

  it('refuses an edit that INVERTS the stored window (regression: edit skipped the create rule)', async () => {
    seed({ startsAt: new Date('2026-12-01T00:00:00Z') });
    await put({ endsAt: '2026-11-01T00:00:00Z' });
    expect(mockSendBadRequest).toHaveBeenCalledWith({}, 'startsAt must be before endsAt', 'VALIDATION_ERROR');
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('404s a budget or window edit of an unknown campaign', async () => {
    await put({ budgetCents: 5 }, 'ghost');
    expect(mockSendError).toHaveBeenCalledWith({}, 404, 'Campaign not found', 'NOT_FOUND');
  });

  it('CLEARS budget, start and end with null ($unset) and audits them as null', async () => {
    seed({ budgetCents: 5_000, spentCents: 4_000, startsAt: new Date('2026-12-01T00:00:00Z'), endsAt: new Date('2027-01-01T00:00:00Z') });
    await put({ budgetCents: null, startsAt: null, endsAt: null });
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      'summer26', { $unset: { budgetCents: '', startsAt: '', endsAt: '' } }, { new: true },
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'billing.campaign.update',
      details: { campaign: 'summer26', budgetCents: null, startsAt: null, endsAt: null },
    }));
    // The answer describes the cleared campaign: unlimited and open-ended.
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 200, {
      campaign: expect.objectContaining({
        budgetCents: undefined, remainingCents: null, startsAt: undefined, endsAt: undefined, budgetExhausted: false,
      }),
    });
  });

  it('sets and clears in one edit; a cleared start cannot invert the window', async () => {
    seed({ startsAt: new Date('2026-12-01T00:00:00Z') });
    await put({ startsAt: null, endsAt: '2026-11-01T00:00:00Z', name: 'Renamed' });
    expect(mockSendBadRequest).not.toHaveBeenCalled();
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      'summer26',
      { $set: { name: 'Renamed', endsAt: new Date('2026-11-01T00:00:00Z') }, $unset: { startsAt: '' } },
      { new: true },
    );
  });

  it('a clear alone needs no read of the stored campaign (nothing to check against)', async () => {
    seed();
    await put({ budgetCents: null });
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith('summer26', { $unset: { budgetCents: '' } }, { new: true });
  });

  it('404s a plain edit when the row vanished', async () => {
    await put({ name: 'x' }, 'ghost');
    expect(mockSendError).toHaveBeenCalledWith({}, 404, 'Campaign not found', 'NOT_FOUND');
  });
});

describe('POST /admin/campaigns/:id/end', () => {
  it('ends the campaign and every code in it, audited with the count', async () => {
    seed();
    mockEndCampaign.mockResolvedValue(7);
    await call(handler('post', '/admin/campaigns/:id/end'), { params: { id: 'Summer26' } });
    expect(mockEndCampaign).toHaveBeenCalledWith('summer26');
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.campaign.end', details: { campaign: 'summer26', discountsDeactivated: 7 } }));
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 200, { campaign: 'summer26', discountsDeactivated: 7 }, 'Campaign ended');
  });

  it('404s an unknown campaign without touching any code', async () => {
    await call(handler('post', '/admin/campaigns/:id/end'), { params: { id: 'ghost' } });
    expect(mockSendError).toHaveBeenCalledWith({}, 404, 'Campaign not found', 'NOT_FOUND');
    expect(mockEndCampaign).not.toHaveBeenCalled();
  });
});
