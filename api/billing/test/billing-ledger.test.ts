// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/billing-ledger + routes/billing-summary (Phase 7). Exercises
 * idempotent Stripe-invoice ingestion (incl. usage-credit consumption from the
 * customer balance), the dashboard summary aggregation (gross − credit = net
 * reconciliation), and the paginated invoice list. Models are mocked (no Mongo).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendSuccess = jest.fn();
const mockSendError = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  requireAuth: (_opts?: any) => (_req: any, _res: any, next: () => void) => next(),
  requirePermission: () => (_req: any, _res: any, next: () => void) => next(),
  requireSystemAdmin: (_req: any, _res: any, next: () => void) => next(),
  requireFeature: () => (_req: any, _res: any, next: () => void) => next(),
  parseQueryString: (v: any) => (typeof v === 'string' ? v : undefined),
  parseQueryInt: (v: any, d: number) => (v === undefined ? d : parseInt(v, 10)),
  parseQueryIntClamped: (v: any, d: number) => (v === undefined ? d : parseInt(v, 10)),
  userHasPermission: () => true,
  fetchOrgDescendants: async () => undefined,
}));

// Isolate the ledger/route from the heavy billing-helpers + quota-client chains
// (the allocation route pulls billingServiceAuth/getBillingTimeout + fetchSeatUsage).
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  billingServiceAuth: () => 'Bearer svc',
  getBillingTimeout: () => 5000,
}));
jest.unstable_mockModule('../src/helpers/quota-client.js', () => ({
  fetchSeatUsage: jest.fn(async () => ({ limit: 10, used: 3 })),
  fetchQuotaSnapshot: jest.fn(async (orgId: string) => ({
    tier: 'team',
    name: `Org ${orgId}`,
    quotas: { pipelines: { used: 3, limit: 5 }, apiCalls: { used: 100, limit: 1000 } },
  })),
}));
// The allocation route imports config for the platform host; mock it so the real
// config.js (which throws without MONGODB_URI) never loads.
jest.unstable_mockModule('../src/config.js', () => ({
  config: { platformService: { host: 'platform', port: 3000 } },
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (fn: Function) => async (req: any, res: any) => {
    const orgId = req.user?.organizationId || '';
    if (!orgId) return mockSendError(res, 400, 'Organization ID is required', 'MISSING_REQUIRED_FIELD');
    await fn({ req, res, orgId });
  },
  incCounter: jest.fn(),
}));

// In-memory BillingInvoice store keyed by externalInvoiceId.
const store = new Map<string, any>();
const mockUpdateOne = jest.fn(async (filter: any, update: any, _opts: any) => {
  // Handle $set (stripe ingest) + $setOnInsert/$inc (marketplace consumption accumulate).
  const key = filter.externalInvoiceId;
  const existing = store.get(key);
  const base = existing ?? { externalInvoiceId: key, ...(update.$setOnInsert ?? {}) };
  const merged: any = { ...base, ...(update.$set ?? {}) };
  for (const [k, v] of Object.entries(update.$inc ?? {})) merged[k] = (merged[k] ?? 0) + (v as number);
  store.set(key, merged);
});
const chain = (rows: any[]) => {
  const c: any = { sort: () => c, skip: () => c, limit: () => Promise.resolve(rows), then: (r: any) => Promise.resolve(rows).then(r) };
  return c;
};
const mockFind = jest.fn((filter: any) => {
  // A filter with no orgId spans every account (admin summary); otherwise scoped.
  let rows = [...store.values()].filter((r) => filter.orgId === undefined || r.orgId === filter.orgId);
  return chain(rows.map((r) => ({
    ...r,
    periodStart: r.periodStart instanceof Date ? r.periodStart : new Date(r.periodStart),
    periodEnd: r.periodEnd instanceof Date ? r.periodEnd : new Date(r.periodEnd),
  })));
});
jest.unstable_mockModule('../src/models/billing-invoice.js', () => ({
  BillingInvoice: {
    updateOne: mockUpdateOne,
    find: mockFind,
    countDocuments: async (filter: any) => [...store.values()].filter((r) => filter.orgId === undefined || r.orgId === filter.orgId).length,
  },
}));

const mockSubFind = jest.fn<(...a: unknown[]) => Promise<any[]>>().mockResolvedValue([]);
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { find: (...a: unknown[]) => mockSubFind(...a) },
}));

const mockListCustomerInvoices = jest.fn<(...a: unknown[]) => Promise<any[]>>().mockResolvedValue([]);
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => ({ listCustomerInvoices: mockListCustomerInvoices }),
}));

const { ingestStripeInvoice, recordMarketplaceConsumption, getBillingSummary, getAdminBillingSummary, backfillLedgerFromProvider } = await import('../src/helpers/billing-ledger.js');
const { createBillingSummaryRoutes } = await import('../src/routes/billing-summary.js');

const invoice = (over: any = {}) => ({
  id: 'in_1',
  subtotal: 4900,
  total: 2900,
  tax: 0,
  amount_paid: 2900,
  starting_balance: -5000,
  ending_balance: -3000,
  currency: 'usd',
  status: 'paid',
  lines: { data: [{ period: { start: 1000, end: 2000 } }] },
  ...over,
});

beforeEach(() => { jest.clearAllMocks(); store.clear(); });

describe('ingestStripeInvoice', () => {
  it('upserts an invoice with credit consumed = balance delta', async () => {
    await ingestStripeInvoice('org-1', invoice());
    const row = store.get('in_1');
    expect(row).toMatchObject({ orgId: 'org-1', source: 'stripe', subtotalCents: 4900, totalCents: 2900 });
    // -3000 − (-5000) = 2000 cents of usage credit applied this invoice.
    expect(row.creditCents).toBe(2000);
    expect(row.status).toBe('paid');
  });

  it('is idempotent — a redelivered invoice updates the same row', async () => {
    await ingestStripeInvoice('org-1', invoice());
    await ingestStripeInvoice('org-1', invoice({ amount_paid: 2900 }));
    expect(store.size).toBe(1);
  });

  it('skips an invoice with no id', async () => {
    await ingestStripeInvoice('org-1', invoice({ id: null }));
    expect(store.size).toBe(0);
  });
});

describe('recordMarketplaceConsumption', () => {
  it('accumulates a period’s metered consumption into ONE marketplace row (net 0)', async () => {
    const start = new Date(Date.UTC(2026, 6, 1)); const end = new Date(Date.UTC(2026, 7, 1));
    await recordMarketplaceConsumption('org-1', '2026-07', start, end, 2000);
    await recordMarketplaceConsumption('org-1', '2026-07', start, end, 500);
    expect(store.size).toBe(1);
    expect(store.get('mp:org-1:2026-07')).toMatchObject({
      orgId: 'org-1', source: 'marketplace', subtotalCents: 2500, creditCents: 2500, totalCents: 0, status: 'paid',
    });
  });

  it('is a no-op for non-positive consumption', async () => {
    await recordMarketplaceConsumption('org-1', '2026-08', new Date(), new Date(), 0);
    expect(store.size).toBe(0);
  });
});

describe('getBillingSummary', () => {
  it('reconciles gross − credit = net across the account', async () => {
    await ingestStripeInvoice('org-1', invoice({ id: 'in_1' }));
    await ingestStripeInvoice('org-1', invoice({ id: 'in_2', subtotal: 4900, ending_balance: 0, starting_balance: -1000, total: 3900 }));
    const summary = await getBillingSummary('org-1');
    expect(summary.scope).toBe('account');
    expect(summary.totals.grossBilledCents).toBe(9800);
    expect(summary.totals.creditsCents).toBe(3000); // 2000 + 1000
    expect(summary.totals.netBilledCents).toBe(6800); // 2900 + 3900
    expect(summary.invoiceCount).toBe(2);
    expect(summary.timeline).toHaveLength(2);
  });

  it('returns zeroed totals for an account with no invoices', async () => {
    const summary = await getBillingSummary('org-empty');
    expect(summary.totals.grossBilledCents).toBe(0);
    expect(summary.invoiceCount).toBe(0);
  });
});

describe('getAdminBillingSummary (cross-account)', () => {
  it('aggregates across all accounts with a per-org breakdown', async () => {
    await ingestStripeInvoice('org-1', invoice({ id: 'a' }));
    await ingestStripeInvoice('org-2', invoice({ id: 'b', subtotal: 4900, total: 3900, ending_balance: 0, starting_balance: -1000 }));
    const admin = await getAdminBillingSummary();
    expect(admin.invoiceCount).toBe(2);
    expect(admin.totals.grossBilledCents).toBe(9800);
    expect(admin.byOrg).toHaveLength(2);
    // Sorted by net desc — org-2 ($39) before org-1 ($29).
    expect(admin.byOrg[0].orgId).toBe('org-2');
  });

  it('narrows to a single account when orgId is given', async () => {
    await ingestStripeInvoice('org-1', invoice({ id: 'a' }));
    await ingestStripeInvoice('org-2', invoice({ id: 'b' }));
    const admin = await getAdminBillingSummary(undefined, undefined, 'org-1');
    expect(admin.byOrg).toHaveLength(1);
    expect(admin.byOrg[0].orgId).toBe('org-1');
  });
});

describe('backfillLedgerFromProvider', () => {
  it('ingests each account customer’s provider invoices', async () => {
    mockSubFind.mockResolvedValue([{ orgId: 'org-1', externalCustomerId: 'cus_1' }]);
    mockListCustomerInvoices.mockResolvedValue([invoice({ id: 'hist_1' }), invoice({ id: 'hist_2' })]);
    const result = await backfillLedgerFromProvider();
    expect(result).toEqual({ accounts: 1, ingested: 2, errors: 0 });
    expect(store.size).toBe(2);
  });

  it('is fail-soft per account (an error on one does not abort the run)', async () => {
    mockSubFind.mockResolvedValue([{ orgId: 'org-1', externalCustomerId: 'cus_1' }]);
    mockListCustomerInvoices.mockRejectedValue(new Error('stripe down'));
    const result = await backfillLedgerFromProvider();
    expect(result).toMatchObject({ accounts: 1, ingested: 0, errors: 1 });
  });
});

describe('routes/billing-summary', () => {
  const router: any = createBillingSummaryRoutes();
  const handler = (path: string) => {
    const layer = router.stack.find((l: any) => l.route?.path === path && l.route?.methods?.get);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };
  const call = (h: Function, over: any = {}) => h({ user: { organizationId: 'org-1' }, query: {}, ...over }, {});

  it('GET /summary returns the aggregated dashboard payload', async () => {
    await ingestStripeInvoice('org-1', invoice());
    await call(handler('/summary'));
    const [, status, body] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(200);
    expect((body as any).totals.grossBilledCents).toBe(4900);
  });

  it('GET /summary rejects a malformed date', async () => {
    await call(handler('/summary'), { query: { from: 'not-a-date' } });
    expect(mockSendError).toHaveBeenCalledWith({}, 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('GET /invoices returns paginated rows', async () => {
    await ingestStripeInvoice('org-1', invoice());
    await call(handler('/invoices'));
    const [, status, body] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(200);
    expect((body as any).invoices).toHaveLength(1);
    expect((body as any).pagination.total).toBe(1);
  });

  it('GET /summary/usage-by-team returns per-team current usage + seats', async () => {
    await call(handler('/summary/usage-by-team'));
    const [, status, body] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(200);
    // No rollup → the caller's own org only, with its own quota usage + seats.
    expect((body as any).teams).toHaveLength(1);
    expect((body as any).teams[0]).toMatchObject({ orgId: 'org-1', seats: 3, usage: { pipelines: 3, apiCalls: 100 } });
  });
});
