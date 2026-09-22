// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/billing-ledger + routes/billing-summary. Exercises
 * idempotent Stripe-invoice ingestion (incl. usage-credit consumption from the
 * customer balance), the dashboard summary aggregation (gross − credit = net
 * reconciliation), and the paginated invoice list. Models are mocked (no Mongo).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendSuccess = jest.fn<AnyFn>();
const mockSendError = jest.fn<AnyFn>();

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

// Isolate the ledger/route from the heavy billing-helpers + downstream-client chains
// (the allocation route pulls billingServiceAuth/getBillingTimeout + fetchSeatUsage).
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  billingServiceAuth: () => 'Bearer svc',
  getBillingTimeout: () => 5000,
}));
jest.unstable_mockModule('../src/helpers/downstream-client.js', () => ({
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

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (fn: Function) => async (req: any, res: any) => {
    const orgId = req.user?.organizationId || '';
    if (!orgId) return mockSendError(res, 400, 'Organization ID is required', 'MISSING_REQUIRED_FIELD');
    await fn({ req, res, orgId });
  },
  incCounter: jest.fn<AnyFn>(),
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

// A minimal in-memory `$facet`/`$group`/`$project`/`$sort`/`$match` interpreter so
// the summary aggregations (D2) can be unit-tested against the same store without
// a live Mongo. Supports exactly the operators the billing-ledger pipelines use.
function matchRows(filter: any): any[] {
  return [...store.values()]
    .filter((r) => {
      if (filter.orgId !== undefined && r.orgId !== filter.orgId) return false;
      const ps = filter.periodStart;
      if (ps && typeof ps === 'object') {
        const t = (r.periodStart instanceof Date ? r.periodStart : new Date(r.periodStart)).getTime();
        if (ps.$gte && t < new Date(ps.$gte).getTime()) return false;
        if (ps.$lte && t > new Date(ps.$lte).getTime()) return false;
      }
      return true;
    })
    .map((r) => ({ ...r, periodStart: r.periodStart instanceof Date ? r.periodStart : new Date(r.periodStart) }));
}
const evalField = (expr: any, row: any) => (typeof expr === 'string' && expr.startsWith('$') ? row[expr.slice(1)] : expr);
function applyGroup(stage: any, rows: any[]): any[] {
  const groups = new Map<string, any>();
  for (const row of rows) {
    const key = stage._id === null ? '\u0000null' : String(evalField(stage._id, row));
    let acc = groups.get(key);
    if (!acc) {
      acc = { _id: stage._id === null ? null : evalField(stage._id, row) };
      for (const f of Object.keys(stage)) if (f !== '_id') acc[f] = 0;
      groups.set(key, acc);
    }
    for (const [f, spec] of Object.entries<any>(stage)) {
      if (f === '_id') continue;
      const s = spec.$sum;
      acc[f] += typeof s === 'number' ? s : (evalField(s, row) ?? 0);
    }
  }
  return [...groups.values()];
}
function applyProject(stage: any, rows: any[]): any[] {
  return rows.map((row) => {
    const out: any = {};
    for (const [f, spec] of Object.entries<any>(stage)) {
      if (f === '_id') { if (spec) out._id = row._id; continue; }
      out[f] = spec === 1 || spec === true ? row[f] : evalField(spec, row);
    }
    return out;
  });
}
function applySort(spec: any, rows: any[]): any[] {
  const [[field, dir]] = Object.entries<any>(spec);
  return [...rows].sort((a, b) => {
    const an = a[field] instanceof Date ? a[field].getTime() : a[field];
    const bn = b[field] instanceof Date ? b[field].getTime() : b[field];
    const cmp = an < bn ? -1 : an > bn ? 1 : 0;
    return dir === 1 ? cmp : -cmp;
  });
}
function runPipeline(pipeline: any[], rows: any[]): any[] {
  let cur = rows;
  for (const stage of pipeline) {
    if (stage.$match) {cur = matchRows(stage.$match);} else if (stage.$sort) {cur = applySort(stage.$sort, cur);} else if (stage.$group) {cur = applyGroup(stage.$group, cur);} else if (stage.$project) {cur = applyProject(stage.$project, cur);} else if (stage.$facet) {
      const out: any = {};
      for (const [name, sub] of Object.entries<any>(stage.$facet)) out[name] = runPipeline(sub, cur);
      cur = [out];
    }
  }
  return cur;
}
const mockAggregate = jest.fn(async (pipeline: any[]) => runPipeline(pipeline, []));

jest.unstable_mockModule('../src/models/billing-invoice.js', () => ({
  BillingInvoice: {
    updateOne: mockUpdateOne,
    find: mockFind,
    // ingestStripeInvoice reads the existing row (to preserve a prior reversal)
    // before upserting — return the stored row via a lean()-able handle.
    findOne: (filter: any) => ({ lean: async () => store.get(filter.externalInvoiceId) ?? null }),
    // reverseLedgerInvoice flips an already-ingested row's status in place and
    // returns the updated document (`{ new: true }`), or null when absent.
    findOneAndUpdate: async (filter: any, update: any) => {
      const row = store.get(filter.externalInvoiceId);
      if (!row) return null;
      Object.assign(row, update.$set);
      return row;
    },
    aggregate: mockAggregate,
    countDocuments: async (filter: any) => [...store.values()].filter((r) => filter.orgId === undefined || r.orgId === filter.orgId).length,
  },
}));

const { ingestStripeInvoice, recordMarketplaceConsumption, getBillingSummary, getAdminBillingSummary, reverseLedgerInvoice } = await import('../src/helpers/billing-ledger.js');
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

  it('$group totals equal the old row-by-row in-JS sums', async () => {
    // Seed a mix of invoices, then reconcile the aggregation output against the
    // reference sum the removed `.find()`-and-loop implementation would produce.
    await ingestStripeInvoice('org-1', invoice({ id: 'i1' }));
    await ingestStripeInvoice('org-1', invoice({ id: 'i2', subtotal: 1234, tax: 56, total: 1000, amount_paid: 1000, starting_balance: -400, ending_balance: -100 }));
    await ingestStripeInvoice('org-1', invoice({ id: 'i3', subtotal: 7777, tax: 0, total: 7777, amount_paid: 7000, starting_balance: 0, ending_balance: 0 }));
    const rows = [...store.values()].filter((r) => r.orgId === 'org-1');
    const ref = rows.reduce((acc, r) => ({
      grossBilledCents: acc.grossBilledCents + r.subtotalCents,
      discountsCents: acc.discountsCents + r.discountCents,
      creditsCents: acc.creditsCents + r.creditCents,
      taxCents: acc.taxCents + r.taxCents,
      netBilledCents: acc.netBilledCents + r.totalCents,
      amountPaidCents: acc.amountPaidCents + r.amountPaidCents,
    }), { grossBilledCents: 0, discountsCents: 0, creditsCents: 0, taxCents: 0, netBilledCents: 0, amountPaidCents: 0 });

    const summary = await getBillingSummary('org-1');
    expect(summary.totals).toEqual(ref);
    expect(summary.invoiceCount).toBe(rows.length);
    // Timeline is still one projected point per invoice period, sorted ascending.
    expect(summary.timeline).toHaveLength(rows.length);
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

  it('$group grand-totals + per-org breakdown equal the old in-JS sums', async () => {
    await ingestStripeInvoice('org-1', invoice({ id: 'a', subtotal: 4900, total: 2900 }));
    await ingestStripeInvoice('org-1', invoice({ id: 'a2', subtotal: 1000, total: 800, amount_paid: 800, starting_balance: 0, ending_balance: 0 }));
    await ingestStripeInvoice('org-2', invoice({ id: 'b', subtotal: 4900, total: 3900, ending_balance: 0, starting_balance: -1000 }));

    // Reference: the removed find()-and-loop grand totals + per-org fold.
    const all = [...store.values()];
    const grand = all.reduce((a, r) => ({
      grossBilledCents: a.grossBilledCents + r.subtotalCents,
      discountsCents: a.discountsCents + r.discountCents,
      creditsCents: a.creditsCents + r.creditCents,
      taxCents: a.taxCents + r.taxCents,
      netBilledCents: a.netBilledCents + r.totalCents,
      amountPaidCents: a.amountPaidCents + r.amountPaidCents,
    }), { grossBilledCents: 0, discountsCents: 0, creditsCents: 0, taxCents: 0, netBilledCents: 0, amountPaidCents: 0 });

    const admin = await getAdminBillingSummary();
    expect(admin.totals).toEqual(grand);
    expect(admin.invoiceCount).toBe(all.length);
    // org-1 has two invoices summed into one breakdown row.
    const org1 = admin.byOrg.find((o) => o.orgId === 'org-1')!;
    expect(org1.invoiceCount).toBe(2);
    expect(org1.grossBilledCents).toBe(4900 + 1000);
    expect(org1.netBilledCents).toBe(2900 + 800);
    // Sorted by net desc across accounts.
    const nets = admin.byOrg.map((o) => o.netBilledCents);
    expect(nets).toEqual([...nets].sort((x, y) => y - x));
  });
});

describe('reverseLedgerInvoice', () => {
  it('flips an ingested row to the reversal status and returns its orgId', async () => {
    await ingestStripeInvoice('org-1', invoice({ id: 'in_rev' }));
    const orgId = await reverseLedgerInvoice('in_rev', 'refunded', 1200);
    expect(orgId).toBe('org-1');
    expect(store.get('in_rev')).toMatchObject({ status: 'refunded', amountPaidCents: 1200 });
  });

  it('clamps a negative net amount to zero', async () => {
    await ingestStripeInvoice('org-1', invoice({ id: 'in_neg' }));
    await reverseLedgerInvoice('in_neg', 'disputed', -500);
    expect(store.get('in_neg')).toMatchObject({ status: 'disputed', amountPaidCents: 0 });
  });

  it('leaves amountPaidCents alone when no net amount is supplied', async () => {
    await ingestStripeInvoice('org-1', invoice({ id: 'in_keep', amount_paid: 4900 }));
    const before = store.get('in_keep').amountPaidCents;
    await reverseLedgerInvoice('in_keep', 'void');
    expect(store.get('in_keep')).toMatchObject({ status: 'void', amountPaidCents: before });
  });

  it('is a no-op returning null when the invoice was never ingested', async () => {
    expect(await reverseLedgerInvoice('in_missing', 'refunded', 0)).toBeNull();
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
