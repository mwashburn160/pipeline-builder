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

type LedgerStatus = 'paid' | 'open' | 'void' | 'uncollectible' | 'refunded' | 'disputed';

/** Map a Stripe invoice status to the ledger's coarser set (draft → open). The
 *  `void`/`uncollectible` branches are driven live by the invoice.voided /
 *  invoice.marked_uncollectible webhooks (which re-ingest the reversed invoice);
 *  `refunded`/`disputed` are set separately by {@link reverseLedgerInvoice}. */
function mapInvoiceStatus(status?: string | null): LedgerStatus {
  switch (status) {
    case 'paid': return 'paid';
    case 'void': return 'void';
    case 'uncollectible': return 'uncollectible';
    default: return 'open';
  }
}

/**
 * Reverse an already-ingested invoice row in the ledger — the charge-level
 * counterpart to {@link ingestStripeInvoice}. Sets the row's `status`
 * (`refunded`/`disputed`) and, when given, OVERWRITES `amountPaidCents` with the
 * net still-collected amount (Stripe sends the cumulative refunded/disputed total
 * on each event, so an absolute set is idempotent under redelivery/partial
 * refunds). No-op (returns null) when no row exists for the invoice — a charge
 * with no ingested invoice has nothing to reverse. Returns the row's `orgId` on
 * success. Best-effort: never computes money independently, only reflects the
 * provider's reversal.
 */
export async function reverseLedgerInvoice(
  invoiceId: string,
  status: LedgerStatus,
  netAmountPaidCents?: number,
): Promise<string | null> {
  const set: Record<string, unknown> = { status };
  if (netAmountPaidCents !== undefined) set.amountPaidCents = Math.max(0, netAmountPaidCents);
  const row = await BillingInvoice.findOneAndUpdate(
    { externalInvoiceId: invoiceId },
    { $set: set },
    { new: true },
  );
  if (!row) {
    logger.debug('No ledger row to reverse', { invoiceId, status });
    return null;
  }
  incCounter('billing_invoice_reversed_total', { source: 'stripe', status });
  logger.info('Billing invoice reversed in ledger', { orgId: row.orgId, invoiceId, status });
  return row.orgId;
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

  // Preserve a prior reversal: if a charge.refunded / dispute already flipped this
  // row to refunded/disputed (with a net amountPaidCents), a re-ingest of the same
  // invoice (backfill, or a non-deduped re-delivery) must NOT overwrite those two
  // fields back to the full paid amount — that would silently un-reverse the
  // refund in the dashboard actuals. Everything else still re-syncs.
  const existing = await BillingInvoice.findOne({ externalInvoiceId: invoice.id }).lean<{ status?: string }>();
  const isReversed = existing?.status === 'refunded' || existing?.status === 'disputed';

  const set: Record<string, unknown> = {
    orgId,
    source: 'stripe',
    periodStart: period?.start ? new Date(period.start * 1000) : new Date(),
    periodEnd: period?.end ? new Date(period.end * 1000) : new Date(),
    subtotalCents: invoice.subtotal ?? 0,
    discountCents,
    creditCents,
    taxCents: invoice.tax ?? 0,
    totalCents: invoice.total ?? 0,
    currency: invoice.currency ?? 'usd',
  };
  if (!isReversed) {
    set.amountPaidCents = invoice.amount_paid ?? 0;
    set.status = mapInvoiceStatus(invoice.status);
  }

  await BillingInvoice.updateOne(
    { externalInvoiceId: invoice.id },
    { $set: set },
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

/** Zeroed totals accumulator shared by both summary shapes. */
function zeroTotals(): BillingSummary['totals'] {
  return { grossBilledCents: 0, discountsCents: 0, creditsCents: 0, taxCents: 0, netBilledCents: 0, amountPaidCents: 0 };
}

/** The per-`$group` sum accumulators mapping ledger columns → summary totals. */
const TOTALS_ACCUMULATORS = {
  grossBilledCents: { $sum: '$subtotalCents' },
  discountsCents: { $sum: '$discountCents' },
  creditsCents: { $sum: '$creditCents' },
  taxCents: { $sum: '$taxCents' },
  netBilledCents: { $sum: '$totalCents' },
  amountPaidCents: { $sum: '$amountPaidCents' },
  invoiceCount: { $sum: 1 },
} as const;

/** Fold a `$group` totals row (or nothing) into the plain totals + count shape. */
function readTotals(row: (BillingSummary['totals'] & { invoiceCount?: number }) | undefined): { totals: BillingSummary['totals']; invoiceCount: number } {
  const totals = zeroTotals();
  if (!row) return { totals, invoiceCount: 0 };
  totals.grossBilledCents = row.grossBilledCents ?? 0;
  totals.discountsCents = row.discountsCents ?? 0;
  totals.creditsCents = row.creditsCents ?? 0;
  totals.taxCents = row.taxCents ?? 0;
  totals.netBilledCents = row.netBilledCents ?? 0;
  totals.amountPaidCents = row.amountPaidCents ?? 0;
  return { totals, invoiceCount: row.invoiceCount ?? 0 };
}

/**
 * Aggregate the root org's ledger into dashboard totals + a per-period timeline.
 * The root org IS the whole account (billing is root-scoped), so this is the
 * consolidated account total — no subtree traversal needed.
 *
 * Totals are summed by a Mongo `$group` (not by loading every invoice document
 * into JS); the timeline is a projection of the (bounded, one-per-invoice-period)
 * rows. A single `$facet` runs both branches over one `$match`+`$sort` scan.
 */
export async function getBillingSummary(orgId: string, from?: Date, to?: Date): Promise<BillingSummary> {
  const [facet] = await BillingInvoice.aggregate<{
    totals: Array<BillingSummary['totals'] & { invoiceCount: number }>;
    timeline: Array<{ periodStart: Date; grossCents: number; discountCents: number; creditCents: number; netCents: number }>;
  }>([
    { $match: windowFilter(orgId, from, to) },
    { $sort: { periodStart: 1 } },
    {
      $facet: {
        totals: [{ $group: { _id: null, ...TOTALS_ACCUMULATORS } }],
        timeline: [{
          $project: {
            _id: 0,
            periodStart: 1,
            grossCents: '$subtotalCents',
            discountCents: '$discountCents',
            creditCents: '$creditCents',
            netCents: '$totalCents',
          },
        }],
      },
    },
  ]);
  const { totals, invoiceCount } = readTotals(facet?.totals?.[0]);
  const timeline = (facet?.timeline ?? []).map((r) => ({
    periodStart: new Date(r.periodStart).toISOString(),
    grossCents: r.grossCents,
    discountCents: r.discountCents,
    creditCents: r.creditCents,
    netCents: r.netCents,
  }));
  return { scope: 'account', totals, timeline, invoiceCount };
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
  // Sum ENTIRELY in Mongo — a `$facet` computes the grand totals and the per-org
  // breakdown in one pass. The old `.find()` streamed every invoice across ALL
  // accounts into JS (an OOM risk on the unscoped admin view); nothing but the
  // aggregated rows crosses the wire now.
  const [facet] = await BillingInvoice.aggregate<{
    totals: Array<BillingSummary['totals'] & { invoiceCount: number }>;
    byOrg: Array<{ _id: string; grossBilledCents: number; creditsCents: number; discountsCents: number; netBilledCents: number; invoiceCount: number }>;
  }>([
    { $match: filter },
    {
      $facet: {
        totals: [{ $group: { _id: null, ...TOTALS_ACCUMULATORS } }],
        byOrg: [
          {
            $group: {
              _id: '$orgId',
              grossBilledCents: { $sum: '$subtotalCents' },
              creditsCents: { $sum: '$creditCents' },
              discountsCents: { $sum: '$discountCents' },
              netBilledCents: { $sum: '$totalCents' },
              invoiceCount: { $sum: 1 },
            },
          },
          { $sort: { netBilledCents: -1 } },
        ],
      },
    },
  ]);
  const { totals, invoiceCount } = readTotals(facet?.totals?.[0]);
  const byOrg = (facet?.byOrg ?? []).map((o) => ({
    orgId: o._id,
    grossBilledCents: o.grossBilledCents,
    creditsCents: o.creditsCents,
    discountsCents: o.discountsCents,
    netBilledCents: o.netBilledCents,
    invoiceCount: o.invoiceCount,
  }));
  return { totals, byOrg, invoiceCount };
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
  // Stream with a cursor instead of loading every customer into memory at once —
  // this is a full-collection admin backfill that would OOM at scale otherwise.
  const cursor = Subscription.find({ externalCustomerId: { $exists: true, $ne: null } }).cursor();
  let accounts = 0; let ingested = 0; let errors = 0;
  for await (const sub of cursor) {
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
