// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * helpers/stripe-reversals.ts — the edge branches stripe-reversals.test.ts
 * leaves out: expanded (object) Stripe references, charges without an invoice
 * or customer, missing amounts, a dispute when the Stripe client is not the
 * active provider, a failing reverse-ingest (fail-soft, clawback still runs),
 * and an out-of-band invoice reversal (uncollectible vs void; no id at all).
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock, loggerMock } from './helpers/mock-api-core.js';

const logger = loggerMock();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ createLogger: () => logger }));
const incCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter }));

const createBillingEvent = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({ createBillingEvent }));
const ingestStripeInvoice = jest.fn<AnyFn>(async () => undefined);
const reverseLedgerInvoice = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('../src/helpers/billing-ledger.js', () => ({ ingestStripeInvoice, reverseLedgerInvoice }));
const clawbackRecentPromotions = jest.fn<AnyFn>(async () => 1);
jest.unstable_mockModule('../src/helpers/promotion-engine.js', () => ({ clawbackRecentPromotions }));
const findReversalSubscription = jest.fn<AnyFn>();
const findSubscriptionByStripeId = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/stripe-helpers.js', () => ({
  findReversalSubscription,
  findSubscriptionByStripeId,
  invoiceSubscriptionId: (inv: { subscription?: string }) => inv.subscription,
}));

class StripeProvider {
  constructor(readonly client: unknown) {}
  getStripeClient() { return this.client; }
}
let activeProvider: unknown;
jest.unstable_mockModule('../src/providers/stripe-provider.js', () => ({ StripeProvider }));
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({ getPaymentProvider: () => activeProvider }));

const { handleChargeRefunded, handleChargeDisputeCreated, handleInvoiceReversal } = await import('../src/helpers/stripe-reversals.js');

const sub = { _id: { toString: () => 'sub_1' }, orgId: 'org_1' };

beforeEach(() => {
  jest.clearAllMocks();
  findReversalSubscription.mockResolvedValue({ subscription: sub, ambiguous: false });
  findSubscriptionByStripeId.mockResolvedValue(sub);
});

describe('charge reversals', () => {
  it('reads EXPANDED invoice/customer objects, and treats missing amounts as 0', async () => {
    await handleChargeRefunded({ id: 'ch_1', invoice: { id: 'in_1' }, customer: { id: 'cus_1' } } as any);
    expect(reverseLedgerInvoice).toHaveBeenCalledWith('in_1', 'refunded', 0);
    expect(findReversalSubscription).toHaveBeenCalledWith('cus_1');
    expect(createBillingEvent).toHaveBeenCalledWith('org_1', 'subscription_updated', expect.objectContaining({ reason: 'invoice_refunded', refundedCents: 0, fullyRefunded: false, invoiceId: 'in_1', clawedPromotions: 1 }), 'sub_1');
  });

  it('a charge with no invoice skips the ledger, one with no customer skips the clawback', async () => {
    await handleChargeRefunded({ id: 'ch_2', amount: 100, amount_refunded: 100, refunded: true, customer: { notAnId: 1 } } as any);
    expect(reverseLedgerInvoice).not.toHaveBeenCalled();
    expect(findReversalSubscription).not.toHaveBeenCalled();
    expect(clawbackRecentPromotions).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('without a matching local subscription'), expect.objectContaining({ chargeId: 'ch_2' }));
  });

  it('a clawback failure is fail-soft: the reversal is still recorded with 0 clawed', async () => {
    clawbackRecentPromotions.mockRejectedValueOnce(new Error('mongo blip'));
    await handleChargeRefunded({ id: 'ch_3', amount: 500, amount_refunded: 200, invoice: 'in_3', customer: 'cus_3' } as any);
    expect(reverseLedgerInvoice).toHaveBeenCalledWith('in_3', 'refunded', 300);
    expect(createBillingEvent).toHaveBeenCalledWith('org_1', 'subscription_updated', expect.objectContaining({ clawedPromotions: 0 }), 'sub_1');
  });
});

describe('disputes', () => {
  it('cannot resolve the charge when Stripe is not the active provider', async () => {
    activeProvider = { usageCreditSupport: 'none' };
    await handleChargeDisputeCreated({ id: 'dp_1', charge: { id: 'ch_1' } } as any);
    expect(logger.warn).toHaveBeenCalledWith('Stripe client unavailable — cannot resolve disputed charge', { disputeId: 'dp_1', chargeId: 'ch_1' });
    expect(reverseLedgerInvoice).not.toHaveBeenCalled();
  });

  it('cannot resolve it either when the Stripe provider has no client', async () => {
    activeProvider = new StripeProvider(null);
    await handleChargeDisputeCreated({ id: 'dp_2', charge: 'ch_2' } as any);
    expect(reverseLedgerInvoice).not.toHaveBeenCalled();
  });

  it('treats a missing charge or dispute amount as 0 (net never negative)', async () => {
    const retrieve = jest.fn<AnyFn>(async () => ({ id: 'ch_4', invoice: 'in_4', customer: 'cus_4' }));
    activeProvider = new StripeProvider({ charges: { retrieve } });
    await handleChargeDisputeCreated({ id: 'dp_4', charge: 'ch_4', status: 'needs_response' } as any);
    expect(reverseLedgerInvoice).toHaveBeenCalledWith('in_4', 'disputed', 0);
    expect(createBillingEvent).toHaveBeenCalledWith('org_1', 'subscription_updated', expect.objectContaining({ disputedCents: 0, disputeStatus: 'needs_response' }), 'sub_1');
  });
});

describe('invoice-level reversals', () => {
  it('a failing reverse-ingest is fail-soft: the clawback still runs', async () => {
    ingestStripeInvoice.mockRejectedValueOnce(new Error('ledger down'));
    await handleInvoiceReversal({ id: 'in_5', status: 'void', subscription: 'sub_stripe' } as any, 'invoice_voided');
    expect(logger.warn).toHaveBeenCalledWith('Ledger reverse-ingest failed', expect.objectContaining({ invoiceId: 'in_5', error: 'ledger down' }));
    expect(clawbackRecentPromotions).toHaveBeenCalled();
  });

  it.each([
    ['uncollectible', 'uncollectible'],
    ['void', 'void'],
    ['open', 'void'],
  ])('an out-of-band %s invoice flips its ledger row to %s', async (status, expected) => {
    findSubscriptionByStripeId.mockResolvedValue(null);
    await handleInvoiceReversal({ id: 'in_6', status, subscription: 'sub_gone' } as any, 'invoice_voided');
    expect(reverseLedgerInvoice).toHaveBeenCalledWith('in_6', expected, 0);
    expect(clawbackRecentPromotions).not.toHaveBeenCalled();
  });

  it('an invoice with neither a subscription nor an id is only logged', async () => {
    await handleInvoiceReversal({ status: 'void' } as any, 'invoice_voided');
    expect(findSubscriptionByStripeId).not.toHaveBeenCalled();
    expect(reverseLedgerInvoice).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Invoice reversal without a matching local subscription', expect.objectContaining({ reason: 'invoice_voided' }));
  });
});
