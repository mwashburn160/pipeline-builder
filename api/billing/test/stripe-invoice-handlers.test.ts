// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/stripe-invoice-handlers — the Stripe `invoice.*` money path.
 *
 * This module had NO test. It decides, off a provider webhook and with no
 * authenticated caller, whether an org keeps or loses its paid entitlements. The
 * behaviours pinned here are the ones where a regression costs money or access:
 *
 *  - RECOVERY: a `past_due` sub that pays must go back to `active` AND be
 *    re-granted its tier, with the grace-period dedupe marker cleared so a future
 *    lapse can downgrade again. A missed marker-clear silently pins an org as
 *    "already downgraded" forever.
 *  - DANGLING PLAN: recovery with a deleted planId must not silently no-op — it
 *    records a repair signal.
 *  - PERIOD: the billing window must come from the invoice LINE period (Stripe's
 *    truth, incl. proration), falling back to wall-clock only when absent.
 *  - DUNNING ENTRY IS GUARDED: `payment_failed` for a sub that is already
 *    terminal (`canceled`) or never settled (`incomplete`) must NOT flip it to
 *    `past_due` — that status is entitled, so it would REVIVE a dead
 *    subscription and re-grant its paid tier.
 *  - FAIL-SOFT: promotions, referral qualification and ledger ingest must never
 *    fail the webhook — Stripe would retry and double-apply the money effects.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type Stripe from 'stripe';
import { apiCoreMock } from './helpers/mock-api-core.js';

const sendSystemNotification = jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ sendSystemNotification }));

// --- collaborators ----------------------------------------------------------
const createBillingEvent = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const syncEntitlements = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const recordReactivatePlanMissing = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  createBillingEvent,
  recordReactivatePlanMissing,
}));
jest.unstable_mockModule('../src/helpers/entitlement-sync.js', () => ({
  syncEntitlements,
}));

const ingestStripeInvoice = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../src/helpers/billing-ledger.js', () => ({ ingestStripeInvoice }));

const reconcileDiscountsOnInvoice = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../src/helpers/discount-helpers.js', () => ({ reconcileDiscountsOnInvoice }));

const grantRecurringPromotions = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const qualifyReferral = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../src/helpers/promotion-engine.js', () => ({ grantRecurringPromotions, qualifyReferral }));

const findSubscriptionByStripeId = jest.fn<(id: string) => Promise<Record<string, unknown> | null>>();
jest.unstable_mockModule('../src/helpers/stripe-helpers.js', () => ({
  findSubscriptionByStripeId,
  invoiceSubscriptionId: (inv: { subscription?: string }) => inv.subscription ?? null,
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: { paymentGracePeriodDays: 7, messageService: { host: 'message', port: 3000 } },
}));

// Ordering watermark + the shared "became entitled" grant live with the
// subscription handlers; stub them so this suite drives only the invoice logic.
const acceptStripeEvent = jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
const grantOnBecomingEntitled = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const awaitsLocalRow = jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => false);
jest.unstable_mockModule('../src/helpers/stripe-subscription-handlers.js', () => ({ acceptStripeEvent, awaitsLocalRow, grantOnBecomingEntitled }));

/** Event envelope the webhook route passes every lifecycle handler. */
const EVT = { id: 'evt_1', created: 1767225600 };

const planFindById = jest.fn<(id: unknown) => Promise<{ tier: string } | null>>();
jest.unstable_mockModule('../src/models/plan.js', () => ({ Plan: { findById: planFindById } }));

const { handleInvoiceUpcoming, handlePaymentSucceeded, handlePaymentFailed } =
  await import('../src/helpers/stripe-invoice-handlers.js');

// --- fixtures ---------------------------------------------------------------
type Sub = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function makeSub(over: Partial<Sub> = {}): Sub {
  return {
    _id: { toString: () => 'sub-1' },
    orgId: 'org-1',
    planId: 'plan-1',
    status: 'active',
    interval: 'monthly',
    failedPaymentAttempts: 0,
    firstFailedAt: undefined,
    currentPeriodStart: new Date('2026-08-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
    addons: [],
    metadata: {},
    save: jest.fn(async () => undefined),
    ...over,
  };
}

/** An invoice whose line period is Stripe's authoritative billing window. */
/** A subscription invoice line; `proration` marks a mid-period adjustment. */
const recurringLine = (start: number, end: number, proration = false) => ({
  period: { start, end },
  parent: { type: 'subscription_item_details', subscription_item_details: { proration } },
});

function makeInvoice(over: Record<string, unknown> = {}): Stripe.Invoice {
  return {
    id: 'in_1',
    subscription: 'sub_stripe_1',
    currency: 'usd',
    amount_due: 4900,
    lines: { data: [recurringLine(1767225600, 1769904000)] },
    ...over,
  } as unknown as Stripe.Invoice;
}

beforeEach(() => {
  findSubscriptionByStripeId.mockResolvedValue(makeSub());
  planFindById.mockResolvedValue({ tier: 'pro' });
});

describe('handleInvoiceUpcoming', () => {
  it('records a renewal-warning billing event against the subscription', async () => {
    await handleInvoiceUpcoming(makeInvoice({ next_payment_attempt: 1769904000 }));

    expect(createBillingEvent).toHaveBeenCalledTimes(1);
    const [orgId, kind, details, subId] = createBillingEvent.mock.calls[0] as [string, string, Record<string, unknown>, string];
    expect(orgId).toBe('org-1');
    expect(kind).toBe('subscription_updated');
    expect(details.eventKind).toBe('invoice_upcoming');
    expect(details.amountDue).toBe(4900);
    expect(details.nextRenewalAt).toEqual(new Date(1769904000 * 1000));
    expect(subId).toBe('sub-1');
  });

  it('no-ops when the invoice carries no subscription', async () => {
    await handleInvoiceUpcoming(makeInvoice({ subscription: undefined }));

    expect(findSubscriptionByStripeId).not.toHaveBeenCalled();
    expect(createBillingEvent).not.toHaveBeenCalled();
  });

  it('no-ops (without throwing) when the subscription is unknown', async () => {
    findSubscriptionByStripeId.mockResolvedValue(null);

    await expect(handleInvoiceUpcoming(makeInvoice())).resolves.toBeUndefined();
    expect(createBillingEvent).not.toHaveBeenCalled();
  });
});

describe('handlePaymentSucceeded', () => {
  it('advances the billing window from the RECURRING line period, and anchors on its day', async () => {
    const sub = makeSub();
    findSubscriptionByStripeId.mockResolvedValue(sub);

    await handlePaymentSucceeded(makeInvoice(), EVT);

    expect(sub.currentPeriodStart).toEqual(new Date(1767225600 * 1000));
    expect(sub.currentPeriodEnd).toEqual(new Date(1769904000 * 1000));
    expect(sub.billingAnchorDay).toBe(1);
  });

  it('skips proration lines: a partial period listed first does not become the period', async () => {
    const sub = makeSub();
    findSubscriptionByStripeId.mockResolvedValue(sub);
    // 2026-08-20 → 2026-09-01: the unused tail of the old plan, listed before the renewal.
    const proration = recurringLine(Date.UTC(2026, 7, 20) / 1000, Date.UTC(2026, 8, 1) / 1000, true);
    const renewal = recurringLine(Date.UTC(2026, 8, 1) / 1000, Date.UTC(2026, 9, 1) / 1000);

    await handlePaymentSucceeded(makeInvoice({ lines: { data: [proration, renewal] } }), EVT);

    expect(sub.currentPeriodStart).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(sub.currentPeriodEnd).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(grantRecurringPromotions).toHaveBeenCalledWith(sub, '2026-09-01', { atomic: true });
  });

  it('leaves the period alone for an invoice with no recurring line (proration-only or one-off)', async () => {
    const sub = makeSub();
    findSubscriptionByStripeId.mockResolvedValue(sub);
    const proration = recurringLine(Date.UTC(2026, 7, 20) / 1000, Date.UTC(2026, 8, 1) / 1000, true);

    await handlePaymentSucceeded(makeInvoice({ lines: { data: [proration] } }), EVT);

    expect(sub.currentPeriodStart).toEqual(new Date('2026-08-01T00:00:00Z'));
    expect(sub.currentPeriodEnd).toEqual(new Date('2026-09-01T00:00:00Z'));
    // ...and its credits share the current period's one grant.
    expect(grantRecurringPromotions).toHaveBeenCalledWith(sub, '2026-08-01', { atomic: true });
  });

  it('resets the grace-period counters on every successful payment', async () => {
    const sub = makeSub({ failedPaymentAttempts: 2, firstFailedAt: new Date('2026-08-10T00:00:00Z') });
    findSubscriptionByStripeId.mockResolvedValue(sub);

    await handlePaymentSucceeded(makeInvoice(), EVT);

    expect(sub.failedPaymentAttempts).toBe(0);
    expect(sub.firstFailedAt).toBeUndefined();
    expect(sub.save).toHaveBeenCalled();
  });

  describe('recovery from past_due', () => {
    it('restores active, re-grants the tier, and preserves purchased add-ons', async () => {
      const sub = makeSub({ status: 'past_due', addons: [{ id: 'seat_pack', qty: 2 }] });
      findSubscriptionByStripeId.mockResolvedValue(sub);

      await handlePaymentSucceeded(makeInvoice(), EVT);

      expect(sub.status).toBe('active');
      expect(syncEntitlements).toHaveBeenCalledWith('org-1', 'pro', '', 'sub-1', [{ id: 'seat_pack', qty: 2 }]);
      const [, , details] = createBillingEvent.mock.calls.at(-1) as [string, string, Record<string, unknown>];
      expect(details.recovered).toBe(true);
      expect(details.previousStatus).toBe('past_due');
    });

    it('pushes the re-granted tier only AFTER the recovered row is saved', async () => {
      const sub = makeSub({ status: 'past_due' });
      findSubscriptionByStripeId.mockResolvedValue(sub);

      await handlePaymentSucceeded(makeInvoice(), EVT);

      const saveOrder = (sub.save as jest.Mock).mock.invocationCallOrder[0];
      const syncOrder = syncEntitlements.mock.invocationCallOrder.at(-1)!;
      expect(saveOrder).toBeLessThan(syncOrder);
    });

    it('does NOT push the paid tier when the recovered row fails to save', async () => {
      const sub = makeSub({ status: 'past_due', save: jest.fn(async () => { throw new Error('write conflict'); }) });
      findSubscriptionByStripeId.mockResolvedValue(sub);
      syncEntitlements.mockClear();

      await expect(handlePaymentSucceeded(makeInvoice(), EVT)).rejects.toThrow('write conflict');
      expect(syncEntitlements).not.toHaveBeenCalled();
    });

    it('CLEARS the grace-period downgrade marker so a future lapse can downgrade again', async () => {
      const sub = makeSub({
        status: 'past_due',
        metadata: { gracePeriodDowngradedAt: '2026-08-15T00:00:00Z', keepMe: 'yes' },
      });
      findSubscriptionByStripeId.mockResolvedValue(sub);

      await handlePaymentSucceeded(makeInvoice(), EVT);

      // Leaving this set would make the lifecycle cron skip the org forever.
      expect(sub.metadata.gracePeriodDowngradedAt).toBeUndefined();
      // …while unrelated metadata survives.
      expect(sub.metadata.keepMe).toBe('yes');
    });

    it('clears a stale marker and re-grants the tier when `.updated`→active already flipped the status', async () => {
      // `.updated` processed first (before the shared reconcile existed) left the
      // row `active` WITH the marker; the invoice must heal it, not skip it.
      const sub = makeSub({ status: 'active', metadata: { gracePeriodDowngradedAt: '2026-08-15T00:00:00Z' } });
      findSubscriptionByStripeId.mockResolvedValue(sub);
      syncEntitlements.mockClear();

      await handlePaymentSucceeded(makeInvoice(), EVT);

      expect(sub.metadata.gracePeriodDowngradedAt).toBeUndefined();
      expect(syncEntitlements).toHaveBeenCalledTimes(1);
      expect(syncEntitlements).toHaveBeenCalledWith('org-1', 'pro', '', 'sub-1', []);
      expect((sub.save as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(syncEntitlements.mock.invocationCallOrder[0]);
    });

    it('re-grants exactly once on a past_due recovery that also clears the marker', async () => {
      const sub = makeSub({ status: 'past_due', metadata: { gracePeriodDowngradedAt: '2026-08-15T00:00:00Z' } });
      findSubscriptionByStripeId.mockResolvedValue(sub);
      syncEntitlements.mockClear();

      await handlePaymentSucceeded(makeInvoice(), EVT);

      expect(sub.metadata.gracePeriodDowngradedAt).toBeUndefined();
      expect(syncEntitlements).toHaveBeenCalledTimes(1);
    });

    it('records a repair signal when the planId dangles, instead of silently not re-granting', async () => {
      planFindById.mockResolvedValue(null);
      const sub = makeSub({ status: 'past_due' });
      findSubscriptionByStripeId.mockResolvedValue(sub);

      await handlePaymentSucceeded(makeInvoice(), EVT);

      expect(syncEntitlements).not.toHaveBeenCalled();
      expect(recordReactivatePlanMissing).toHaveBeenCalledWith(
        'org-1', 'sub-1', 'stripe_webhook', expect.objectContaining({ provider: 'stripe', planId: 'plan-1' }),
      );
      // The recovery is still recorded — the signal is additive, not a substitute.
      const kinds = createBillingEvent.mock.calls.map((c) => c[1]);
      expect(kinds).toContain('payment_succeeded');
    });

    it('does not re-grant entitlements for an ordinary (non-recovery) renewal', async () => {
      await handlePaymentSucceeded(makeInvoice(), EVT);

      expect(syncEntitlements).not.toHaveBeenCalled();
      const [, , details] = createBillingEvent.mock.calls.at(-1) as [string, string, Record<string, unknown>];
      expect(details.recovered).toBe(false);
    });
  });

  describe('fail-soft collaborators (Stripe retries on a throw — double-applying money)', () => {
    it('survives a promotion re-grant failure', async () => {
      grantRecurringPromotions.mockRejectedValueOnce(new Error('promo store down'));

      await expect(handlePaymentSucceeded(makeInvoice(), EVT)).resolves.toBeUndefined();
      // The payment is still recorded.
      expect(createBillingEvent).toHaveBeenCalled();
    });

    it('survives a ledger ingest failure', async () => {
      ingestStripeInvoice.mockRejectedValueOnce(new Error('ledger down'));

      await expect(handlePaymentSucceeded(makeInvoice(), EVT)).resolves.toBeUndefined();
      expect(createBillingEvent).toHaveBeenCalled();
    });

    it('survives a referral qualification failure', async () => {
      qualifyReferral.mockRejectedValueOnce(new Error('referral store down'));

      await expect(handlePaymentSucceeded(makeInvoice(), EVT)).resolves.toBeUndefined();
    });

    it('qualifies a referral on a paid invoice (the qualifying event)', async () => {
      await handlePaymentSucceeded(makeInvoice(), EVT);

      expect(qualifyReferral).toHaveBeenCalledWith('org-1');
    });
  });

  it('a stale event leaves the LIFECYCLE alone (Stripe delivers unordered)', async () => {
    const sub = makeSub({ status: 'past_due', failedPaymentAttempts: 2, firstFailedAt: new Date('2026-08-20T00:00:00Z') });
    findSubscriptionByStripeId.mockResolvedValue(sub);
    acceptStripeEvent.mockResolvedValueOnce(false);

    await handlePaymentSucceeded(makeInvoice(), EVT);

    expect(acceptStripeEvent).toHaveBeenCalledWith(sub, EVT, 'invoice.payment_succeeded');
    expect(sub.status).toBe('past_due');
    expect(sub.failedPaymentAttempts).toBe(2);
    expect(sub.currentPeriodStart).toEqual(new Date('2026-08-01T00:00:00Z'));
    expect(sub.save).not.toHaveBeenCalled();
    expect(syncEntitlements).not.toHaveBeenCalled();
    expect(grantOnBecomingEntitled).not.toHaveBeenCalled();
  });

  it('a stale event STILL settles its per-invoice effects (nothing else backfills them)', async () => {
    const sub = makeSub({ status: 'active' });
    findSubscriptionByStripeId.mockResolvedValue(sub);
    acceptStripeEvent.mockResolvedValueOnce(false);
    const invoice = makeInvoice();

    await handlePaymentSucceeded(invoice, EVT);

    expect(ingestStripeInvoice).toHaveBeenCalledWith('org-1', invoice);
    expect(reconcileDiscountsOnInvoice).toHaveBeenCalledWith(sub, invoice);
    // Out of order, so the period was not adopted, but the credit still keys on
    // the period the invoice's recurring charge opens (2026-01-01).
    expect(grantRecurringPromotions).toHaveBeenCalledWith(sub, '2026-01-01', { atomic: true });
    expect(qualifyReferral).toHaveBeenCalledWith('org-1');
    const [, kind, details] = createBillingEvent.mock.calls.at(-1) as [string, string, Record<string, unknown>];
    expect(kind).toBe('payment_succeeded');
    expect(details).toEqual(expect.objectContaining({ invoiceId: 'in_1', outOfOrder: true, recovered: false }));
  });

  it('settles an INCOMPLETE subscription to active and grants tier + withheld signup credit', async () => {
    const sub = makeSub({ status: 'incomplete', metadata: { pendingReferralCode: 'org-ref', keep: 1 } });
    findSubscriptionByStripeId.mockResolvedValue(sub);

    await handlePaymentSucceeded(makeInvoice(), EVT);

    expect(sub.status).toBe('active');
    expect(sub.metadata).toEqual({ keep: 1 });
    expect(sub.save).toHaveBeenCalled();
    expect(grantOnBecomingEntitled).toHaveBeenCalledWith(sub, null, { previousStatus: 'incomplete', referralCode: 'org-ref' });
    const [, , details] = createBillingEvent.mock.calls.at(-1) as [string, string, Record<string, unknown>];
    expect(details.recovered).toBe(true);
  });

  it('no-ops when the subscription is unknown', async () => {
    findSubscriptionByStripeId.mockResolvedValue(null);

    await handlePaymentSucceeded(makeInvoice(), EVT);

    expect(createBillingEvent).not.toHaveBeenCalled();
    expect(ingestStripeInvoice).not.toHaveBeenCalled();
  });

  it('THROWS so Stripe redelivers when the row is still binding (a first invoice settled before the bind)', async () => {
    findSubscriptionByStripeId.mockResolvedValue(null);
    awaitsLocalRow.mockResolvedValueOnce(true);
    const metadata = { subscriptionRef: '507f1f77bcf86cd799439011' };

    await expect(handlePaymentSucceeded(makeInvoice({
      parent: { subscription_details: { subscription: 'sub_stripe_1', metadata } },
    }), EVT)).rejects.toThrow(/still binding/);

    expect(awaitsLocalRow).toHaveBeenCalledWith(metadata, EVT);
    expect(ingestStripeInvoice).not.toHaveBeenCalled();
  });

  it('reads the metadata off an EXPANDED subscription when the snapshot is absent', async () => {
    findSubscriptionByStripeId.mockResolvedValue(null);
    const metadata = { orgId: 'org-9', planId: 'team' };

    await handlePaymentSucceeded(makeInvoice({
      parent: { subscription_details: { subscription: { id: 'sub_stripe_1', metadata } } },
    }), EVT);

    expect(awaitsLocalRow).toHaveBeenCalledWith(metadata, EVT);
  });
});

describe('handlePaymentFailed', () => {
  it('moves an active subscription into past_due and starts the grace clock', async () => {
    const sub = makeSub({ status: 'active' });
    findSubscriptionByStripeId.mockResolvedValue(sub);

    await handlePaymentFailed(makeInvoice(), EVT);

    expect(sub.status).toBe('past_due');
    expect(sub.failedPaymentAttempts).toBe(1);
    expect(sub.firstFailedAt).toBeInstanceOf(Date);
    expect(sub.save).toHaveBeenCalled();
  });

  it('posts ONE in-app notice on the first failure of a lapse, naming the grace deadline', async () => {
    const sub = makeSub({ status: 'active' });
    findSubscriptionByStripeId.mockResolvedValue(sub);

    await handlePaymentFailed(makeInvoice(), EVT);

    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
    const [notice] = sendSystemNotification.mock.calls[0] as [{ recipientOrgId: string; content: string; priority: string }];
    expect(notice.recipientOrgId).toBe('org-1');
    expect(notice.priority).toBe('high');
    const deadline = new Date((sub.firstFailedAt as Date).getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
    expect(notice.content).toContain(deadline);
  });

  it('a notice failure never fails the webhook', async () => {
    sendSystemNotification.mockRejectedValueOnce(new Error('message down'));
    await expect(handlePaymentFailed(makeInvoice(), EVT)).resolves.toBeUndefined();
    expect(createBillingEvent).toHaveBeenCalled();
  });

  it('does NOT restart the grace clock on a later failure in the same dunning run', async () => {
    const firstFailedAt = new Date('2026-08-10T00:00:00Z');
    const sub = makeSub({ status: 'past_due', failedPaymentAttempts: 1, firstFailedAt });
    findSubscriptionByStripeId.mockResolvedValue(sub);

    await handlePaymentFailed(makeInvoice(), EVT);

    // Resetting this would extend the grace period indefinitely, one retry at a time.
    expect(sub.firstFailedAt).toBe(firstFailedAt);
    expect(sub.failedPaymentAttempts).toBe(2);
    // Not the first failure of the lapse — the org was already told.
    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it('records the failure event with the configured grace window', async () => {
    await handlePaymentFailed(makeInvoice(), EVT);

    const [orgId, kind, details] = createBillingEvent.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(orgId).toBe('org-1');
    expect(kind).toBe('payment_failed');
    expect(details.newStatus).toBe('past_due');
    expect(details.gracePeriodDays).toBe(7);
  });

  it('does NOT downgrade the tier immediately (the lifecycle cron owns that)', async () => {
    await handlePaymentFailed(makeInvoice(), EVT);

    expect(syncEntitlements).not.toHaveBeenCalled();
  });

  describe('dunning guard — a non-entitled subscription must not be revived', () => {
    it.each(['canceled', 'incomplete', 'unpaid'])(
      'leaves a %s subscription untouched', async (status) => {
        const sub = makeSub({ status });
        findSubscriptionByStripeId.mockResolvedValue(sub);

        await handlePaymentFailed(makeInvoice(), EVT);

        // Flipping to past_due would put a dead sub back in the ENTITLED set —
        // visible, manageable, and re-synced to its paid tier by the reconciler.
        expect(sub.status).toBe(status);
        expect(sub.save).not.toHaveBeenCalled();
        expect(createBillingEvent).not.toHaveBeenCalled();
      });
  });

  it('SKIPS a stale payment_failed that predates an applied recovery', async () => {
    const sub = makeSub({ status: 'active' });
    findSubscriptionByStripeId.mockResolvedValue(sub);
    acceptStripeEvent.mockResolvedValueOnce(false);

    await handlePaymentFailed(makeInvoice(), EVT);

    expect(sub.status).toBe('active');
    expect(sub.save).not.toHaveBeenCalled();
  });

  it('no-ops when the subscription is unknown', async () => {
    findSubscriptionByStripeId.mockResolvedValue(null);

    await handlePaymentFailed(makeInvoice(), EVT);

    expect(createBillingEvent).not.toHaveBeenCalled();
  });
});
