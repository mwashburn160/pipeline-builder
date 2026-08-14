// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Document } from 'mongoose';

// Types

/**
 * A local MIRROR of a settled/finalized invoice — the historical actuals that
 * power the billing dashboard (gross → discounts/credits → net). Money is owned
 * by Stripe/Marketplace; this row is upserted idempotently from their webhooks
 * (keyed by {@link BillingInvoiceDocument.externalInvoiceId}) and is never
 * computed independently. `orgId` is the ROOT billing org.
 *
 * `creditCents` is USAGE credit consumed that period (credits offset future
 * usage/overage costs, not the flat plan line). All amounts are integer cents.
 */
export interface BillingInvoiceDocument extends Document {
  orgId: string;
  externalInvoiceId: string;
  source: 'stripe' | 'marketplace';
  periodStart: Date;
  periodEnd: Date;
  /** GROSS — plan base + add-on bundles, pre-discount. */
  subtotalCents: number;
  /** Coupon amount off this invoice. */
  discountCents: number;
  /** Usage credit consumed this invoice. */
  creditCents: number;
  taxCents: number;
  /** NET = subtotal − discount − credit + tax. */
  totalCents: number;
  amountPaidCents: number;
  currency: string;
  /** `refunded`/`disputed` are REVERSAL states set from charge webhooks
   *  (charge.refunded / charge.dispute.created); `void`/`uncollectible` come from
   *  the invoice lifecycle. */
  status: 'paid' | 'open' | 'void' | 'uncollectible' | 'refunded' | 'disputed';
  createdAt: Date;
  updatedAt: Date;
}

// Schema

const billingInvoiceSchema = new Schema<BillingInvoiceDocument>(
  {
    orgId: { type: String, required: true, index: true },
    externalInvoiceId: { type: String, required: true },
    source: { type: String, enum: ['stripe', 'marketplace'], required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    subtotalCents: { type: Number, default: 0 },
    discountCents: { type: Number, default: 0 },
    creditCents: { type: Number, default: 0 },
    taxCents: { type: Number, default: 0 },
    totalCents: { type: Number, default: 0 },
    amountPaidCents: { type: Number, default: 0 },
    currency: { type: String, default: 'usd' },
    status: { type: String, enum: ['paid', 'open', 'void', 'uncollectible', 'refunded', 'disputed'], default: 'paid' },
  },
  {
    collection: 'billing_invoices',
    timestamps: true,
  },
);

// Idempotent ingestion key — one row per external invoice, upserted on retry.
billingInvoiceSchema.index({ externalInvoiceId: 1 }, { unique: true });
// Dashboard aggregation scan (root org + window).
billingInvoiceSchema.index({ orgId: 1, periodStart: 1 });

// Model (safe for re-registration in tests)

export const BillingInvoice =
  (mongoose.models.BillingInvoice as mongoose.Model<BillingInvoiceDocument>) ||
  mongoose.model<BillingInvoiceDocument>('BillingInvoice', billingInvoiceSchema);
