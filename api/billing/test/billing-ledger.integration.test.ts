// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The billing ledger against a REAL MongoDB (mongodb-memory-server).
 *
 * Two behaviours a hand-written model mock cannot vouch for, because they live
 * in the query and update operators themselves:
 *
 *  1. REVERSAL PRECEDENCE. Stripe delivers `charge.refunded` and
 *     `charge.dispute.created` unordered. A lesser reversal arriving late must
 *     never move a row (or a banked reversal) to a lower-precedence status, nor
 *     raise the net amount still paid.
 *  2. The dashboard summaries leave out invoices that were never collected
 *     (`void`, `uncollectible`): they were not billed revenue.
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped locally, REQUIRED on CI).
 */

import { jest, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { integrationSuite, MONGOD_VERSION } from './helpers/integration-gate.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
}));

const suite = integrationSuite();

suite('Billing ledger (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, BillingInvoice: any, BillingPendingReversal: any, ledger: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    await mongoose.connect(mongod.getUri());
    ({ BillingInvoice } = await import('../src/models/billing-invoice.js'));
    ({ BillingPendingReversal } = await import('../src/models/billing-pending-reversal.js'));
    await BillingInvoice.init();
    await BillingPendingReversal.init();
    ledger = await import('../src/helpers/billing-ledger.js');
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => {
    await BillingInvoice.deleteMany({});
    await BillingPendingReversal.deleteMany({});
  });

  const invoice = (over: Record<string, unknown> = {}) => ({
    id: 'in_1',
    subtotal: 4900,
    total: 4900,
    amount_paid: 4900,
    currency: 'usd',
    status: 'paid',
    lines: { data: [{ period: { start: 1_767_225_600, end: 1_769_904_000 } }] },
    ...over,
  });
  const row = () => BillingInvoice.findOne({ externalInvoiceId: 'in_1' }).lean();

  // ── 1. reversal precedence ────────────────────────────────────────────────

  it('a refund arriving AFTER the dispute leaves the row disputed with the lower net paid', async () => {
    await ledger.ingestStripeInvoice('org-1', invoice());
    await ledger.reverseLedgerInvoice('in_1', 'disputed', 0);
    // The earlier partial refund's event, delivered late: net 3000 still paid.
    await ledger.reverseLedgerInvoice('in_1', 'refunded', 3000);

    expect(await row()).toMatchObject({ status: 'disputed', amountPaidCents: 0 });
  });

  it('a later, larger cumulative refund still lowers the net paid', async () => {
    await ledger.ingestStripeInvoice('org-1', invoice());
    await ledger.reverseLedgerInvoice('in_1', 'refunded', 3000);
    await ledger.reverseLedgerInvoice('in_1', 'refunded', 1000);
    // Redelivery of the first (smaller) refund must not raise it back.
    await ledger.reverseLedgerInvoice('in_1', 'refunded', 3000);

    expect(await row()).toMatchObject({ status: 'refunded', amountPaidCents: 1000 });
  });

  it('a dispute outranks an earlier refund', async () => {
    await ledger.ingestStripeInvoice('org-1', invoice());
    await ledger.reverseLedgerInvoice('in_1', 'refunded', 3000);
    await ledger.reverseLedgerInvoice('in_1', 'disputed', 0);

    expect(await row()).toMatchObject({ status: 'disputed', amountPaidCents: 0 });
  });

  it('banked reversals obey the same precedence, and land on the ingested row', async () => {
    await ledger.reverseLedgerInvoice('in_1', 'disputed', 0);
    await ledger.reverseLedgerInvoice('in_1', 'refunded', 3000);
    const banked = await BillingPendingReversal.findById('in_1').lean();
    expect(banked).toMatchObject({ status: 'disputed', amountPaidCents: 0 });

    await ledger.ingestStripeInvoice('org-1', invoice());
    expect(await row()).toMatchObject({ status: 'disputed', amountPaidCents: 0 });
    expect(await BillingPendingReversal.findById('in_1').lean()).toBeNull();
  });

  // ── 2. summaries leave out uncollected invoices ───────────────────────────

  it('the account and admin summaries leave out void and uncollectible invoices', async () => {
    await ledger.ingestStripeInvoice('org-1', invoice());
    await ledger.ingestStripeInvoice('org-1', invoice({ id: 'in_void', status: 'void', amount_paid: 0 }));
    await ledger.ingestStripeInvoice('org-1', invoice({ id: 'in_unc', status: 'uncollectible', amount_paid: 0 }));

    const account = await ledger.getBillingSummary('org-1');
    expect(account.totals).toMatchObject({ grossBilledCents: 4900, netBilledCents: 4900 });
    expect(account.invoiceCount).toBe(1);
    expect(account.timeline).toHaveLength(1);

    const admin = await ledger.getAdminBillingSummary();
    expect(admin.totals).toMatchObject({ grossBilledCents: 4900, netBilledCents: 4900 });
    expect(admin.byOrg).toEqual([expect.objectContaining({ orgId: 'org-1', netBilledCents: 4900, invoiceCount: 1 })]);
  });
});
