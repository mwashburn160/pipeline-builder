// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * routes/billing-summary.ts — the branches billing-ledger.test.ts (which runs
 * the ledger for real) leaves out: date validation on every route, the
 * showback allocation (driver validation, the `reports:rollup`-gated subtree
 * with its fail-soft fallback to the caller's own org, seat reads that fail
 * soft to 0 units), the team-usage rollup and the sysadmin cross-account summary.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const sendSuccess = jest.fn<AnyFn>();
const sendError = jest.fn<AnyFn>();
const pass = (_req: unknown, _res: unknown, next: () => void) => next();
let canRollup = true;
const fetchOrgDescendants = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess,
  sendError,
  requireAuth: () => pass,
  requirePermission: () => pass,
  requireSystemAdmin: pass,
  requireFeature: () => pass,
  parseQueryString: (v: unknown) => (typeof v === 'string' ? v : undefined),
  parseQueryInt: (v: unknown, d: number) => (v === undefined ? d : parseInt(String(v), 10)),
  parseQueryIntClamped: (v: unknown, d: number, max: number) => (v === undefined ? d : Math.min(parseInt(String(v), 10), max)),
  userHasPermission: (_req: unknown, perm: string) => perm === 'reports:rollup' && canRollup,
  fetchOrgDescendants,
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (fn: AnyFn) => async (req: { orgId: string }, res: unknown) => fn({ req, res, orgId: req.orgId }),
}));
jest.unstable_mockModule('../src/config.js', () => ({ config: { platformService: { host: 'platform', port: 3000 } } }));
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({ billingServiceAuth: (id: string) => `Bearer svc-${id}`, getBillingTimeout: () => 5000 }));

const totals = { grossBilledCents: 1000, discountsCents: 0, creditsCents: 0, taxCents: 0, netBilledCents: 1000 };
const getBillingSummary = jest.fn<AnyFn>(async () => ({ totals, timeline: [] }));
const listBillingInvoices = jest.fn<AnyFn>(async () => ({ invoices: [], pagination: { total: 0 } }));
const getAdminBillingSummary = jest.fn<AnyFn>(async () => ({ accounts: [] }));
jest.unstable_mockModule('../src/helpers/billing-ledger.js', () => ({ getBillingSummary, listBillingInvoices, getAdminBillingSummary }));

const fetchSeatUsage = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/quota-client.js', () => ({ fetchSeatUsage }));
const getTeamUsage = jest.fn<AnyFn>(async (ids: string[]) => ids.map((orgId) => ({ orgId })));
jest.unstable_mockModule('../src/helpers/team-usage.js', () => ({ getTeamUsage }));

const { createBillingSummaryRoutes } = await import('../src/routes/billing-summary.js');

const router = createBillingSummaryRoutes() as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: AnyFn }> } }> };
const handler = (path: string) => {
  const layer = router.stack.find((l) => l.route?.path === path)!;
  return layer.route!.stack.at(-1)!.handle;
};
const call = (path: string, query: Record<string, string> = {}) => handler(path)({ orgId: 'root', query }, {});
const body = () => sendSuccess.mock.calls[0]![2] as Record<string, any>;

beforeEach(() => {
  jest.clearAllMocks();
  canRollup = true;
  fetchOrgDescendants.mockResolvedValue(['root', 'team-a', 'team-b']);
  fetchSeatUsage.mockImplementation(async (id: string) => ({ 'root': { used: 2 }, 'team-a': { used: 6 }, 'team-b': null }[id]));
});

describe('date validation', () => {
  it.each(['/summary', '/invoices', '/summary/allocation', '/admin/summary'])('%s 400s a malformed from/to', async (path) => {
    await call(path, { to: 'yesterday-ish' });
    expect(sendError).toHaveBeenCalledWith({}, 400, 'from/to must be ISO dates', 'VALIDATION_ERROR');
    expect(sendSuccess).not.toHaveBeenCalled();
  });

  it('/invoices clamps the page size and threads the range', async () => {
    await call('/invoices', { from: '2026-01-01', to: '2026-02-01', limit: '999', offset: '20' });
    expect(listBillingInvoices).toHaveBeenCalledWith('root', new Date('2026-01-01'), new Date('2026-02-01'), 200, 20);
  });
});

describe('GET /summary/allocation (showback)', () => {
  it('refuses any driver but seats', async () => {
    await call('/summary/allocation', { driver: 'pipelines' });
    expect(sendError).toHaveBeenCalledWith({}, 400, 'Unsupported allocation driver "pipelines"', 'VALIDATION_ERROR');
  });

  it('allocates the caller\'s own org only without a rollup request', async () => {
    await call('/summary/allocation');
    expect(fetchOrgDescendants).not.toHaveBeenCalled();
    expect(body()).toMatchObject({ estimated: true });
    expect(fetchSeatUsage).toHaveBeenCalledTimes(1);
  });

  it('rolls up over the subtree for a reports:rollup holder, a failed seat read counting 0 units', async () => {
    await call('/summary/allocation', { includeDescendants: 'true' });
    expect(fetchOrgDescendants).toHaveBeenCalledWith('root', expect.objectContaining({ serviceName: 'billing', headers: { 'x-org-id': 'root' } }));
    expect(fetchSeatUsage).toHaveBeenCalledWith('team-b', 'Bearer svc-team-b');
    const rows = body().rows as Array<{ orgId: string; driverUnits: number; grossCents: number }>;
    expect(rows.map((r) => [r.orgId, r.driverUnits])).toEqual([['root', 2], ['team-a', 6], ['team-b', 0]]);
    expect(rows.reduce((sum, r) => sum + r.grossCents, 0)).toBe(1000);
  });

  it('ignores includeDescendants without reports:rollup', async () => {
    canRollup = false;
    await call('/summary/allocation', { includeDescendants: 'true' });
    expect(fetchOrgDescendants).not.toHaveBeenCalled();
  });

  it.each([
    ['the descendant read fails', () => fetchOrgDescendants.mockRejectedValue(new Error('platform down'))],
    ['platform returns no descendants', () => fetchOrgDescendants.mockResolvedValue([])],
  ])('falls back to the caller\'s own org when %s', async (_label, arrange) => {
    arrange();
    await call('/summary/allocation', { includeDescendants: 'true' });
    expect(fetchSeatUsage).toHaveBeenCalledTimes(1);
    expect(fetchSeatUsage).toHaveBeenCalledWith('root', 'Bearer svc-root');
  });
});

describe('GET /summary/usage-by-team', () => {
  it('returns usage for the whole subtree on a rollup', async () => {
    await call('/summary/usage-by-team', { includeDescendants: 'true' });
    expect(getTeamUsage).toHaveBeenCalledWith(['root', 'team-a', 'team-b']);
    expect(body().teams).toHaveLength(3);
  });
});

describe('GET /admin/summary', () => {
  it('narrows to one account with ?orgId=, else aggregates all', async () => {
    await call('/admin/summary', { orgId: 'acct-9', from: '2026-01-01' });
    expect(getAdminBillingSummary).toHaveBeenCalledWith(new Date('2026-01-01'), undefined, 'acct-9');
    await call('/admin/summary');
    expect(getAdminBillingSummary).toHaveBeenLastCalledWith(undefined, undefined, undefined);
  });
});
