// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Billing ledger — historical invoice ACTUALS that power the billing dashboard
 * (gross billed → discounts/credits → net). Money is owned by the provider;
 * these rows are upserted (idempotently) from settled-invoice webhooks and are
 * never computed independently. `orgId` is the root billing org. See
 * docs/billing-discounts.md.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { BillingInvoice } from '../models/billing-invoice.js';
import { Subscription } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

const logger = createLogger('billing-ledger');

/** The Stripe invoice fields the ledger reads (a structural subset). */
export interface StripeInvoiceLike {
  id?: string | null;
  subtotal?: number | null;
  total?: number | null;
  tax?: number | null;
  amount_paid?: number | null;
  /** Customer balance BEFORE / AFTER this invoice (cents; negative = credit). */
  starting_balance?: number | null;
  ending_balance?: number | null;
  total_discount_amounts?: Array<{ amount: number }> | null;
  currency?: string | null;
  status?: string | null;
  lines?: { data?: Array<{ period?: { start?: number | null; end?: number | null } | null }> };
}

type LedgerStatus = 'paid' | 'open' | 'void' | 'uncollectible';

/** Map a Stripe invoice status to the ledger's coarser set (draft → open). */
function mapInvoiceStatus(status?: string | null): LedgerStatus {
  switch (status) {
    case 'paid': return 'paid';
    case 'void': return 'void';
    case 'uncollectible': return 'uncollectible';
    default: return 'open';
  }
}

/**
 * Upsert a settled Stripe invoice into the ledger (idempotent on
 * `externalInvoiceId`, so a redelivered webhook is safe). `creditCents` is the
 * usage credit CONSUMED this invoice — the amount of customer balance applied
 * (`ending − starting`, both negative for a credit, so the delta is positive as
 * the balance is drawn toward zero). Under the usage-credit model that is where
 * a discount shows up; `discountCents` (Stripe coupon lines) stays 0.
 */
export async function ingestStripeInvoice(orgId: string, invoice: StripeInvoiceLike): Promise<void> {
  if (!invoice.id) return;
  const period = invoice.lines?.data?.[0]?.period;
  const discountCents = (invoice.total_discount_amounts ?? []).reduce((s, d) => s + (d.amount ?? 0), 0);
  const creditCents = Math.max(0, (invoice.ending_balance ?? 0) - (invoice.starting_balance ?? 0));
  await BillingInvoice.updateOne(
    { externalInvoiceId: invoice.id },
    {
      $set: {
        orgId,
        source: 'stripe',
        periodStart: period?.start ? new Date(period.start * 1000) : new Date(),
        periodEnd: period?.end ? new Date(period.end * 1000) : new Date(),
        subtotalCents: invoice.subtotal ?? 0,
        discountCents,
        creditCents,
        taxCents: invoice.tax ?? 0,
        totalCents: invoice.total ?? 0,
        amountPaidCents: invoice.amount_paid ?? 0,
        currency: invoice.currency ?? 'usd',
        status: mapInvoiceStatus(invoice.status),
      },
    },
    { upsert: true },
  );
  incCounter('billing_invoice_ingested_total', { source: 'stripe' });
  logger.debug('Billing invoice ingested', { orgId, invoiceId: invoice.id });
}

/**
 * Record AWS Marketplace metered credit CONSUMPTION for a billing period into the
 * ledger — ONE row per (org, period), `$inc`-accumulated as the hourly drawdown
 * runs. Marketplace realization never produces a Stripe invoice, so without this
 * the dashboard's "usage credits" would silently omit it (and every hourly draw
 * would otherwise bloat the subscription's `creditLedger` array). Per-hour
 * idempotency is owned by the caller's atomic drawdown claim — only the winning
 * pod/hour reaches here. `subtotal` and `credit` rise together so NET stays 0 (the
 * credit fully offsets the withheld metered value).
 */
export async function recordMarketplaceConsumption(
  orgId: string,
  periodKey: string,
  periodStart: Date,
  periodEnd: Date,
  consumedCents: number,
): Promise<void> {
  if (consumedCents <= 0) return;
  await BillingInvoice.updateOne(
    { externalInvoiceId: `mp:${orgId}:${periodKey}` },
    {
      $inc: { subtotalCents: consumedCents, creditCents: consumedCents },
      $setOnInsert: {
        orgId,
        source: 'marketplace',
        periodStart,
        periodEnd,
        discountCents: 0,
        taxCents: 0,
        totalCents: 0,
        amountPaidCents: 0,
        currency: 'usd',
        status: 'paid',
      },
    },
    { upsert: true },
  );
  incCounter('billing_invoice_ingested_total', { source: 'marketplace' });
  logger.debug('Marketplace consumption recorded', { orgId, periodKey, consumedCents });
}

export interface BillingSummary {
  scope: 'account';
  totals: {
    grossBilledCents: number;
    discountsCents: number;
    creditsCents: number;
    taxCents: number;
    netBilledCents: number;
    amountPaidCents: number;
  };
  timeline: Array<{ periodStart: string; grossCents: number; discountCents: number; creditCents: number; netCents: number }>;
  invoiceCount: number;
}

/** Optional [from,to] window on `periodStart`. */
function windowFilter(orgId: string, from?: Date, to?: Date): Record<string, unknown> {
  const filter: Record<string, unknown> = { orgId };
  if (from || to) {
    const range: Record<string, Date> = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    filter.periodStart = range;
  }
  return filter;
}

/**
 * Aggregate the root org's ledger into dashboard totals + a per-period timeline.
 * The root org IS the whole account (billing is root-scoped), so this is the
 * consolidated account total — no subtree traversal needed.
 */
export async function getBillingSummary(orgId: string, from?: Date, to?: Date): Promise<BillingSummary> {
  const rows = await BillingInvoice.find(windowFilter(orgId, from, to)).sort({ periodStart: 1 });
  const totals = {
    grossBilledCents: 0, discountsCents: 0, creditsCents: 0, taxCents: 0, netBilledCents: 0, amountPaidCents: 0,
  };
  const timeline = rows.map((r) => {
    totals.grossBilledCents += r.subtotalCents;
    totals.discountsCents += r.discountCents;
    totals.creditsCents += r.creditCents;
    totals.taxCents += r.taxCents;
    totals.netBilledCents += r.totalCents;
    totals.amountPaidCents += r.amountPaidCents;
    return {
      periodStart: r.periodStart.toISOString(),
      grossCents: r.subtotalCents,
      discountCents: r.discountCents,
      creditCents: r.creditCents,
      netCents: r.totalCents,
    };
  });
  return { scope: 'account', totals, timeline, invoiceCount: rows.length };
}

export interface AdminBillingSummary {
  totals: BillingSummary['totals'];
  byOrg: Array<{ orgId: string; grossBilledCents: number; creditsCents: number; discountsCents: number; netBilledCents: number; invoiceCount: number }>;
  invoiceCount: number;
}

/**
 * Cross-ACCOUNT aggregate for the system-admin finance view — totals + a per-org
 * breakdown (discount/credit impact vs net). `orgId` narrows to one account;
 * omitted spans every account. Distinct from {@link getBillingSummary}, which is
 * a single account's own dashboard.
 */
export async function getAdminBillingSummary(from?: Date, to?: Date, orgId?: string): Promise<AdminBillingSummary> {
  const filter: Record<string, unknown> = {};
  if (orgId) filter.orgId = orgId;
  if (from || to) {
    const range: Record<string, Date> = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    filter.periodStart = range;
  }
  const rows = await BillingInvoice.find(filter).sort({ periodStart: 1 });
  const totals = { grossBilledCents: 0, discountsCents: 0, creditsCents: 0, taxCents: 0, netBilledCents: 0, amountPaidCents: 0 };
  const byOrgMap = new Map<string, AdminBillingSummary['byOrg'][number]>();
  for (const r of rows) {
    totals.grossBilledCents += r.subtotalCents;
    totals.discountsCents += r.discountCents;
    totals.creditsCents += r.creditCents;
    totals.taxCents += r.taxCents;
    totals.netBilledCents += r.totalCents;
    totals.amountPaidCents += r.amountPaidCents;
    const o = byOrgMap.get(r.orgId) ?? { orgId: r.orgId, grossBilledCents: 0, creditsCents: 0, discountsCents: 0, netBilledCents: 0, invoiceCount: 0 };
    o.grossBilledCents += r.subtotalCents;
    o.creditsCents += r.creditCents;
    o.discountsCents += r.discountCents;
    o.netBilledCents += r.totalCents;
    o.invoiceCount += 1;
    byOrgMap.set(r.orgId, o);
  }
  const byOrg = [...byOrgMap.values()].sort((a, b) => b.netBilledCents - a.netBilledCents);
  return { totals, byOrg, invoiceCount: rows.length };
}

/**
 * One-off backfill: seed the ledger from the provider's historical invoices
 * (invoices weren't persisted before the ledger). Iterates subscriptions with an
 * external customer, lists each customer's invoices, and ingests them
 * idempotently. Fail-soft per account. Returns counts for the admin response.
 */
export async function backfillLedgerFromProvider(limitPerCustomer = 100): Promise<{ accounts: number; ingested: number; errors: number }> {
  const provider = getPaymentProvider();
  if (!provider.listCustomerInvoices) return { accounts: 0, ingested: 0, errors: 0 };
  const subs = await Subscription.find({ externalCustomerId: { $exists: true, $ne: null } });
  let accounts = 0; let ingested = 0; let errors = 0;
  for (const sub of subs) {
    if (!sub.externalCustomerId) continue;
    accounts += 1;
    try {
      const invoices = await provider.listCustomerInvoices(sub.externalCustomerId, limitPerCustomer);
      for (const inv of invoices) {
        await ingestStripeInvoice(sub.orgId, inv);
        ingested += 1;
      }
    } catch (err) {
      errors += 1;
      logger.warn('Ledger backfill failed for account', { orgId: sub.orgId, error: String(err) });
    }
  }
  logger.info('Ledger backfill complete', { accounts, ingested, errors });
  return { accounts, ingested, errors };
}

/** Paginated raw invoice rows for the dashboard's invoice table. */
export async function listBillingInvoices(orgId: string, from: Date | undefined, to: Date | undefined, limit: number, offset: number) {
  const filter = windowFilter(orgId, from, to);
  const [invoices, total] = await Promise.all([
    BillingInvoice.find(filter).sort({ periodStart: -1 }).skip(offset).limit(limit),
    BillingInvoice.countDocuments(filter),
  ]);
  return {
    invoices: invoices.map((r) => ({
      periodStart: r.periodStart.toISOString(),
      periodEnd: r.periodEnd.toISOString(),
      grossCents: r.subtotalCents,
      discountCents: r.discountCents,
      creditCents: r.creditCents,
      taxCents: r.taxCents,
      netCents: r.totalCents,
      amountPaidCents: r.amountPaidCents,
      status: r.status,
    })),
    pagination: { total, limit, offset },
  };
}
