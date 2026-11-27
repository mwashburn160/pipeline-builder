// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The unknown-provider-outcome reconcile.
 *
 * A cancel/reactivate whose provider call timed out keeps its local INTENT and
 * is stamped for reconcile; this pass reads the provider's real state and adopts
 * it. The assertions are the ones that decide money:
 *  - the provider's value wins, in BOTH directions (confirmed / never landed);
 *  - the side effects the route skipped run only when the provider confirms;
 *  - a provider read failure leaves the marker for the next tick;
 *  - a newer route write (compare-and-set lost) is not clobbered.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-provider-reconcile';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
const mockIncCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: (...a: unknown[]) => mockIncCounter(...a),
}));

const mockCreateBillingEvent = jest.fn<AnyFn>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  createBillingEvent: (...a: unknown[]) => mockCreateBillingEvent(...a),
}));
const mockClawback = jest.fn<AnyFn>().mockResolvedValue(0);
jest.unstable_mockModule('../src/helpers/promotion-engine.js', () => ({
  clawbackRecentPromotions: (...a: unknown[]) => mockClawback(...a),
}));

let rows: unknown[] = [];
const mockFind = jest.fn<AnyFn>();
const mockUpdateOne = jest.fn<AnyFn>().mockResolvedValue({ modifiedCount: 1 });
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: {
    find: (...a: unknown[]) => {
      mockFind(...a);
      return { cursor: () => ({ async* [Symbol.asyncIterator]() { yield* rows; } }) };
    },
    updateOne: (...a: unknown[]) => mockUpdateOne(...a),
  },
}));

const mockGetSubscription = jest.fn<AnyFn>();
const provider: { getSubscription?: AnyFn } = { getSubscription: (...a: unknown[]) => mockGetSubscription(...a) };
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => provider,
}));

const {
  reconcileUnknownProviderOutcomes, markProviderReconcilePending, clearProviderReconcilePending, readReconcileMarker,
} = await import('../src/helpers/provider-reconcile.js');
const { isProviderOutcomeUnknown } = await import('../src/providers/payment-provider.js');

const AT = '2026-11-17T10:00:00.000Z';

function sub(marker: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'sub-1' },
    orgId: 'org-1',
    planId: 'pro',
    externalId: 'sub_ext',
    cancelAtPeriodEnd: true,
    currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
    metadata: marker ? { providerReconcilePending: marker } : {},
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  rows = [];
  provider.getSubscription = (...a: unknown[]) => mockGetSubscription(...a);
  mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
});

describe('isProviderOutcomeUnknown', () => {
  it.each([
    [{ type: 'StripeConnectionError' }, true],
    [{ type: 'StripeAPIError', statusCode: 500 }, true],
    [{ type: 'StripeAPIError' }, true],
    [{ statusCode: 503 }, true],
    [{ type: 'StripeInvalidRequestError', statusCode: 400 }, false],
    [{ type: 'StripeCardError', statusCode: 402 }, false],
    [new Error('plain'), false],
    [null, false],
    ['string', false],
  ])('%p -> %p', (err, expected) => {
    expect(isProviderOutcomeUnknown(err)).toBe(expected);
  });
});

describe('reconcileUnknownProviderOutcomes', () => {
  it('queries only marked rows', async () => {
    await reconcileUnknownProviderOutcomes();
    expect(mockFind).toHaveBeenCalledWith({ 'metadata.providerReconcilePending': { $exists: true } });
  });

  it('CONFIRMED cancel: adopts the provider value, clears the marker under CAS, runs the skipped side effects', async () => {
    rows = [sub({ op: 'cancel', intendedCancelAtPeriodEnd: true, at: AT, actorId: 'u-1' })];
    mockGetSubscription.mockResolvedValue({ status: 'active', cancelAtPeriodEnd: true });

    await reconcileUnknownProviderOutcomes();

    expect(mockGetSubscription).toHaveBeenCalledWith('sub_ext');
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { '_id': expect.anything(), 'metadata.providerReconcilePending.at': AT },
      { $set: { cancelAtPeriodEnd: true }, $unset: { 'metadata.providerReconcilePending': '' } },
    );
    expect(mockIncCounter).toHaveBeenCalledWith('billing_provider_reconcile_total', { outcome: 'confirmed' });
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-1', 'subscription_canceled', expect.objectContaining({ reconciled: true }), 'sub-1', 'u-1');
    expect(mockClawback).toHaveBeenCalledTimes(1);
  });

  it('cancel that NEVER LANDED: puts the local flag back to the provider value, no side effects', async () => {
    rows = [sub({ op: 'cancel', intendedCancelAtPeriodEnd: true, at: AT })];
    mockGetSubscription.mockResolvedValue({ status: 'active', cancelAtPeriodEnd: false });

    await reconcileUnknownProviderOutcomes();

    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      { $set: { cancelAtPeriodEnd: false }, $unset: { 'metadata.providerReconcilePending': '' } },
    );
    expect(mockIncCounter).toHaveBeenCalledWith('billing_provider_reconcile_total', { outcome: 'reverted' });
    expect(mockCreateBillingEvent).not.toHaveBeenCalled();
    expect(mockClawback).not.toHaveBeenCalled();
  });

  it('confirmed reactivate records the reactivation event (no clawback)', async () => {
    rows = [sub({ op: 'reactivate', intendedCancelAtPeriodEnd: false, at: AT }, { cancelAtPeriodEnd: false })];
    mockGetSubscription.mockResolvedValue({ status: 'active', cancelAtPeriodEnd: false });

    await reconcileUnknownProviderOutcomes();

    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-1', 'subscription_reactivated', expect.objectContaining({ reconciled: true }), 'sub-1', undefined);
    expect(mockClawback).not.toHaveBeenCalled();
  });

  it('a provider read failure keeps the marker for the next tick and does not abort the pass', async () => {
    rows = [
      sub({ op: 'cancel', intendedCancelAtPeriodEnd: true, at: AT }),
      sub({ op: 'cancel', intendedCancelAtPeriodEnd: true, at: AT }, { externalId: 'sub_two' }),
    ];
    mockGetSubscription.mockRejectedValueOnce(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }))
      .mockResolvedValueOnce({ status: 'active', cancelAtPeriodEnd: true });

    await reconcileUnknownProviderOutcomes();

    expect(mockIncCounter).toHaveBeenCalledWith('billing_provider_reconcile_total', { outcome: 'provider_error' });
    // Only the second row was written.
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('a lost compare-and-set (newer route write) skips the side effects', async () => {
    rows = [sub({ op: 'cancel', intendedCancelAtPeriodEnd: true, at: AT })];
    mockGetSubscription.mockResolvedValue({ status: 'active', cancelAtPeriodEnd: true });
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });

    await reconcileUnknownProviderOutcomes();

    expect(mockCreateBillingEvent).not.toHaveBeenCalled();
  });

  it('drops the marker when the provider cannot be read or reports no flag', async () => {
    rows = [sub({ op: 'cancel', intendedCancelAtPeriodEnd: true, at: AT })];
    provider.getSubscription = undefined;
    await reconcileUnknownProviderOutcomes();
    expect(mockIncCounter).toHaveBeenCalledWith('billing_provider_reconcile_total', { outcome: 'unsupported' });

    provider.getSubscription = (...a: unknown[]) => mockGetSubscription(...a);
    mockGetSubscription.mockResolvedValue({ status: 'canceled' });
    await reconcileUnknownProviderOutcomes();
    expect(mockIncCounter).toHaveBeenCalledWith('billing_provider_reconcile_total', { outcome: 'no_flag' });
    expect(mockUpdateOne).toHaveBeenLastCalledWith(
      { '_id': expect.anything(), 'metadata.providerReconcilePending.at': AT },
      { $unset: { 'metadata.providerReconcilePending': '' } },
    );
  });

  it('clears a malformed marker', async () => {
    rows = [sub({ op: 'bogus', at: AT })];
    await reconcileUnknownProviderOutcomes();
    expect(mockIncCounter).toHaveBeenCalledWith('billing_provider_reconcile_total', { outcome: 'malformed' });
    expect(mockGetSubscription).not.toHaveBeenCalled();
  });
});

describe('mark / clear', () => {
  it('stamps the marker, keeps other metadata, and counts the unknown outcome', async () => {
    const doc = { metadata: { other: 1 } as Record<string, unknown>, save: jest.fn<AnyFn>().mockResolvedValue(undefined), markModified: jest.fn() };
    await markProviderReconcilePending(doc, 'cancel', true, new Error('timeout'), 'u-1');
    expect(readReconcileMarker(doc)).toEqual(expect.objectContaining({ op: 'cancel', intendedCancelAtPeriodEnd: true, actorId: 'u-1' }));
    expect(doc.metadata.other).toBe(1);
    // Never the WHOLE object: marking `metadata` modified made the save write back
    // every key it had read, erasing markers other writers set meanwhile.
    expect(doc.markModified).not.toHaveBeenCalled();
    expect(doc.save).toHaveBeenCalled();
    expect(mockIncCounter).toHaveBeenCalledWith('billing_provider_outcome_unknown_total', { op: 'cancel' });
  });

  it('never throws when the stamp cannot be saved', async () => {
    const doc = { save: jest.fn<AnyFn>().mockRejectedValue(new Error('mongo down')) };
    await expect(markProviderReconcilePending(doc, 'reactivate', false, new Error('x'))).resolves.toBeUndefined();
    expect(mockIncCounter).toHaveBeenCalledWith('billing_provider_reconcile_total', { outcome: 'mark_failed' });
  });

  it('clear is a no-op without a marker and removes only the marker otherwise', async () => {
    const bare = { metadata: { a: 1 } as Record<string, unknown>, save: jest.fn<AnyFn>() };
    await clearProviderReconcilePending(bare);
    expect(bare.save).not.toHaveBeenCalled();

    const marked = { metadata: { a: 1, providerReconcilePending: { op: 'cancel', at: AT } } as Record<string, unknown>, save: jest.fn<AnyFn>().mockResolvedValue(undefined) };
    await clearProviderReconcilePending(marked);
    expect(marked.metadata).toEqual({ a: 1 });

    const failing = { metadata: { providerReconcilePending: {} } as Record<string, unknown>, save: jest.fn<AnyFn>().mockRejectedValue(new Error('x')) };
    await expect(clearProviderReconcilePending(failing)).resolves.toBeUndefined();
  });
});
