// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 3's delivery leg (docs/plans/sales-agent.md).
 *
 * Two things are asserted here because each was a way the feature could have
 * shipped looking fine: the consent AND (platform does NOT re-check it, so a
 * missing check here is a missing check everywhere), and the refusal to send
 * copy that cannot name both the LIMIT and the PRICE.
 */

import { describe, it, expect } from '@jest/globals';

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-offers-notify';

const { offerChannelAllowed, offerEmailText, money, OFFER_LANDING_PATH } =
  await import('../src/helpers/offers-notify.js');

type Facts = Parameters<typeof offerEmailText>[0];

const PACK = { name: 'Pipeline pack', priceCents: 1199, grantDisplay: '10' };

function facts(over: Partial<Facts> = {}): Facts {
  return {
    offerType: 'pack',
    pressure: [{ dimension: 'pipelines', used: 9, limit: 10 }],
    pack: PACK,
    interval: 'monthly',
    ...over,
  };
}

describe('the consent AND (D6)', () => {
  it('allows only when BOTH switches are on', () => {
    expect(offerChannelAllowed({ accountOptIn: true, noticesEnabled: true })).toBe(true);
  });

  it('refuses when the account opted out of offers', () => {
    expect(offerChannelAllowed({ accountOptIn: false, noticesEnabled: true })).toBe(false);
  });

  it('refuses when the account silenced quota notices — the CHANNEL is off', () => {
    // The reading that matters: an offer rides the quota-notice channel, so an
    // account that turned usage email off has already answered for both. A
    // solicitation exempt from that is the one reading nobody asked for.
    expect(offerChannelAllowed({ accountOptIn: true, noticesEnabled: false })).toBe(false);
  });
});

describe('copy names the limit and the price, or refuses', () => {
  it('states where they stand and what the fix costs', () => {
    const text = offerEmailText(facts());
    expect(text).not.toBeNull();
    expect(text!.text).toContain('9 of 10 pipelines');
    expect(text!.text).toContain('$11.99');
    expect(text!.text).toContain('Pipeline pack');
    expect(text!.subject.toLowerCase()).toContain('pipelines');
  });

  it('points at ONE place to act, the same path every other surface uses', () => {
    expect(offerEmailText(facts())!.text).toContain(OFFER_LANDING_PATH);
  });

  it('tells them how to stop receiving these', () => {
    expect(offerEmailText(facts())!.text.toLowerCase()).toContain('turn off offers');
  });

  it('refuses a pack offer with no pack — a null is a refusal, not an empty render', () => {
    expect(offerEmailText(facts({ pack: null }))).toBeNull();
  });

  it('refuses a FREE pack rather than quoting $0', () => {
    expect(offerEmailText(facts({ pack: { ...PACK, priceCents: 0 } }))).toBeNull();
  });

  it('refuses a pack offer with no pressure to name', () => {
    expect(offerEmailText(facts({ pressure: [] }))).toBeNull();
  });

  it('names EVERY pressured dimension in a basket', () => {
    // An account told only about the loudest of three solves a third of its
    // problem and is asked again.
    const text = offerEmailText(facts({
      offerType: 'compose',
      pressure: [
        { dimension: 'pipelines', used: 9, limit: 10 },
        { dimension: 'plugins', used: 18, limit: 20 },
        { dimension: 'apiCalls', used: 950, limit: 1000 },
      ],
    }));
    expect(text!.text).toContain('pipelines');
    expect(text!.text).toContain('plugins');
    expect(text!.subject).toContain('3 of your limits');
  });

  it('argues a crossover from the BILL, and needs no pack', () => {
    const text = offerEmailText(facts({
      offerType: 'upgrade',
      pack: null,
      candidateTier: 'business',
      savingCents: 2_996,
    }));
    expect(text!.subject).toContain('$29.96');
    expect(text!.text).toContain('business');
  });

  it('refuses a crossover with nothing saved — a zero is not an argument', () => {
    expect(offerEmailText(facts({ offerType: 'upgrade', pack: null, candidateTier: 'business', savingCents: 0 }))).toBeNull();
  });

  it('refuses a crossover with no candidate tier', () => {
    expect(offerEmailText(facts({ offerType: 'upgrade', pack: null, candidateTier: null, savingCents: 5_000 }))).toBeNull();
  });

  it('says when the offer lapses rather than implying forever', () => {
    const text = offerEmailText(facts({ expiresAt: new Date('2026-12-01T00:00:00Z') }));
    expect(text!.text).toContain('2026-12-01');
  });

  it('quotes the price per YEAR on an annual subscription', () => {
    expect(offerEmailText(facts({ interval: 'annual' }))!.text).toContain('per year');
  });
});

describe('money', () => {
  it('drops a trailing .00, because "$300.00" reads as a form field', () => {
    expect(money(30_000)).toBe('$300');
  });

  it('keeps the cents when there are any', () => {
    expect(money(1199)).toBe('$11.99');
    expect(money(2990)).toBe('$29.90');
  });

  it('pads a single-digit remainder', () => {
    expect(money(1205)).toBe('$12.05');
  });
});
