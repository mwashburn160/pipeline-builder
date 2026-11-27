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
import { prng } from './helpers/prng.js';

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

  // ── 1b. a WON dispute restores the row (the one way down from disputed) ──

  it('a won dispute restores a disputed row to paid with the disputed amount', async () => {
    await ledger.ingestStripeInvoice('org-1', invoice());
    await ledger.reverseLedgerInvoice('in_1', 'disputed', 0);
    await ledger.restoreDisputedLedgerInvoice('in_1', 'paid', 4900);

    expect(await row()).toMatchObject({ status: 'paid', amountPaidCents: 4900 });
  });

  it('a won dispute on a refunded-then-disputed row returns it to refunded, refund still counted', async () => {
    await ledger.ingestStripeInvoice('org-1', invoice());
    await ledger.reverseLedgerInvoice('in_1', 'refunded', 3000);
    await ledger.reverseLedgerInvoice('in_1', 'disputed', 0);
    await ledger.restoreDisputedLedgerInvoice('in_1', 'refunded', 3000);

    expect(await row()).toMatchObject({ status: 'refunded', amountPaidCents: 3000 });
  });

  it('a won dispute never touches a row that is not disputed (redelivery / no dispute applied)', async () => {
    await ledger.ingestStripeInvoice('org-1', invoice());
    await ledger.reverseLedgerInvoice('in_1', 'refunded', 1000);
    await ledger.restoreDisputedLedgerInvoice('in_1', 'paid', 4900);

    expect(await row()).toMatchObject({ status: 'refunded', amountPaidCents: 1000 });
  });

  it('a won dispute on a BANKED dispute rewrites the bank, so the ingest lands the restored state', async () => {
    await ledger.reverseLedgerInvoice('in_1', 'disputed', 0);
    await ledger.restoreDisputedLedgerInvoice('in_1', 'paid', 4900);
    expect(await BillingPendingReversal.findById('in_1').lean()).toBeNull();
    await ledger.ingestStripeInvoice('org-1', invoice());
    expect(await row()).toMatchObject({ status: 'paid', amountPaidCents: 4900 });

    await BillingInvoice.deleteMany({});
    await ledger.reverseLedgerInvoice('in_1', 'refunded', 3000);
    await ledger.reverseLedgerInvoice('in_1', 'disputed', 0);
    await ledger.restoreDisputedLedgerInvoice('in_1', 'refunded', 3000);
    expect(await BillingPendingReversal.findById('in_1').lean()).toMatchObject({ status: 'refunded', amountPaidCents: 3000 });
    await ledger.ingestStripeInvoice('org-1', invoice());
    expect(await row()).toMatchObject({ status: 'refunded', amountPaidCents: 3000 });
  });

  it('a reversal landing while a re-ingest is in flight is kept (no read-then-write window)', async () => {
    await ledger.ingestStripeInvoice('org-1', invoice());
    // The dispute lands after the re-ingest decided what to write, just before its write.
    const realUpdateOne = BillingInvoice.updateOne.bind(BillingInvoice);
    const spy = jest.spyOn(BillingInvoice, 'updateOne').mockImplementationOnce((async (...args: unknown[]) => {
      await ledger.reverseLedgerInvoice('in_1', 'disputed', 0);
      return realUpdateOne(...args);
    }) as never);
    try {
      await ledger.ingestStripeInvoice('org-1', invoice({ total: 4800 }));
    } finally {
      spy.mockRestore();
    }
    // The reversal stands; everything else still re-synced.
    expect(await row()).toMatchObject({ status: 'disputed', amountPaidCents: 0, totalCents: 4800 });
  });

  // ── 1c. invoice-level status follows Stripe's state machine, not delivery order ──
  //
  // A Stripe invoice moves draft → open → paid | void | uncollectible, and
  // uncollectible → paid | void; paid and void are terminal. Each webhook carries
  // the invoice as it was WHEN the event fired, and Stripe delivers unordered, so
  // an `invoice.marked_uncollectible` snapshot delivered after the `paid` one
  // used to overwrite a paid row back to uncollectible with nothing paid —
  // dropping real revenue out of every summary.

  it('a late uncollectible snapshot never un-pays a paid row', async () => {
    await ledger.ingestStripeInvoice('org-1', invoice());
    await ledger.ingestStripeInvoice('org-1', invoice({ status: 'uncollectible', amount_paid: 0 }));
    expect(await row()).toMatchObject({ status: 'paid', amountPaidCents: 4900 });
  });

  it('a late open (or draft) snapshot never un-pays a paid row', async () => {
    await ledger.ingestStripeInvoice('org-1', invoice());
    await ledger.ingestStripeInvoice('org-1', invoice({ status: 'open', amount_paid: 0 }));
    expect(await row()).toMatchObject({ status: 'paid', amountPaidCents: 4900 });
  });

  it('an uncollectible invoice that is later PAID becomes paid (the legal forward move)', async () => {
    await ledger.ingestStripeInvoice('org-1', invoice({ status: 'uncollectible', amount_paid: 0 }));
    await ledger.ingestStripeInvoice('org-1', invoice());
    expect(await row()).toMatchObject({ status: 'paid', amountPaidCents: 4900 });
  });

  it('void is terminal', async () => {
    await ledger.ingestStripeInvoice('org-1', invoice({ status: 'void', amount_paid: 0 }));
    await ledger.ingestStripeInvoice('org-1', invoice({ status: 'uncollectible', amount_paid: 0 }));
    await ledger.ingestStripeInvoice('org-1', invoice({ status: 'open', amount_paid: 0 }));
    expect(await row()).toMatchObject({ status: 'void', amountPaidCents: 0 });
  });

  // INVARIANT — refund/dispute then re-ingest is idempotent and order-free: for
  // every delivery order (seeded shuffles, with redeliveries), the row converges
  // on the highest-precedence reversal and the LOWEST net still paid.
  it('converges on the same row for every delivery order of ingest / refunds / dispute / re-ingest', async () => {
    type Ev = { kind: 'ingest' } | { kind: 'refund'; net: number } | { kind: 'dispute'; net: number };
    for (let seed = 1; seed <= 40; seed++) {
      await BillingInvoice.deleteMany({});
      await BillingPendingReversal.deleteMany({});
      const r = prng(seed);
      const firstRefundNet = r.int(1, 4899);
      const events: Ev[] = [
        { kind: 'ingest' }, { kind: 'ingest' },
        { kind: 'refund', net: firstRefundNet },
        ...(r.int(0, 1) ? [{ kind: 'refund' as const, net: r.int(0, firstRefundNet) }] : []),
        ...(r.int(0, 1) ? [{ kind: 'dispute' as const, net: 0 }] : []),
      ];
      // Redeliver one event at random, then shuffle (Fisher-Yates on the seed).
      events.push(events[r.int(0, events.length - 1)]);
      for (let i = events.length - 1; i > 0; i--) {
        const j = r.int(0, i);
        [events[i], events[j]] = [events[j], events[i]];
      }
      for (const e of events) {
        if (e.kind === 'ingest') await ledger.ingestStripeInvoice('org-1', invoice());
        else await ledger.reverseLedgerInvoice('in_1', e.kind === 'refund' ? 'refunded' : 'disputed', e.net);
      }
      const reversals = events.filter((e): e is Exclude<Ev, { kind: 'ingest' }> => e.kind !== 'ingest');
      const expected = {
        status: reversals.some((e) => e.kind === 'dispute') ? 'disputed' : 'refunded',
        amountPaidCents: Math.min(...reversals.map((e) => e.net)),
      };
      expect({ seed, row: await row() }).toMatchObject({ seed, row: expected });
      expect({ seed, banked: await BillingPendingReversal.findById('in_1').lean() }).toEqual({ seed, banked: null });
    }
  });

  // ── 2. summaries leave out uncollected invoices ───────────────────────────

  it('the account and admin summaries leave out void and uncollectible invoices', async () => {
    await ledger.ingestStripeInvoice('org-1', invoice());
    await ledger.ingestStripeInvoice('org-1', invoice({ id: 'in_void', status: 'void', amount_paid: 0 }));
    await ledger.ingestStripeInvoice('org-1', invoice({ id: 'in_unc', status: 'uncollectible', amount_paid: 0 }));

    const account = await ledger.getBillingSummary('org-1');
    expect(account.totalsByCurrency).toEqual([expect.objectContaining({ currency: 'usd', grossBilledCents: 4900, netBilledCents: 4900 })]);
    expect(account.invoiceCount).toBe(1);
    expect(account.timeline).toHaveLength(1);

    const admin = await ledger.getAdminBillingSummary();
    expect(admin.totalsByCurrency).toEqual([expect.objectContaining({ currency: 'usd', grossBilledCents: 4900, netBilledCents: 4900 })]);
    expect(admin.byOrg).toEqual([expect.objectContaining({ orgId: 'org-1', currency: 'usd', netBilledCents: 4900, invoiceCount: 1 })]);
  });

  it('groups the account and admin summaries by currency', async () => {
    await ledger.ingestStripeInvoice('org-1', invoice());
    await ledger.ingestStripeInvoice('org-1', invoice({ id: 'in_eur', currency: 'eur', subtotal: 3000, total: 3000, amount_paid: 3000 }));
    await ledger.ingestStripeInvoice('org-2', invoice({ id: 'in_eur2', currency: 'eur', subtotal: 1000, total: 1000, amount_paid: 1000 }));

    const account = await ledger.getBillingSummary('org-1');
    expect(account.totalsByCurrency.map((t: any) => [t.currency, t.grossBilledCents, t.amountPaidCents, t.invoiceCount]))
      .toEqual([['eur', 3000, 3000, 1], ['usd', 4900, 4900, 1]]);
    expect(account.timeline.map((p: any) => p.currency).sort()).toEqual(['eur', 'usd']);

    const admin = await ledger.getAdminBillingSummary();
    expect(admin.totalsByCurrency.map((t: any) => [t.currency, t.grossBilledCents])).toEqual([['eur', 4000], ['usd', 4900]]);
    expect(admin.byOrg.map((o: any) => [o.orgId, o.currency, o.netBilledCents])).toEqual([
      ['org-1', 'usd', 4900], ['org-1', 'eur', 3000], ['org-2', 'eur', 1000],
    ]);
  });
});
