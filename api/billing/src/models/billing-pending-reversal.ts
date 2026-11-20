// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Document } from 'mongoose';
import { BILLING_INVOICE_STATUSES, type BillingInvoiceStatus } from './billing-invoice.js';

/**
 * A provider reversal (refund, dispute, void) that arrived before its invoice
 * was ingested into the ledger.
 *
 * Stripe does not order webhooks, and an invoice ingest can fail and be retried
 * later, so `charge.refunded` can land while no `billing_invoices` row exists
 * for the charge's invoice yet. The reversal is banked here, keyed by the
 * provider invoice id, and folded onto the row when the invoice is ingested —
 * so either arrival order leaves the same ledger row.
 *
 * Holds only what the reversal writes onto the row: the reversal status and the
 * absolute net still-paid amount (Stripe sends cumulative totals, so the latest
 * reversal for an invoice supersedes the earlier one, as it does on the row).
 */
export interface BillingPendingReversalDocument extends Document<string> {
  /** The provider invoice id (the ledger row's `externalInvoiceId`). */
  _id: string;
  status: BillingInvoiceStatus;
  /** Net amount still collected; absent when the reversal leaves it unchanged. */
  amountPaidCents?: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

const schema = new Schema<BillingPendingReversalDocument>(
  {
    _id: { type: String },
    status: { type: String, enum: [...BILLING_INVOICE_STATUSES], required: true },
    amountPaidCents: { type: Number },
    // TTL: a reversal for an invoice that is never ingested (an out-of-band
    // charge with no subscription) has nothing to land on; let it age out.
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { collection: 'billing_pending_reversals', timestamps: true },
);

export const BillingPendingReversal =
  (mongoose.models.BillingPendingReversal as mongoose.Model<BillingPendingReversalDocument>) ||
  mongoose.model<BillingPendingReversalDocument>('BillingPendingReversal', schema);

/**
 * How long a banked reversal waits for its invoice (400 days) — longer than any
 * billing period plus Stripe's redelivery window, so a late or backfilled
 * ingest still finds it.
 */
export const PENDING_REVERSAL_TTL_MS = 400 * 24 * 60 * 60 * 1000;
