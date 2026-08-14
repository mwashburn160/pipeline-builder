// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the Stripe reversal webhook handlers (charge.refunded /
 * charge.dispute.created / invoice.voided / invoice.marked_uncollectible). Each
 * reverses the billing-ledger row and claws back promotion credits granted inside
 * the clawback window. The handlers are exported and driven directly (the route's
 * `instanceof StripeProvider` guard blocks the full dispatch under mocks — mirrors
 * stripe-webhook.test.ts's approach).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn((_res: unknown, status: number, data: unknown) => ({ status, data })),
  sendError: jest.fn((_res: unknown, status: number, msg: string) => ({ status, msg })),
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({ incCounter: jest.fn() }));

// billing-helpers — only createBillingEvent is exercised by the reversal tail; the
// rest are stubbed so the module's heavy config graph never loads.
const mockCreateBillingEvent = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  createBillingEvent: (...a: unknown[]) => mockCreateBillingEvent(...a),
  applyPlanTierChange: () => async () => undefined,
  applyTierIncludedAddonPrune: () => [],
  syncEntitlements: async () => true,
  calculatePeriodEnd: () => new Date('2026-09-01'),
  billingServiceAuth: () => 'Bearer svc',
}));

const mockIngestStripeInvoice = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const mockReverseLedgerInvoice = jest.fn<(...a: unknown[]) => Promise<string | null>>().mockResolvedValue('org-1');
jest.unstable_mockModule('../src/helpers/billing-ledger.js', () => ({
  ingestStripeInvoice: (...a: unknown[]) => mockIngestStripeInvoice(...a),
  reverseLedgerInvoice: (...a: unknown[]) => mockReverseLedgerInvoice(...a),
}));

jest.unstable_mockModule('../src/helpers/discount-helpers.js', () => ({
  clearDiscountsOnCancel: jest.fn(),
  reconcileDiscountsOnInvoice: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
}));

const mockClawback = jest.fn<(...a: unknown[]) => Promise<number>>().mockResolvedValue(0);
jest.unstable_mockModule('../src/helpers/promotion-engine.js', () => ({
  clawbackRecentPromotions: (...a: unknown[]) => mockClawback(...a),
  grantRecurringPromotions: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
  qualifyReferral: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
  recurringPeriodKey: () => '2026-08',
}));

const mockFindByStripeId = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFindByCustomerId = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/helpers/stripe-helpers.js', () => ({
  findSubscriptionByStripeId: (...a: unknown[]) => mockFindByStripeId(...a),
  findSubscriptionByCustomerId: (...a: unknown[]) => mockFindByCustomerId(...a),
  mapStripeStatus: (s: string) => s,
}));

// The dispute handler resolves the Stripe client via `getPaymentProvider()
// instanceof StripeProvider`, so the provider mock must BE an instance of the
// mocked StripeProvider and expose getStripeClient() → { charges.retrieve }.
const mockChargesRetrieve = jest.fn<(...a: unknown[]) => Promise<unknown>>();
class MockStripeProvider { getStripeClient() { return { charges: { retrieve: (...a: unknown[]) => mockChargesRetrieve(...a) } }; } }
jest.unstable_mockModule('../src/config.js', () => ({ config: { paymentGracePeriodDays: 7, stripe: { priceToPlanMap: {} } } }));
jest.unstable_mockModule('../src/models/plan.js', () => ({ Plan: { findById: jest.fn(), findOne: jest.fn() } }));
jest.unstable_mockModule('../src/models/webhook-dedupe.js', () => ({ claimWebhookEvent: jest.fn(), markWebhookEventDone: jest.fn(), releaseWebhookEvent: jest.fn() }));
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({ getPaymentProvider: () => new MockStripeProvider() }));
jest.unstable_mockModule('../src/providers/stripe-provider.js', () => ({ StripeProvider: MockStripeProvider }));

const { handleChargeRefunded, handleChargeDisputeCreated, handleInvoiceReversal } = await import('../src/routes/stripe-webhook.js');

/** A subscription doc with a spied `.save()` (which must NOT be called by reversals). */
function subDoc(over: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'sub-1' },
    orgId: 'org-1',
    creditBalanceCents: 0,
    creditLedger: [] as unknown[],
    save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReverseLedgerInvoice.mockResolvedValue('org-1');
  mockClawback.mockResolvedValue(0);
});

describe('charge.refunded', () => {
  it('reverses the ledger with net-of-refund amount and claws back recent promotions', async () => {
    const sub = subDoc();
    mockFindByCustomerId.mockResolvedValue(sub);
    mockClawback.mockResolvedValue(2);

    await handleChargeRefunded({ id: 'ch_1', invoice: 'in_1', customer: 'cus_1', amount: 4900, amount_refunded: 4900, refunded: true } as any);

    // Ledger reversed as 'refunded' with net paid = amount − amount_refunded = 0.
    expect(mockReverseLedgerInvoice).toHaveBeenCalledWith('in_1', 'refunded', 0);
    // Subscription resolved by CUSTOMER id (a charge has no subscription ref).
    expect(mockFindByCustomerId).toHaveBeenCalledWith('cus_1');
    expect(mockClawback).toHaveBeenCalledWith(sub);
    // A save must NOT happen — clawback persists via atomic $pull/$inc.
    expect(sub.save).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_updated',
      expect.objectContaining({ reason: 'invoice_refunded', clawedPromotions: 2, fullyRefunded: true, invoiceId: 'in_1' }),
      'sub-1',
    );
  });

  it('handles a PARTIAL refund — net paid = amount − amount_refunded', async () => {
    mockFindByCustomerId.mockResolvedValue(subDoc());
    await handleChargeRefunded({ id: 'ch_2', invoice: 'in_2', customer: 'cus_1', amount: 4900, amount_refunded: 1000, refunded: false } as any);
    expect(mockReverseLedgerInvoice).toHaveBeenCalledWith('in_2', 'refunded', 3900);
  });

  it('reverses the ledger but skips clawback when no local subscription matches', async () => {
    mockFindByCustomerId.mockResolvedValue(null);
    await handleChargeRefunded({ id: 'ch_3', invoice: 'in_3', customer: 'cus_x', amount: 4900, amount_refunded: 4900 } as any);
    expect(mockReverseLedgerInvoice).toHaveBeenCalledWith('in_3', 'refunded', 0);
    expect(mockClawback).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).not.toHaveBeenCalled();
  });

  it('skips the ledger reversal for a charge with no invoice (non-subscription charge)', async () => {
    mockFindByCustomerId.mockResolvedValue(subDoc());
    await handleChargeRefunded({ id: 'ch_4', invoice: null, customer: 'cus_1', amount: 500, amount_refunded: 500 } as any);
    expect(mockReverseLedgerInvoice).not.toHaveBeenCalled();
    // Still claws back on the resolved subscription.
    expect(mockClawback).toHaveBeenCalled();
  });
});

describe('charge.dispute.created', () => {
  it('re-fetches the disputed charge, reverses the ledger, and claws back', async () => {
    mockChargesRetrieve.mockResolvedValue({ id: 'ch_d', invoice: 'in_d', customer: 'cus_1', amount: 4900 });
    mockFindByCustomerId.mockResolvedValue(subDoc());

    await handleChargeDisputeCreated({ id: 'dp_1', charge: 'ch_d', amount: 4900, status: 'warning_needs_response' } as any);

    expect(mockChargesRetrieve).toHaveBeenCalledWith('ch_d');
    // Net paid = charge.amount − dispute.amount = 0; status 'disputed'.
    expect(mockReverseLedgerInvoice).toHaveBeenCalledWith('in_d', 'disputed', 0);
    expect(mockClawback).toHaveBeenCalled();
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_updated',
      expect.objectContaining({ reason: 'invoice_disputed', disputedCents: 4900, disputeStatus: 'warning_needs_response' }),
      'sub-1',
    );
  });

  it('no-ops when the dispute carries no charge id', async () => {
    await handleChargeDisputeCreated({ id: 'dp_2', charge: null, amount: 100 } as any);
    expect(mockChargesRetrieve).not.toHaveBeenCalled();
    expect(mockReverseLedgerInvoice).not.toHaveBeenCalled();
    expect(mockClawback).not.toHaveBeenCalled();
  });
});

describe('invoice.voided / invoice.marked_uncollectible', () => {
  const voidedInvoice = (over: Record<string, unknown> = {}) => ({
    id: 'in_v',
    status: 'void',
    amount_paid: 0,
    parent: { subscription_details: { subscription: 'sub_ext' } },
    lines: { data: [{ period: { start: 1000, end: 2000 } }] },
    ...over,
  });

  it('re-ingests the reversed invoice (flips status via mapInvoiceStatus) and claws back', async () => {
    const sub = subDoc();
    mockFindByStripeId.mockResolvedValue(sub);
    mockClawback.mockResolvedValue(1);

    await handleInvoiceReversal(voidedInvoice() as any, 'invoice_voided');

    expect(mockFindByStripeId).toHaveBeenCalledWith('sub_ext');
    // Re-ingest with the org so the row status flips to void via mapInvoiceStatus.
    expect(mockIngestStripeInvoice).toHaveBeenCalledWith('org-1', expect.objectContaining({ id: 'in_v', status: 'void' }));
    expect(mockClawback).toHaveBeenCalledWith(sub);
    expect(sub.save).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_updated',
      expect.objectContaining({ reason: 'invoice_voided', clawedPromotions: 1 }),
      'sub-1',
    );
  });

  it('marked_uncollectible follows the same reversal path', async () => {
    mockFindByStripeId.mockResolvedValue(subDoc());
    await handleInvoiceReversal(voidedInvoice({ id: 'in_u', status: 'uncollectible' }) as any, 'invoice_uncollectible');
    expect(mockIngestStripeInvoice).toHaveBeenCalledWith('org-1', expect.objectContaining({ status: 'uncollectible' }));
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-1', 'subscription_updated', expect.objectContaining({ reason: 'invoice_uncollectible' }), 'sub-1');
  });

  it('falls back to a status-only ledger flip when no local subscription matches', async () => {
    mockFindByStripeId.mockResolvedValue(null);
    await handleInvoiceReversal(voidedInvoice({ id: 'in_orphan', status: 'uncollectible' }) as any, 'invoice_uncollectible');
    // No org to re-ingest with — flip the existing row's status directly.
    expect(mockIngestStripeInvoice).not.toHaveBeenCalled();
    expect(mockReverseLedgerInvoice).toHaveBeenCalledWith('in_orphan', 'uncollectible', 0);
    expect(mockClawback).not.toHaveBeenCalled();
  });

  it('is fail-soft: a clawback error still records the reversal event', async () => {
    mockFindByStripeId.mockResolvedValue(subDoc());
    mockClawback.mockRejectedValue(new Error('db down'));
    await handleInvoiceReversal(voidedInvoice() as any, 'invoice_voided');
    // clawedPromotions defaults to 0 on failure; the event still fires.
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-1', 'subscription_updated', expect.objectContaining({ reason: 'invoice_voided', clawedPromotions: 0 }), 'sub-1');
  });
});
