// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 6's three store-touching parts (docs/plans/sales-agent.md).
 *
 * Attribution is the one with a judgement in it: a DISMISSED offer still
 * converts (dismissing is "not now", and an account that bought a week later is
 * exactly the case the lift measurement needs to see), while a DECLINED one
 * never does — crediting a purchase to an offer that was explicitly refused
 * would let the feature claim conversions it was told no on.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-offers-outcome-store';

const mockCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ emitCounter: mockCounter }));

const mockFindOne = jest.fn<AnyFn>();
const mockUpdateMany = jest.fn<AnyFn>();
const mockAggregate = jest.fn<AnyFn>();
const mockFind = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/offer.js', () => ({
  Offer: {
    findOne: mockFindOne,
    updateMany: mockUpdateMany,
    aggregate: mockAggregate,
    find: mockFind,
  },
}));

const { attributeConversion, sweepExpiredOffers, measureLift } = await import('../src/helpers/offers-outcome.js');

const NOW = new Date('2026-11-20T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** A saveable offer doc, with the fields the attribution writes. */
function offerDoc(over: Record<string, unknown> = {}) {
  return {
    orgId: 'acct-1',
    offerType: 'pack',
    holdout: false,
    status: 'sent',
    sentAt: new Date(NOW.getTime() - 3 * DAY),
    targetTier: undefined,
    save: jest.fn<AnyFn>(async () => undefined),
    ...over,
  };
}

/** The attribution query always goes through `findOne(...).sort(...)`. */
function queued(doc: unknown) {
  mockFindOne.mockReturnValue({ sort: () => Promise.resolve(doc) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  mockAggregate.mockResolvedValue([]);
  mockFind.mockReturnValue({ select: () => ({ lean: async () => [] }) });
});

describe('crediting a purchase to an offer', () => {
  it('records the SKU bought and how long it took', async () => {
    const doc = offerDoc();
    queued(doc);
    await expect(attributeConversion('acct-1', { kind: 'bundle', sku: 'pipeline_pack' }, NOW)).resolves.toBe(true);
    expect(doc.status).toBe('redeemed');
    expect((doc as unknown as { boughtSku: string }).boughtSku).toBe('pipeline_pack');
    expect((doc as unknown as { conversionMs: number }).conversionMs).toBe(3 * DAY);
    expect(doc.save).toHaveBeenCalled();
  });

  it('counts the SKU match and the time bucket, not just "a conversion"', async () => {
    queued(offerDoc({ offerType: 'upgrade', targetTier: 'business' }));
    await attributeConversion('acct-1', { kind: 'tier', sku: 'business' }, NOW);
    expect(mockCounter).toHaveBeenCalledWith('billing_offer_conversions_total', expect.objectContaining({
      type: 'upgrade', match: 'exact', bucket: 'within_week', holdout: 'false',
    }));
  });

  it('only ever looks at SENT rows, so a declined offer cannot convert', async () => {
    queued(null);
    await expect(attributeConversion('acct-1', { kind: 'bundle', sku: 'x' }, NOW)).resolves.toBe(false);
    // A declined row has status 'declined', so this filter excludes it — the
    // guarantee that the feature cannot claim what it was refused.
    expect(mockFindOne.mock.calls[0]![0]).toMatchObject({ orgId: 'acct-1', status: 'sent' });
  });

  it('bounds the window, so a purchase months later is not credited', async () => {
    queued(null);
    await attributeConversion('acct-1', { kind: 'bundle', sku: 'x' }, NOW);
    const filter = mockFindOne.mock.calls[0]![0] as { sentAt: { $gte: Date } };
    expect(NOW.getTime() - filter.sentAt.$gte.getTime()).toBe(30 * DAY);
  });

  it('refuses an offer past its OWN expiry, even inside the window', async () => {
    // The account was told it had lapsed.
    queued(offerDoc({ expiresAt: new Date(NOW.getTime() - DAY) }));
    await expect(attributeConversion('acct-1', { kind: 'bundle', sku: 'x' }, NOW)).resolves.toBe(false);
    expect(mockCounter).not.toHaveBeenCalled();
  });

  it('never throws into the purchase that triggered it', async () => {
    // It runs inside a change the customer has already completed; failing their
    // add-on because a measurement row could not be written is the worst trade.
    mockFindOne.mockImplementation(() => { throw new Error('mongo down'); });
    await expect(attributeConversion('acct-1', { kind: 'bundle', sku: 'x' }, NOW)).resolves.toBe(false);
  });

  it('is a no-op when there is no offer at all', async () => {
    queued(undefined);
    await expect(attributeConversion('acct-1', { kind: 'tier', sku: 'team' }, NOW)).resolves.toBe(false);
  });
});

describe('the expiry sweep', () => {
  it('closes only SENT rows whose clock has run out', async () => {
    mockUpdateMany.mockResolvedValue({ modifiedCount: 4 });
    await expect(sweepExpiredOffers(NOW)).resolves.toBe(4);
    const [filter, update] = mockUpdateMany.mock.calls[0] as [Record<string, unknown>, Record<string, Record<string, unknown>>];
    expect(filter).toEqual({ status: 'sent', expiresAt: { $lt: NOW } });
    expect(update.$set).toMatchObject({ status: 'expired' });
  });

  it('counts what it closed, because nothing else ever records `expired`', async () => {
    mockUpdateMany.mockResolvedValue({ modifiedCount: 2 });
    await sweepExpiredOffers(NOW);
    expect(mockCounter).toHaveBeenCalledWith('billing_offers_expired_total', {}, 2);
  });

  it('stays quiet when there is nothing to close', async () => {
    await sweepExpiredOffers(NOW);
    expect(mockCounter).not.toHaveBeenCalled();
  });

  it('never throws — the cycle must still run', async () => {
    mockUpdateMany.mockRejectedValue(new Error('down'));
    await expect(sweepExpiredOffers(NOW)).resolves.toBe(0);
  });
});

describe('offered against holdout', () => {
  it('counts ACCOUNTS, and reports the lift as computed', async () => {
    mockAggregate.mockResolvedValue([
      { _id: false, accounts: 100, sent: 140, conversions: 12 },
      { _id: true, accounts: 10, sent: 0, conversions: 1 },
    ]);
    const report = await measureLift();
    expect(report.offered).toMatchObject({ accounts: 100, conversions: 12, conversionRate: 0.12 });
    expect(report.holdout).toMatchObject({ accounts: 10, conversions: 1, conversionRate: 0.1 });
    expect(report.lift).toBeCloseTo(0.02);
  });

  it('reports a NEGATIVE lift rather than clamping it', async () => {
    // The finding a control group exists to be able to produce: the accounts we
    // solicited converted LESS than the ones we left alone.
    mockAggregate.mockResolvedValue([
      { _id: false, accounts: 100, sent: 100, conversions: 5 },
      { _id: true, accounts: 10, sent: 0, conversions: 2 },
    ]);
    const report = await measureLift();
    expect(report.lift).toBeLessThan(0);
  });

  it('reports 0 rather than NaN for an arm with no accounts yet', async () => {
    const report = await measureLift();
    expect(report.offered.conversionRate).toBe(0);
    expect(report.holdout.conversionRate).toBe(0);
    expect(report.lift).toBe(0);
  });

  it('buckets the elapsed times it reads, rather than grouping on milliseconds', async () => {
    mockFind.mockReturnValue({
      select: () => ({
        lean: async () => [
          { conversionMs: 2 * 60 * 60 * 1000 },
          { conversionMs: 3 * DAY },
          { conversionMs: 4 * DAY },
          { conversionMs: null },
        ],
      }),
    });
    const report = await measureLift();
    expect(report.timeToConversion).toEqual({ same_day: 1, within_week: 2 });
  });

  it('reports the bought SKUs, which is the targeting check', async () => {
    mockAggregate.mockImplementation(async (stages: unknown) => {
      const first = (stages as Array<Record<string, unknown>>)[0];
      if (first && '$match' in first) return [{ _id: 'business', count: 3 }, { _id: null, count: 1 }];
      return [];
    });
    const report = await measureLift();
    expect(report.skuMatch).toEqual({ business: 3, unknown: 1 });
  });
});
