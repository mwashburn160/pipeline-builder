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
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn((_res: unknown, status: number, data: unknown) => ({ status, data })),
  sendError: jest.fn((_res: unknown, status: number, msg: string) => ({ status, msg })),
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: jest.fn() }));

// billing-helpers — only createBillingEvent is exercised by the reversal tail; the
// rest are stubbed so the module's heavy config graph never loads.
const mockCreateBillingEvent = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  recordReactivatePlanMissing: async () => undefined,
  createBillingEvent: (...a: unknown[]) => mockCreateBillingEvent(...a),
  calculatePeriodEnd: () => new Date('2026-09-01'),
  billingServiceAuth: () => 'Bearer svc',
}));

jest.unstable_mockModule('../src/helpers/entitlement-sync.js', () => ({
  syncEntitlements: async () => true,
}));
jest.unstable_mockModule('../src/helpers/addon-prune.js', () => ({
  applyPlanTierChange: () => async () => undefined,
  applyTierIncludedAddonPrune: () => [],
  finalizePrunedAddons: async () => undefined,
}));

const mockIngestStripeInvoice = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const mockRestoreDisputed = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const mockReverseLedgerInvoice = jest.fn<(...a: unknown[]) => Promise<string | null>>().mockResolvedValue('org-1');
jest.unstable_mockModule('../src/helpers/billing-ledger.js', () => ({
  ingestStripeInvoice: (...a: unknown[]) => mockIngestStripeInvoice(...a),
  reverseLedgerInvoice: (...a: unknown[]) => mockReverseLedgerInvoice(...a),
  restoreDisputedLedgerInvoice: (...a: unknown[]) => mockRestoreDisputed(...a),
}));

jest.unstable_mockModule('../src/helpers/discount-helpers.js', () => ({
  clearDiscountsOnCancel: jest.fn(),
  reconcileDiscountsOnInvoice: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
}));

const mockRegrant = jest.fn<(...a: unknown[]) => Promise<number>>().mockResolvedValue(0);
const mockClawback = jest.fn<(...a: unknown[]) => Promise<number>>().mockResolvedValue(0);
jest.unstable_mockModule('../src/helpers/promotion-engine.js', () => ({
  clawbackRecentPromotions: (...a: unknown[]) => mockClawback(...a),
  regrantDisputeClawback: (...a: unknown[]) => mockRegrant(...a),
  grantRecurringPromotions: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
  qualifyReferral: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
  evaluatePromotions: jest.fn<(...a: unknown[]) => Promise<unknown[]>>().mockResolvedValue([]),
  processReferralSignup: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
}));

const mockFindByStripeId = jest.fn<(...a: unknown[]) => Promise<unknown>>();
// findReversalSubscription returns { subscription, ambiguous }. This helper defaults
// each test's charge-customer lookup to a single unambiguous match.
const mockFindReversalSub = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/helpers/stripe-helpers.js', () => ({
  findSubscriptionByStripeId: (...a: unknown[]) => mockFindByStripeId(...a),
  findReversalSubscription: (...a: unknown[]) => mockFindReversalSub(...a),
  // Shared by the webhook route and stripe-reversals (moved here so both can
  // read an invoice's subscription id); the real implementation is trivial.
  invoiceSubscriptionId: (invoice: { parent?: { subscription_details?: { subscription?: unknown } } }) => {
    const sub = invoice?.parent?.subscription_details?.subscription;
    return typeof sub === 'string' ? sub : (sub as { id?: string } | undefined)?.id;
  },
  mapStripeStatus: (s: string) => s,
}));

// The dispute handler resolves the Stripe client via `getPaymentProvider()
// instanceof StripeProvider`, so the provider mock must BE an instance of the
// mocked StripeProvider and expose getStripeClient() → { charges.retrieve }.
const mockChargesRetrieve = jest.fn<(...a: unknown[]) => Promise<unknown>>();
// A charge names its invoice only through the InvoicePayment on its
// PaymentIntent; this stand-in maps `pi_X` to `in_X`.
const mockInvoicePaymentsList = jest.fn<(...a: unknown[]) => Promise<unknown>>();
// The created handler re-reads the dispute; by default it is still open.
const mockDisputesRetrieve = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const invoiceForPaymentIntent = async (params: unknown) => {
  const pi = (params as { payment: { payment_intent: string } }).payment.payment_intent;
  return { data: [{ invoice: pi.replace('pi_', 'in_') }] };
};
class MockStripeProvider {
  getStripeClient() {
    return {
      charges: { retrieve: (...a: unknown[]) => mockChargesRetrieve(...a) },
      invoicePayments: { list: (...a: unknown[]) => mockInvoicePaymentsList(...a) },
      disputes: { retrieve: (...a: unknown[]) => mockDisputesRetrieve(...a) },
    };
  }
}
jest.unstable_mockModule('../src/config.js', () => ({ config: { paymentGracePeriodDays: 7, stripe: { priceToPlanMap: {} } } }));
jest.unstable_mockModule('../src/models/plan.js', () => ({ Plan: { findById: jest.fn(), findOne: jest.fn() } }));
jest.unstable_mockModule('../src/models/webhook-dedupe.js', () => ({ claimWebhookEvent: jest.fn(), markWebhookEventDone: jest.fn(), releaseWebhookEvent: jest.fn(), webhookEventStatus: jest.fn() }));
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({ getPaymentProvider: () => new MockStripeProvider() }));
jest.unstable_mockModule('../src/providers/stripe-provider.js', () => ({ StripeProvider: MockStripeProvider }));

const { handleChargeRefunded, handleChargeDisputeCreated, handleChargeDisputeClosed, handleInvoiceReversal } = await import('../src/helpers/stripe-reversals.js');

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
  mockInvoicePaymentsList.mockImplementation(invoiceForPaymentIntent);
  mockDisputesRetrieve.mockImplementation(async (id: unknown) => ({ id, status: 'needs_response' }));
  mockClawback.mockResolvedValue(0);
});

describe('charge.refunded', () => {
  it('reverses the ledger with net-of-refund amount and claws back recent promotions', async () => {
    const sub = subDoc();
    mockFindReversalSub.mockResolvedValue({ subscription: sub, ambiguous: false });
    mockClawback.mockResolvedValue(2);

    await handleChargeRefunded({ id: 'ch_1', payment_intent: 'pi_1', customer: 'cus_1', amount: 4900, amount_refunded: 4900, refunded: true } as any);

    // Ledger reversed as 'refunded' with net paid = amount − amount_refunded = 0.
    expect(mockReverseLedgerInvoice).toHaveBeenCalledWith('in_1', 'refunded', 0);
    // Subscription resolved by CUSTOMER id (a charge has no subscription ref).
    expect(mockFindReversalSub).toHaveBeenCalledWith('cus_1');
    expect(mockClawback).toHaveBeenCalledWith(sub);
    // A save must NOT happen — clawback persists via atomic $pull/$inc.
    expect(sub.save).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_updated',
      expect.objectContaining({ reason: 'invoice_refunded', clawedPromotions: 2, fullyRefunded: true, invoiceId: 'in_1' }),
      'sub-1',
    );
  });

  it('finds the invoice through the InvoicePayment on the charge\'s PaymentIntent (a Charge has no `invoice`)', async () => {
    mockFindReversalSub.mockResolvedValue({ subscription: subDoc(), ambiguous: false });
    await handleChargeRefunded({ id: 'ch_pi', payment_intent: 'pi_9', customer: 'cus_1', amount: 100, amount_refunded: 100 } as any);
    expect(mockInvoicePaymentsList).toHaveBeenCalledWith({ payment: { type: 'payment_intent', payment_intent: 'pi_9' }, limit: 1 });
    expect(mockReverseLedgerInvoice).toHaveBeenCalledWith('in_9', 'refunded', 0);
  });

  it('skips the ledger reversal when the PaymentIntent paid no invoice', async () => {
    mockFindReversalSub.mockResolvedValue({ subscription: subDoc(), ambiguous: false });
    mockInvoicePaymentsList.mockResolvedValueOnce({ data: [] });
    await handleChargeRefunded({ id: 'ch_one_off', payment_intent: 'pi_x', customer: 'cus_1', amount: 100, amount_refunded: 100 } as any);
    expect(mockReverseLedgerInvoice).not.toHaveBeenCalled();
    expect(mockClawback).toHaveBeenCalled();
  });

  it('RE-THROWS an invoice-payment lookup failure so Stripe redelivers the refund', async () => {
    mockInvoicePaymentsList.mockRejectedValueOnce(new Error('stripe 503'));
    await expect(
      handleChargeRefunded({ id: 'ch_err', payment_intent: 'pi_e', customer: 'cus_1', amount: 100, amount_refunded: 100 } as any),
    ).rejects.toThrow('stripe 503');
    expect(mockReverseLedgerInvoice).not.toHaveBeenCalled();
    expect(mockClawback).not.toHaveBeenCalled();
  });

  it('handles a PARTIAL refund — net paid = amount − amount_refunded', async () => {
    mockFindReversalSub.mockResolvedValue({ subscription: subDoc(), ambiguous: false });
    await handleChargeRefunded({ id: 'ch_2', payment_intent: 'pi_2', customer: 'cus_1', amount: 4900, amount_refunded: 1000, refunded: false } as any);
    expect(mockReverseLedgerInvoice).toHaveBeenCalledWith('in_2', 'refunded', 3900);
  });

  it('does NOT claw back promotions on a PARTIAL refund (still records the reversal)', async () => {
    // A goodwill/proration refund is not a subscribe-grab-refund; promotion grants
    // have no invoice link, so clawing back on any refund stripped every recent grant.
    mockFindReversalSub.mockResolvedValue({ subscription: subDoc(), ambiguous: false });
    await handleChargeRefunded({ id: 'ch_p', payment_intent: 'pi_2', customer: 'cus_1', amount: 4900, amount_refunded: 1000, refunded: false } as any);
    expect(mockClawback).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_updated',
      expect.objectContaining({ reason: 'invoice_refunded', clawedPromotions: 0, clawbackSkipped: 'partial_reversal', fullyRefunded: false }),
      'sub-1',
    );
  });

  it('claws back once a topped-up refund makes the cumulative amount_refunded FULL', async () => {
    mockFindReversalSub.mockResolvedValue({ subscription: subDoc(), ambiguous: false });
    await handleChargeRefunded({ id: 'ch_p', payment_intent: 'pi_2', customer: 'cus_1', amount: 4900, amount_refunded: 4900, refunded: false } as any);
    expect(mockClawback).toHaveBeenCalled();
  });

  it('reverses the ledger but skips clawback when no local subscription matches', async () => {
    mockFindReversalSub.mockResolvedValue({ subscription: null, ambiguous: false });
    await handleChargeRefunded({ id: 'ch_3', payment_intent: 'pi_3', customer: 'cus_x', amount: 4900, amount_refunded: 4900 } as any);
    expect(mockReverseLedgerInvoice).toHaveBeenCalledWith('in_3', 'refunded', 0);
    expect(mockClawback).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).not.toHaveBeenCalled();
  });

  it('reverses the ledger but SKIPS clawback when the customer has multiple subs (ambiguous attribution)', async () => {
    // cancel→resubscribe: newest-by-customer could be a different sub than the one
    // this charge belongs to, so the sub-scoped clawback must be skipped (the
    // invoice-keyed ledger reversal still runs).
    mockFindReversalSub.mockResolvedValue({ subscription: null, ambiguous: true });
    await handleChargeRefunded({ id: 'ch_a', payment_intent: 'pi_a', customer: 'cus_multi', amount: 4900, amount_refunded: 4900 } as any);
    expect(mockReverseLedgerInvoice).toHaveBeenCalledWith('in_a', 'refunded', 0);
    expect(mockClawback).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).not.toHaveBeenCalled();
  });

  it('skips the ledger reversal for a charge with no invoice (non-subscription charge)', async () => {
    mockFindReversalSub.mockResolvedValue({ subscription: subDoc(), ambiguous: false });
    await handleChargeRefunded({ id: 'ch_4', payment_intent: null, customer: 'cus_1', amount: 500, amount_refunded: 500 } as any);
    expect(mockReverseLedgerInvoice).not.toHaveBeenCalled();
    // Still claws back on the resolved subscription.
    expect(mockClawback).toHaveBeenCalled();
  });
});

describe('charge.dispute.created', () => {
  it('re-fetches the disputed charge, reverses the ledger, and claws back', async () => {
    mockChargesRetrieve.mockResolvedValue({ id: 'ch_d', payment_intent: 'pi_d', customer: 'cus_1', amount: 4900 });
    mockFindReversalSub.mockResolvedValue({ subscription: subDoc(), ambiguous: false });

    await handleChargeDisputeCreated({ id: 'dp_1', charge: 'ch_d', amount: 4900, status: 'warning_needs_response' } as any);

    expect(mockChargesRetrieve).toHaveBeenCalledWith('ch_d');
    // Net paid = charge.amount − dispute.amount = 0; status 'disputed'.
    expect(mockReverseLedgerInvoice).toHaveBeenCalledWith('in_d', 'disputed', 0);
    // The clawback is tagged with the dispute, so a WON dispute can re-grant exactly it.
    expect(mockClawback).toHaveBeenCalledWith(expect.anything(), undefined, 'dispute:dp_1');
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_updated',
      expect.objectContaining({ reason: 'invoice_disputed', disputedCents: 4900, disputeStatus: 'warning_needs_response' }),
      'sub-1',
    );
  });

  it('does NOT claw back on a PARTIAL dispute (dispute.amount < charge.amount)', async () => {
    mockChargesRetrieve.mockResolvedValue({ id: 'ch_d', payment_intent: 'pi_d', customer: 'cus_1', amount: 4900 });
    mockFindReversalSub.mockResolvedValue({ subscription: subDoc(), ambiguous: false });

    await handleChargeDisputeCreated({ id: 'dp_p', charge: 'ch_d', amount: 1000, status: 'needs_response' } as any);

    expect(mockReverseLedgerInvoice).toHaveBeenCalledWith('in_d', 'disputed', 3900);
    expect(mockClawback).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_updated',
      expect.objectContaining({ reason: 'invoice_disputed', clawbackSkipped: 'partial_reversal' }),
      'sub-1',
    );
  });

  it('counts an earlier partial REFUND: refund + dispute of the rest is a full reversal', async () => {
    // Refund 1900, then dispute the remaining 3000 (Stripe disputes what is left).
    // Net still collected is 0, and nothing of the payment stays with us, so the
    // subscribe-grab-refund clawback must fire — splitting the reversal into a
    // partial refund plus a partial dispute must not bypass it.
    mockChargesRetrieve.mockResolvedValue({ id: 'ch_d', payment_intent: 'pi_d', customer: 'cus_1', amount: 4900, amount_refunded: 1900 });
    mockFindReversalSub.mockResolvedValue({ subscription: subDoc(), ambiguous: false });

    await handleChargeDisputeCreated({ id: 'dp_r', charge: 'ch_d', amount: 3000, status: 'needs_response' } as any);

    expect(mockReverseLedgerInvoice).toHaveBeenCalledWith('in_d', 'disputed', 0);
    expect(mockClawback).toHaveBeenCalled();
  });

  it('a created event processed AFTER the dispute was won (late redelivery) reverses nothing', async () => {
    mockDisputesRetrieve.mockResolvedValue({ id: 'dp_late', status: 'won' });
    mockChargesRetrieve.mockResolvedValue({ id: 'ch_d', payment_intent: 'pi_d', customer: 'cus_1', amount: 4900 });
    mockFindReversalSub.mockResolvedValue({ subscription: subDoc(), ambiguous: false });

    await handleChargeDisputeCreated({ id: 'dp_late', charge: 'ch_d', amount: 4900, status: 'needs_response' } as any);

    expect(mockDisputesRetrieve).toHaveBeenCalledWith('dp_late');
    expect(mockReverseLedgerInvoice).not.toHaveBeenCalled();
    expect(mockClawback).not.toHaveBeenCalled();
  });

  it('RE-THROWS a dispute re-read failure so Stripe redelivers', async () => {
    mockDisputesRetrieve.mockRejectedValue(new Error('stripe 503'));
    await expect(handleChargeDisputeCreated({ id: 'dp_e', charge: 'ch_d', amount: 4900, status: 'needs_response' } as any)).rejects.toThrow('stripe 503');
    expect(mockReverseLedgerInvoice).not.toHaveBeenCalled();
  });

  it('no-ops when the dispute carries no charge id', async () => {
    await handleChargeDisputeCreated({ id: 'dp_2', charge: null, amount: 100 } as any);
    expect(mockChargesRetrieve).not.toHaveBeenCalled();
    expect(mockReverseLedgerInvoice).not.toHaveBeenCalled();
    expect(mockClawback).not.toHaveBeenCalled();
  });

  it('RE-THROWS a charge-retrieve failure so Stripe redelivers (no partial reversal)', async () => {
    // The ledger reversal + promotion clawback are all-or-nothing on this fetch, so
    // a transient retrieve failure must propagate: the dispatcher then 500s and
    // Stripe redelivers over its retry window. Swallowing it (200) would tell Stripe
    // "done" and permanently skip the reversal. No event row is written per attempt.
    mockChargesRetrieve.mockRejectedValue(new Error('stripe 503'));

    await expect(
      handleChargeDisputeCreated({ id: 'dp_3', charge: 'ch_x', amount: 4900, status: 'needs_response' } as any),
    ).rejects.toThrow('stripe 503');

    expect(mockChargesRetrieve).toHaveBeenCalledWith('ch_x');
    // Nothing partial ran, and no billing event was appended (a retry would dup it).
    expect(mockReverseLedgerInvoice).not.toHaveBeenCalled();
    expect(mockClawback).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).not.toHaveBeenCalled();
  });
});

describe('charge.dispute.closed', () => {
  it('WON: restores the ledger row to paid with the disputed amount and re-grants the clawed-back credit', async () => {
    mockChargesRetrieve.mockResolvedValue({ id: 'ch_d', payment_intent: 'pi_d', customer: 'cus_1', amount: 4900, amount_refunded: 0 });
    const sub = subDoc();
    mockFindReversalSub.mockResolvedValue({ subscription: sub, ambiguous: false });
    mockRegrant.mockResolvedValue(1);

    await handleChargeDisputeClosed({ id: 'dp_1', charge: 'ch_d', amount: 4900, status: 'won' } as any);

    expect(mockRestoreDisputed).toHaveBeenCalledWith('in_d', 'paid', 4900);
    expect(mockRegrant).toHaveBeenCalledWith(sub, 'dp_1');
    expect(mockReverseLedgerInvoice).not.toHaveBeenCalled();
    expect(mockClawback).not.toHaveBeenCalled();
    expect(sub.save).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_updated',
      expect.objectContaining({ reason: 'invoice_dispute_won', disputeId: 'dp_1', invoiceId: 'in_d', regrantedPromotions: 1 }),
      'sub-1',
    );
  });

  it('WON after an earlier refund: the row returns to refunded with the refund still counted', async () => {
    mockChargesRetrieve.mockResolvedValue({ id: 'ch_d', payment_intent: 'pi_d', customer: 'cus_1', amount: 4900, amount_refunded: 1900 });
    mockFindReversalSub.mockResolvedValue({ subscription: subDoc(), ambiguous: false });

    await handleChargeDisputeClosed({ id: 'dp_r', charge: 'ch_d', amount: 3000, status: 'won' } as any);

    expect(mockRestoreDisputed).toHaveBeenCalledWith('in_d', 'refunded', 3000);
  });

  it.each(['lost', 'warning_closed'])('%s: changes nothing', async (status) => {
    await handleChargeDisputeClosed({ id: 'dp_l', charge: 'ch_d', amount: 4900, status } as any);

    expect(mockChargesRetrieve).not.toHaveBeenCalled();
    expect(mockRestoreDisputed).not.toHaveBeenCalled();
    expect(mockRegrant).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).not.toHaveBeenCalled();
  });

  it('WON with an ambiguous subscription restores the ledger but re-grants nothing', async () => {
    mockChargesRetrieve.mockResolvedValue({ id: 'ch_d', payment_intent: 'pi_d', customer: 'cus_1', amount: 4900 });
    mockFindReversalSub.mockResolvedValue({ subscription: null, ambiguous: true });

    await handleChargeDisputeClosed({ id: 'dp_a', charge: 'ch_d', amount: 4900, status: 'won' } as any);

    expect(mockRestoreDisputed).toHaveBeenCalledWith('in_d', 'paid', 4900);
    expect(mockRegrant).not.toHaveBeenCalled();
  });

  it('RE-THROWS a charge-retrieve failure so Stripe redelivers', async () => {
    mockChargesRetrieve.mockRejectedValue(new Error('stripe 503'));
    await expect(handleChargeDisputeClosed({ id: 'dp_x', charge: 'ch_x', amount: 4900, status: 'won' } as any)).rejects.toThrow('stripe 503');
    expect(mockRestoreDisputed).not.toHaveBeenCalled();
    expect(mockRegrant).not.toHaveBeenCalled();
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
