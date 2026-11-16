// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { billingPeriodKey } from '../src/helpers/billing-period.js';
import { invoiceCreditPeriodKey, recurringInvoicePeriod, stripeSubscriptionPeriod } from '../src/helpers/stripe-period.js';

const s = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 1000;
const line = (start: string, end: string, proration: boolean | null = false) => ({
  period: { start: s(start), end: s(end) },
  parent: proration === null ? null : { subscription_item_details: { proration } },
});

describe('stripeSubscriptionPeriod', () => {
  it('reads the period from the items; the item ending first decides', () => {
    expect(stripeSubscriptionPeriod({
      items: {
        data: [
          { current_period_start: s('2026-01-01'), current_period_end: s('2027-01-01') },
          { current_period_start: s('2026-11-01'), current_period_end: s('2026-12-01') },
        ],
      },
    } as never)).toEqual({ start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') });
  });

  it('is null when no item carries a period (a top-level current_period_end is not read)', () => {
    expect(stripeSubscriptionPeriod({ current_period_end: s('2026-12-01'), items: { data: [{}] } } as never)).toBeNull();
    expect(stripeSubscriptionPeriod({} as never)).toBeNull();
  });
});

describe('recurringInvoicePeriod', () => {
  it('takes the first non-proration subscription line, wherever it is listed', () => {
    const invoice = { lines: { data: [line('2026-08-20', '2026-09-01', true), line('2026-09-01', '2026-10-01')] } };
    expect(recurringInvoicePeriod(invoice)).toEqual({ start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-10-01T00:00:00Z') });
  });

  it('is null for a proration-only invoice or one with only non-subscription lines', () => {
    expect(recurringInvoicePeriod({ lines: { data: [line('2026-08-20', '2026-09-01', true)] } })).toBeNull();
    expect(recurringInvoicePeriod({ lines: { data: [line('2026-08-20', '2026-09-01', null)] } })).toBeNull();
    expect(recurringInvoicePeriod({})).toBeNull();
  });
});

describe('credit period keys', () => {
  it('is the UTC start date of the period, one key per period whatever the month length', () => {
    expect(billingPeriodKey(new Date('2026-03-31T00:00:00Z'))).toBe('2026-03-31');
    expect(billingPeriodKey(new Date('2026-04-30T00:00:00Z'))).toBe('2026-04-30');
  });

  it('a renewal that settles late on the 1st still keys the period it opens', () => {
    // Mar 31 renewal, paid on a retry on Apr 1; the next renewal is Apr 30.
    const late = { lines: { data: [line('2026-03-31', '2026-04-30')] } };
    const next = { lines: { data: [line('2026-04-30', '2026-05-31')] } };
    const sub = { currentPeriodStart: new Date('2026-03-31T00:00:00Z') };
    expect(invoiceCreditPeriodKey(late, sub)).toBe('2026-03-31');
    expect(invoiceCreditPeriodKey(next, sub)).toBe('2026-04-30');
  });

  it("a proration-only invoice keys on the subscription's current period, sharing its grant", () => {
    const proration = { lines: { data: [line('2026-08-20', '2026-09-01', true)] } };
    expect(invoiceCreditPeriodKey(proration, { currentPeriodStart: new Date('2026-08-01T00:00:00Z') })).toBe('2026-08-01');
  });
});
