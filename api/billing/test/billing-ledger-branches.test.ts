// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * helpers/billing-ledger.ts — the branches billing-ledger.test.ts (an in-memory
 * aggregation emulator over realistic invoices) doesn't reach: every Stripe
 * status mapping, sparse invoices (no id / period / amounts), the refund and
 * dispute PRESERVATION on re-ingest, reversal without an amount or a row, the
 * Marketplace consumption row, and the window / empty-aggregate shapes of both
 * summaries. Asserted on the exact Mongo writes and pipelines.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
const incCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter }));

const existing = jest.fn<AnyFn>(async () => null);
const BillingInvoice = {
  findOne: jest.fn<AnyFn>(() => ({ lean: existing })),
  findOneAndUpdate: jest.fn<AnyFn>(),
  updateOne: jest.fn<AnyFn>(async () => ({ acknowledged: true })),
  aggregate: jest.fn<AnyFn>(),
  find: jest.fn<AnyFn>(),
  countDocuments: jest.fn<AnyFn>(),
};
jest.unstable_mockModule('../src/models/billing-invoice.js', () => ({ BillingInvoice }));

const ledger = await import('../src/helpers/billing-ledger.js');

/** The `$set` of the last ingest upsert. */
const lastSet = () => (BillingInvoice.updateOne.mock.calls.at(-1)![1] as { $set: Record<string, unknown> }).$set;

beforeEach(() => {
  jest.clearAllMocks();
  existing.mockResolvedValue(null);
});

describe('ingestStripeInvoice', () => {
  it('ignores an invoice without an id', async () => {
    await ledger.ingestStripeInvoice('org_1', {} as any);
    expect(BillingInvoice.updateOne).not.toHaveBeenCalled();
  });

  it.each([
    ['paid', 'paid'],
    ['void', 'void'],
    ['uncollectible', 'uncollectible'],
    ['draft', 'open'],
    [undefined, 'open'],
  ])('maps Stripe status %s to ledger status %s', async (status, expected) => {
    await ledger.ingestStripeInvoice('org_1', { id: 'in_1', status } as any);
    expect(lastSet().status).toBe(expected);
  });

  it('defaults every missing amount to 0, the currency to usd and the period to now', async () => {
    const before = Date.now();
    await ledger.ingestStripeInvoice('org_1', { id: 'in_2', lines: { data: [{ period: null }] } } as any);
    const set = lastSet();
    expect(set).toMatchObject({ subtotalCents: 0, discountCents: 0, creditCents: 0, taxCents: 0, totalCents: 0, amountPaidCents: 0, currency: 'usd' });
    expect((set.periodStart as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(BillingInvoice.updateOne).toHaveBeenCalledWith({ externalInvoiceId: 'in_2' }, expect.anything(), { upsert: true });
  });

  it('sums discount lines (missing amounts as 0) and never records a negative consumed credit', async () => {
    await ledger.ingestStripeInvoice('org_1', {
      id: 'in_3',
      total_discount_amounts: [{ amount: 100 }, {}],
      starting_balance: 0,
      ending_balance: -500,
      lines: { data: [{ period: { start: 1_700_000_000, end: 1_702_592_000 } }] },
    } as any);
    expect(lastSet()).toMatchObject({ discountCents: 100, creditCents: 0, periodStart: new Date(1_700_000_000_000) });
  });

  it.each(['refunded', 'disputed'])('re-ingesting a %s row keeps its status and net paid amount', async (status) => {
    existing.mockResolvedValue({ status });
    await ledger.ingestStripeInvoice('org_1', { id: 'in_4', status: 'paid', amount_paid: 4900, total: 4900 } as any);
    const set = lastSet();
    expect(set.totalCents).toBe(4900);
    expect(set).not.toHaveProperty('status');
    expect(set).not.toHaveProperty('amountPaidCents');
  });
});

describe('reverseLedgerInvoice', () => {
  it('sets only the status when no net amount is given, and clamps a negative net to 0', async () => {
    BillingInvoice.findOneAndUpdate.mockResolvedValue({ orgId: 'org_1' });
    await expect(ledger.reverseLedgerInvoice('in_1', 'disputed')).resolves.toBe('org_1');
    expect(BillingInvoice.findOneAndUpdate).toHaveBeenLastCalledWith({ externalInvoiceId: 'in_1' }, { $set: { status: 'disputed' } }, { new: true });
    await ledger.reverseLedgerInvoice('in_1', 'refunded', -50);
    expect(BillingInvoice.findOneAndUpdate).toHaveBeenLastCalledWith({ externalInvoiceId: 'in_1' }, { $set: { status: 'refunded', amountPaidCents: 0 } }, { new: true });
    expect(incCounter).toHaveBeenCalledWith('billing_invoice_reversed_total', { source: 'stripe', status: 'refunded' });
  });

  it('is a no-op (null) when the invoice was never ingested', async () => {
    BillingInvoice.findOneAndUpdate.mockResolvedValue(null);
    await expect(ledger.reverseLedgerInvoice('in_x', 'refunded', 0)).resolves.toBeNull();
    expect(incCounter).not.toHaveBeenCalled();
  });
});

describe('recordMarketplaceConsumption', () => {
  it('records nothing for a zero or negative draw', async () => {
    await ledger.recordMarketplaceConsumption('org_1', '2026-09', new Date(0), new Date(1), 0);
    await ledger.recordMarketplaceConsumption('org_1', '2026-09', new Date(0), new Date(1), -5);
    expect(BillingInvoice.updateOne).not.toHaveBeenCalled();
  });

  it('accumulates one row per (org, period) with subtotal and credit rising together (net 0)', async () => {
    await ledger.recordMarketplaceConsumption('org_1', '2026-09', new Date(0), new Date(1), 250);
    expect(BillingInvoice.updateOne).toHaveBeenCalledWith(
      { externalInvoiceId: 'mp:org_1:2026-09' },
      expect.objectContaining({ $inc: { subtotalCents: 250, creditCents: 250 }, $setOnInsert: expect.objectContaining({ source: 'marketplace', totalCents: 0, status: 'paid' }) }),
      { upsert: true },
    );
    expect(incCounter).toHaveBeenCalledWith('billing_invoice_ingested_total', { source: 'marketplace' });
  });
});

describe('summaries', () => {
  const matchOf = () => (BillingInvoice.aggregate.mock.calls.at(-1)![0] as Array<{ $match?: unknown }>)[0]!.$match;

  it.each([
    [undefined, undefined, { orgId: 'org_1' }],
    [new Date(1), undefined, { orgId: 'org_1', periodStart: { $gte: new Date(1) } }],
    [undefined, new Date(2), { orgId: 'org_1', periodStart: { $lte: new Date(2) } }],
    [new Date(1), new Date(2), { orgId: 'org_1', periodStart: { $gte: new Date(1), $lte: new Date(2) } }],
  ])('the account summary windows on periodStart (from=%s to=%s)', async (from, to, match) => {
    BillingInvoice.aggregate.mockResolvedValue([]);
    await ledger.getBillingSummary('org_1', from, to);
    expect(matchOf()).toEqual(match);
  });

  it('an empty ledger is all zeros, and a sparse totals row reads missing sums as 0', async () => {
    BillingInvoice.aggregate.mockResolvedValueOnce([]);
    await expect(ledger.getBillingSummary('org_1')).resolves.toEqual({
      scope: 'account', totals: { grossBilledCents: 0, discountsCents: 0, creditsCents: 0, taxCents: 0, netBilledCents: 0, amountPaidCents: 0 }, timeline: [], invoiceCount: 0,
    });
    BillingInvoice.aggregate.mockResolvedValueOnce([{ totals: [{ grossBilledCents: 900 }], timeline: [{ periodStart: new Date(0), grossCents: 900, discountCents: 0, creditCents: 0, netCents: 900 }] }]);
    const s = await ledger.getBillingSummary('org_1');
    expect(s.totals).toMatchObject({ grossBilledCents: 900, netBilledCents: 0 });
    expect(s.invoiceCount).toBe(0);
    expect(s.timeline[0]!.periodStart).toBe('1970-01-01T00:00:00.000Z');
  });

  it('the admin summary narrows by org and window, and maps the per-org breakdown', async () => {
    BillingInvoice.aggregate.mockResolvedValueOnce([{ totals: [{ netBilledCents: 10, invoiceCount: 2 }], byOrg: [{ _id: 'org_1', grossBilledCents: 10, creditsCents: 0, discountsCents: 0, netBilledCents: 10, invoiceCount: 2 }] }]);
    const out = await ledger.getAdminBillingSummary(new Date(1), new Date(2), 'org_1');
    expect(matchOf()).toEqual({ orgId: 'org_1', periodStart: { $gte: new Date(1), $lte: new Date(2) } });
    expect(out).toMatchObject({ invoiceCount: 2, byOrg: [{ orgId: 'org_1', netBilledCents: 10 }] });
    BillingInvoice.aggregate.mockResolvedValueOnce([]);
    await expect(ledger.getAdminBillingSummary(undefined, new Date(2))).resolves.toMatchObject({ byOrg: [], invoiceCount: 0 });
    expect(matchOf()).toEqual({ periodStart: { $lte: new Date(2) } });
    BillingInvoice.aggregate.mockResolvedValueOnce([]);
    await ledger.getAdminBillingSummary(new Date(1));
    expect(matchOf()).toEqual({ periodStart: { $gte: new Date(1) } });
  });

  it('lists invoice rows newest first with pagination', async () => {
    const row = { periodStart: new Date(0), periodEnd: new Date(1), subtotalCents: 5, discountCents: 0, creditCents: 1, taxCents: 0, totalCents: 4, amountPaidCents: 4, status: 'paid' };
    BillingInvoice.find.mockReturnValue({ sort: () => ({ skip: () => ({ limit: async () => [row] }) }) });
    BillingInvoice.countDocuments.mockResolvedValue(7);
    await expect(ledger.listBillingInvoices('org_1', undefined, undefined, 1, 3)).resolves.toEqual({
      invoices: [{ periodStart: '1970-01-01T00:00:00.000Z', periodEnd: '1970-01-01T00:00:00.001Z', grossCents: 5, discountCents: 0, creditCents: 1, taxCents: 0, netCents: 4, amountPaidCents: 4, status: 'paid' }],
      pagination: { total: 7, limit: 1, offset: 3 },
    });
  });
});
