// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 6's measurement arithmetic (docs/plans/sales-agent.md).
 *
 * The SKU match is the one assertion worth having here: "an account that
 * converts to a DIFFERENT SKU is a targeting failure wearing a conversion win",
 * and a single `conversions` counter hides exactly that. So the test pins the
 * three verdicts apart rather than checking that a conversion was counted.
 */

import { describe, it, expect } from '@jest/globals';

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-offers-outcome';

const { skuMatch, timeBucket, ATTRIBUTION_WINDOW_DAYS } = await import('../src/helpers/offers-outcome.js');

describe('offered SKU against bought SKU', () => {
  it('is EXACT when a tier offer is answered by that tier', () => {
    expect(skuMatch('upgrade', 'business', { kind: 'tier', sku: 'business' })).toBe('exact');
  });

  it('is a near miss when a tier offer is answered by a DIFFERENT tier', () => {
    // The right shape, the wrong SKU — worth separating from a clean miss,
    // because the offer was about moving plan and they moved plan.
    expect(skuMatch('upgrade', 'business', { kind: 'tier', sku: 'team' })).toBe('kind');
  });

  it('is OTHER when a tier offer is answered by buying a pack', () => {
    expect(skuMatch('upgrade', 'business', { kind: 'bundle', sku: 'pipeline_pack' })).toBe('other');
  });

  it('is a near miss when a pack offer is answered by any pack', () => {
    // Deliberately not `exact`: the offer quotes the cheapest pack in its COPY
    // and does not pin one bundle as a target, so claiming exactness would
    // claim a precision the record does not have.
    expect(skuMatch('pack', null, { kind: 'bundle', sku: 'pipeline_pack' })).toBe('kind');
    expect(skuMatch('compose', null, { kind: 'bundle', sku: 'seat_pack' })).toBe('kind');
  });

  it('is OTHER when a pack offer is answered by a tier move', () => {
    expect(skuMatch('pack', null, { kind: 'tier', sku: 'business' })).toBe('other');
  });
});

describe('time to conversion', () => {
  it('buckets coarsely, so the counter stays low-cardinality', () => {
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;
    expect(timeBucket(2 * hour)).toBe('same_day');
    expect(timeBucket(3 * day)).toBe('within_week');
    expect(timeBucket(10 * day)).toBe('within_2w');
    expect(timeBucket(40 * day)).toBe('later');
  });

  it('puts the exact boundaries in the LATER bucket, not the earlier one', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(timeBucket(day)).toBe('within_week');
    expect(timeBucket(7 * day)).toBe('within_2w');
    expect(timeBucket(14 * day)).toBe('later');
  });
});

describe('the attribution window', () => {
  it('is not generous — a purchase months later is not evidence the offer worked', () => {
    // Pinned because widening it is the easy way to make the lift number
    // flatter and friendlier than the truth.
    expect(ATTRIBUTION_WINDOW_DAYS).toBe(30);
  });
});
