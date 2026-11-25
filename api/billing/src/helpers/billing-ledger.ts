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
import type { PipelineStage } from 'mongoose';
import { recurringInvoicePeriod, type InvoiceLineLike } from './stripe-period.js';
import { BillingInvoice, type BillingInvoiceStatus } from '../models/billing-invoice.js';
import { BillingPendingReversal, PENDING_REVERSAL_TTL_MS } from '../models/billing-pending-reversal.js';

const logger = createLogger('billing-ledger');

/** The Stripe invoice fields the ledger reads (a structural subset). */
export interface StripeInvoiceLike {
  id?: string | null;
  subtotal?: number | null;
  total?: number | null;
  /** One entry per tax applied (Stripe dropped the scalar `tax` in API 2025-03-31). */
  total_taxes?: Array<{ amount: number }> | null;
  amount_paid?: number | null;
  /** Customer balance BEFORE / AFTER this invoice (cents; negative = credit). */
  starting_balance?: number | null;
  ending_balance?: number | null;
  total_discount_amounts?: Array<{ amount: number }> | null;
  currency?: string | null;
  status?: string | null;
  lines?: { data?: InvoiceLineLike[] };
}

type LedgerStatus = BillingInvoiceStatus;

/** The Stripe invoice statuses the ledger keeps as-is; every other one (draft,
 *  open, an unknown future value) is `open`. The `void`/`uncollectible` entries
 *  are driven live by the invoice.voided / invoice.marked_uncollectible webhooks
 *  (which re-ingest the reversed invoice); `refunded`/`disputed` are set
 *  separately by {@link reverseLedgerInvoice}. */
const STRIPE_INVOICE_STATUS_MAP: Readonly<Partial<Record<string, LedgerStatus>>> = {
  paid: 'paid',
  void: 'void',
  uncollectible: 'uncollectible',
} satisfies Partial<Record<string, LedgerStatus>>;

/** Map a Stripe invoice status to the ledger's coarser set (draft → open). */
function mapInvoiceStatus(status?: string | null): LedgerStatus {
  return (status && Object.hasOwn(STRIPE_INVOICE_STATUS_MAP, status) ? STRIPE_INVOICE_STATUS_MAP[status] : undefined) ?? 'open';
}

/**
 * Reversal PRECEDENCE. Stripe delivers `charge.refunded` / `charge.dispute.created`
 * unordered, and each carries an ABSOLUTE status + net amount, so a lesser event
 * arriving late (the partial refund that preceded a dispute) used to overwrite the
 * row back to `refunded` with a higher amount still paid. A reversal now only moves
 * the status UP this ranking, and the net amount paid only ever goes DOWN (`$min`:
 * the provider's cumulative totals make the latest reversal the lowest net).
 * The one sanctioned way DOWN is a won dispute ({@link restoreDisputedLedgerInvoice}),
 * which moves only a `disputed` row, and only to what its refund history allows.
 */
const REVERSAL_RANK: Readonly<Record<LedgerStatus, number>> = {
  open: 0, paid: 0, void: 1, uncollectible: 1, refunded: 2, disputed: 3,
};

/** The statuses `status` may replace: its own rank or lower. */
function replaceableBy(status: LedgerStatus): LedgerStatus[] {
  return (Object.keys(REVERSAL_RANK) as LedgerStatus[]).filter((s) => REVERSAL_RANK[s] <= REVERSAL_RANK[status]);
}

/** Charge-level reversals a re-ingest of the invoice must not overwrite. */
const PRESERVED_REVERSALS: readonly LedgerStatus[] = ['refunded', 'disputed'];

/** Statuses never collected: kept on the row, left out of billed totals. */
const UNCOLLECTED_STATUSES: readonly LedgerStatus[] = ['void', 'uncollectible'];

/** The amount half of a reversal update: lower the net paid, never raise it. */
function amountUpdate(netAmountPaidCents?: number): Record<string, unknown> {
  return netAmountPaidCents === undefined ? {} : { $min: { amountPaidCents: Math.max(0, netAmountPaidCents) } };
}

/**
 * Write a reversal onto an existing ledger row, under {@link REVERSAL_RANK}: the
 * status moves only when it outranks (or equals) the row's, and the amount is
 * lowered either way. Null when the row is absent.
 */
async function applyReversal(invoiceId: string, status: LedgerStatus, netAmountPaidCents?: number): Promise<{ orgId: string } | null> {
  const amount = amountUpdate(netAmountPaidCents);
  const moved = await BillingInvoice.findOneAndUpdate(
    { externalInvoiceId: invoiceId, status: { $in: replaceableBy(status) } },
    { $set: { status }, ...amount },
    { new: true },
  );
  if (moved) return moved;
  // The row holds a higher-precedence reversal (or is absent): keep its status.
  return netAmountPaidCents === undefined
    ? BillingInvoice.findOne({ externalInvoiceId: invoiceId }).lean<{ orgId: string }>()
    : BillingInvoice.findOneAndUpdate({ externalInvoiceId: invoiceId }, amount, { new: true });
}

/**
 * Bank a reversal for an invoice not yet ingested, under the same precedence as
 * a row: an outranked banked status is kept (the upsert's filter misses, its
 * insert trips the `_id` key) and only the amount is lowered.
 */
async function bankReversal(invoiceId: string, status: LedgerStatus, netAmountPaidCents?: number): Promise<void> {
  const expiresAt = new Date(Date.now() + PENDING_REVERSAL_TTL_MS);
  const amount = amountUpdate(netAmountPaidCents);
  try {
    await BillingPendingReversal.updateOne(
      { _id: invoiceId, status: { $in: replaceableBy(status) } },
      { $set: { status, expiresAt }, ...amount },
      { upsert: true },
    );
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    await BillingPendingReversal.updateOne({ _id: invoiceId }, { $set: { expiresAt }, ...amount });
  }
}

/**
 * Reverse an invoice row in the ledger — the charge-level counterpart to
 * {@link ingestStripeInvoice}. Sets the row's `status` (`refunded`/`disputed`,
 * or `void`/`uncollectible`) and, when given, lowers `amountPaidCents` to the net
 * still-collected amount, both under {@link REVERSAL_RANK} so redelivered and
 * out-of-order reversals converge on the same row.
 *
 * When the invoice has not been ingested yet (webhooks are unordered, and an
 * ingest can fail and be redelivered later) the reversal is BANKED as a
 * {@link BillingPendingReversal} and folded onto the row by the ingest, so the
 * ledger ends up the same in either order. Returns the row's `orgId` when it was
 * written now, null when it was banked. Never computes money independently,
 * only reflects the provider's reversal.
 */
export async function reverseLedgerInvoice(
  invoiceId: string,
  status: LedgerStatus,
  netAmountPaidCents?: number,
): Promise<string | null> {
  const row = await applyReversal(invoiceId, status, netAmountPaidCents);
  if (row) {
    incCounter('billing_invoice_reversed_total', { source: 'stripe', status });
    logger.info('Billing invoice reversed in ledger', { orgId: row.orgId, invoiceId, status });
    return row.orgId;
  }

  // No row yet: bank the reversal for the ingest to apply.
  await bankReversal(invoiceId, status, netAmountPaidCents);

  // The invoice may have been ingested between the miss above and the bank —
  // that ingest found no banked reversal. Look again so the reversal can't be
  // stranded; applying twice is harmless (precedence + `$min`).
  const late = await applyReversal(invoiceId, status, netAmountPaidCents);
  if (late) {
    await BillingPendingReversal.deleteOne({ _id: invoiceId });
    incCounter('billing_invoice_reversed_total', { source: 'stripe', status });
    logger.info('Billing invoice reversed in ledger', { orgId: late.orgId, invoiceId, status });
    return late.orgId;
  }
  incCounter('billing_invoice_reversal_banked_total', { source: 'stripe', status });
  logger.info('Invoice not in the ledger yet — reversal banked for its ingest', { invoiceId, status });
  return null;
}

/**
 * A WON dispute (`charge.dispute.closed`, status `won`): the disputed funds came
 * back, so a `disputed` row returns to the state its refund history allows —
 * `paid` with the full amount, or `refunded` with the refund still counted
 * (`netAmountPaidCents` = charge amount − amount refunded). The only write that
 * moves DOWN {@link REVERSAL_RANK}, and it moves only a row that is `disputed`:
 * a redelivered won event, or one for a row no dispute reached, changes nothing.
 * A dispute still BANKED (its invoice not ingested yet) is rewritten the same
 * way — dropped when nothing is left reversed, so the ingest lands the paid row.
 */
export async function restoreDisputedLedgerInvoice(
  invoiceId: string,
  status: 'paid' | 'refunded',
  netAmountPaidCents: number,
): Promise<void> {
  const amountPaidCents = Math.max(0, netAmountPaidCents);
  const row = await BillingInvoice.findOneAndUpdate(
    { externalInvoiceId: invoiceId, status: 'disputed' },
    { $set: { status, amountPaidCents } },
    { new: true },
  );
  if (row) {
    incCounter('billing_invoice_dispute_won_total', { source: 'stripe', status });
    logger.info('Won dispute restored the billing invoice', { orgId: row.orgId, invoiceId, status });
    return;
  }
  const banked = status === 'paid'
    ? await BillingPendingReversal.deleteOne({ _id: invoiceId, status: 'disputed' })
    : await BillingPendingReversal.updateOne({ _id: invoiceId, status: 'disputed' }, { $set: { status, amountPaidCents } });
  const touched = 'deletedCount' in banked ? banked.deletedCount : banked.modifiedCount;
  if (touched) {
    incCounter('billing_invoice_dispute_won_total', { source: 'stripe', status });
    logger.info('Won dispute rewrote the banked reversal', { invoiceId, status });
  }
}

/**
 * Fold a banked reversal onto a just-ingested row. The banked doc is deleted
 * only AFTER it is applied, and only if no newer reversal replaced it in the
 * meantime (matched on `updatedAt`), so a crash between the two re-applies it on
 * the next ingest instead of losing it.
 */
async function applyBankedReversal(invoiceId: string): Promise<void> {
  const banked = await BillingPendingReversal.findOne({ _id: invoiceId }).lean<{ status: LedgerStatus; amountPaidCents?: number; updatedAt?: Date }>();
  if (!banked) return;
  const row = await applyReversal(invoiceId, banked.status, banked.amountPaidCents ?? undefined);
  if (!row) return;
  await BillingPendingReversal.deleteOne({ _id: invoiceId, ...(banked.updatedAt ? { updatedAt: banked.updatedAt } : {}) });
  incCounter('billing_invoice_reversed_total', { source: 'stripe', status: banked.status });
  logger.info('Banked reversal applied to ingested invoice', { orgId: row.orgId, invoiceId, status: banked.status });
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
  // The recurring charge's period; a proration-only or one-off invoice falls back
  // to its first line, which is the only period it has.
  const recurring = recurringInvoicePeriod(invoice);
  const line = invoice.lines?.data?.[0]?.period;
  const discountCents = (invoice.total_discount_amounts ?? []).reduce((s, d) => s + (d.amount ?? 0), 0);
  const taxCents = (invoice.total_taxes ?? []).reduce((s, t) => s + (t.amount ?? 0), 0);
  const creditCents = Math.max(0, (invoice.ending_balance ?? 0) - (invoice.starting_balance ?? 0));

  const set: Record<string, unknown> = {
    orgId,
    source: 'stripe',
    periodStart: recurring?.start ?? (line?.start ? new Date(line.start * 1000) : new Date()),
    periodEnd: recurring?.end ?? (line?.end ? new Date(line.end * 1000) : new Date()),
    subtotalCents: invoice.subtotal ?? 0,
    discountCents,
    creditCents,
    taxCents,
    totalCents: invoice.total ?? 0,
    currency: invoice.currency ?? 'usd',
  };

  // Preserve a prior reversal: if a charge.refunded / dispute already flipped this
  // row to refunded/disputed (with a net amountPaidCents), a re-ingest of the same
  // invoice (backfill, or a non-deduped re-delivery) must NOT overwrite those two
  // fields back to the full paid amount — that would silently un-reverse the
  // refund in the dashboard actuals. Everything else still re-syncs.
  //
  // One conditional write, not read-then-write: a reversal landing between a
  // read and the write was overwritten. The upsert writes status + amount only
  // where the row is NOT reversed; on a reversed row its filter misses, the
  // insert trips the unique `externalInvoiceId`, and the fallback re-syncs the
  // rest without them.
  try {
    await BillingInvoice.updateOne(
      { externalInvoiceId: invoice.id, status: { $nin: [...PRESERVED_REVERSALS] } },
      { $set: { ...set, amountPaidCents: invoice.amount_paid ?? 0, status: mapInvoiceStatus(invoice.status) } },
      { upsert: true },
    );
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    await BillingInvoice.updateOne({ externalInvoiceId: invoice.id }, { $set: set });
  }
  incCounter('billing_invoice_ingested_total', { source: 'stripe' });
  logger.debug('Billing invoice ingested', { orgId, invoiceId: invoice.id });

  // A refund/dispute that arrived before this invoice was banked rather than
  // dropped — land it now so the row matches the invoice-first order.
  await applyBankedReversal(invoice.id);
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

/** Summed ledger columns, in minor units of one currency. */
export interface BillingTotals {
  grossBilledCents: number;
  discountsCents: number;
  creditsCents: number;
  taxCents: number;
  netBilledCents: number;
  amountPaidCents: number;
}

/** One currency's totals. Amounts in different currencies are never added together. */
export interface CurrencyTotals extends BillingTotals {
  /** Lower-case ISO 4217 code, as the provider reports it (`usd`, `eur`). */
  currency: string;
  invoiceCount: number;
}

export interface BillingSummary {
  scope: 'account';
  /** One entry per currency the account was billed in, sorted by currency code; empty with no invoices. */
  totalsByCurrency: CurrencyTotals[];
  timeline: Array<{ periodStart: string; currency: string; grossCents: number; discountCents: number; creditCents: number; netCents: number }>;
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

/** The `$facet` branch summing the ledger per currency, sorted by currency code. */
const TOTALS_BY_CURRENCY: PipelineStage.FacetPipelineStage[] = [{ $group: { _id: '$currency', ...TOTALS_ACCUMULATORS } }, { $sort: { _id: 1 } }];

type TotalsRow = Omit<CurrencyTotals, 'currency'> & { _id: string };

/** Map the per-currency `$group` rows into the summary shape. */
function readTotals(rows: TotalsRow[] | undefined): { totalsByCurrency: CurrencyTotals[]; invoiceCount: number } {
  const totalsByCurrency = (rows ?? []).map((r) => ({
    currency: r._id,
    grossBilledCents: r.grossBilledCents,
    discountsCents: r.discountsCents,
    creditsCents: r.creditsCents,
    taxCents: r.taxCents,
    netBilledCents: r.netBilledCents,
    amountPaidCents: r.amountPaidCents,
    invoiceCount: r.invoiceCount,
  }));
  return { totalsByCurrency, invoiceCount: totalsByCurrency.reduce((n, t) => n + t.invoiceCount, 0) };
}

/**
 * Aggregate the root org's ledger into dashboard totals + a per-period timeline.
 * The root org IS the whole account (billing is root-scoped), so this is the
 * consolidated account total — no subtree traversal needed.
 *
 * Totals are summed PER CURRENCY by a Mongo `$group` (an account billed in two
 * currencies gets two totals — adding dollars to euros is no total at all); the
 * timeline is a projection of the (bounded, one-per-invoice-period) rows, each
 * tagged with its currency. A single `$facet` runs both branches over one
 * `$match`+`$sort` scan.
 */
export async function getBillingSummary(orgId: string, from?: Date, to?: Date): Promise<BillingSummary> {
  const [facet] = await BillingInvoice.aggregate<{
    totals: TotalsRow[];
    timeline: Array<{ periodStart: Date; currency: string; grossCents: number; discountCents: number; creditCents: number; netCents: number }>;
  }>([
    // Void / uncollectible invoices were never collected — not billed revenue.
    { $match: { ...windowFilter(orgId, from, to), status: { $nin: [...UNCOLLECTED_STATUSES] } } },
    { $sort: { periodStart: 1 } },
    {
      $facet: {
        totals: TOTALS_BY_CURRENCY,
        timeline: [{
          $project: {
            _id: 0,
            periodStart: 1,
            currency: '$currency',
            grossCents: '$subtotalCents',
            discountCents: '$discountCents',
            creditCents: '$creditCents',
            netCents: '$totalCents',
          },
        }],
      },
    },
  ]);
  const { totalsByCurrency, invoiceCount } = readTotals(facet?.totals);
  const timeline = (facet?.timeline ?? []).map((r) => ({
    periodStart: new Date(r.periodStart).toISOString(),
    currency: r.currency,
    grossCents: r.grossCents,
    discountCents: r.discountCents,
    creditCents: r.creditCents,
    netCents: r.netCents,
  }));
  return { scope: 'account', totalsByCurrency, timeline, invoiceCount };
}

export interface AdminBillingSummary {
  totalsByCurrency: CurrencyTotals[];
  /** One row per (account, currency), sorted by net billed descending. */
  byOrg: Array<{ orgId: string; currency: string; grossBilledCents: number; creditsCents: number; discountsCents: number; netBilledCents: number; invoiceCount: number }>;
  invoiceCount: number;
}

/**
 * Cross-ACCOUNT aggregate for the system-admin finance view — totals + a per-org
 * breakdown (discount/credit impact vs net), both PER CURRENCY. `orgId` narrows
 * to one account; omitted spans every account. Distinct from
 * {@link getBillingSummary}, which is a single account's own dashboard.
 */
export async function getAdminBillingSummary(from?: Date, to?: Date, orgId?: string): Promise<AdminBillingSummary> {
  // Void / uncollectible invoices were never collected — not billed revenue.
  const filter: Record<string, unknown> = { status: { $nin: [...UNCOLLECTED_STATUSES] } };
  if (orgId) filter.orgId = orgId;
  if (from || to) {
    const range: Record<string, Date> = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    filter.periodStart = range;
  }
  // Sum ENTIRELY in Mongo — a `$facet` computes the grand totals and the per-org
  // breakdown in one pass, so nothing but the aggregated rows crosses the wire.
  const [facet] = await BillingInvoice.aggregate<{
    totals: TotalsRow[];
    byOrg: Array<{ _id: { orgId: string; currency: string }; grossBilledCents: number; creditsCents: number; discountsCents: number; netBilledCents: number; invoiceCount: number }>;
  }>([
    { $match: filter },
    {
      $facet: {
        totals: TOTALS_BY_CURRENCY,
        byOrg: [
          {
            $group: {
              _id: { orgId: '$orgId', currency: '$currency' },
              grossBilledCents: { $sum: '$subtotalCents' },
              creditsCents: { $sum: '$creditCents' },
              discountsCents: { $sum: '$discountCents' },
              netBilledCents: { $sum: '$totalCents' },
              invoiceCount: { $sum: 1 },
            },
          },
          { $sort: { 'netBilledCents': -1, '_id.orgId': 1, '_id.currency': 1 } },
        ],
      },
    },
  ]);
  const { totalsByCurrency, invoiceCount } = readTotals(facet?.totals);
  const byOrg = (facet?.byOrg ?? []).map((o) => ({
    orgId: o._id.orgId,
    currency: o._id.currency,
    grossBilledCents: o.grossBilledCents,
    creditsCents: o.creditsCents,
    discountsCents: o.discountsCents,
    netBilledCents: o.netBilledCents,
    invoiceCount: o.invoiceCount,
  }));
  return { totalsByCurrency, byOrg, invoiceCount };
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
      currency: r.currency,
      status: r.status,
    })),
    pagination: { total, limit, offset },
  };
}
