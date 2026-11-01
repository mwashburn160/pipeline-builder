// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The support response-deadline calendar.
 *
 * This is the function the lower two levels' targets are SOLD on, so the tests
 * are written as the claims a customer could make rather than as coverage of
 * branches. The ones that matter:
 *
 *  - "next business day" means TOMORROW, whatever time today the case arrived.
 *    A case at 09:01 and a case at 16:59 are owed the same thing; anything else
 *    turns the target back into an hours clock by the back door.
 *  - A Friday case is due Monday, not Saturday. Weekends are not counted, which
 *    is the entire point of saying "business day".
 *  - Premium consults no calendar at all. Its 24×7 claim IS the absence of one.
 *  - A broken calendar must never stop a case being opened: an unknown timezone
 *    falls back to UTC and an empty working week yields no deadline, rather than
 *    throwing out of a request path.
 *
 * Dates below are chosen deliberately: 2026-03-06 is a Friday and 2026-03-09 the
 * following Monday, in a week with no US DST transition, so a failure means the
 * day arithmetic is wrong rather than the zone.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { businessCalendar, responseDueAt, SUPPORT_TARGET_MEASURES, type BusinessCalendar } from '../src/helpers/support-calendar.js';

/** Mon–Fri, closing at 17:00 New York, no holidays. */
const NY: BusinessCalendar = {
  timeZone: 'America/New_York',
  days: [1, 2, 3, 4, 5],
  endHour: 17,
  holidays: new Set<string>(),
};

/** The local wall-clock reading of an instant, for readable assertions. */
const local = (at: Date | null, timeZone = 'America/New_York') => (at === null ? null : new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(at));

const KEYS = ['SUPPORT_BUSINESS_HOURS_TZ', 'SUPPORT_BUSINESS_HOURS_DAYS', 'SUPPORT_BUSINESS_HOURS_END_HOUR', 'SUPPORT_BUSINESS_HOURS_HOLIDAYS'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('the published measures', () => {
  it('states business DAYS for the two business-hours levels', () => {
    expect(SUPPORT_TARGET_MEASURES.support_standard).toEqual({ kind: 'business-days', days: 2 });
    expect(SUPPORT_TARGET_MEASURES.support_priority).toEqual({ kind: 'business-days', days: 1 });
  });

  it('states ELAPSED hours for premium, which is its whole 24x7 claim', () => {
    expect(SUPPORT_TARGET_MEASURES.support_premium).toEqual({ kind: 'elapsed-hours', hours: 8 });
  });

  it('returns null for a level with no target rather than guessing one', () => {
    expect(responseDueAt(new Date(), 'support_enterprise_bespoke', NY)).toBeNull();
    expect(responseDueAt(new Date(), '', NY)).toBeNull();
  });
});

describe('premium consults no calendar', () => {
  it('is 8 hours later, even over a weekend', () => {
    // Saturday 22:00 UTC. A business calendar would push this to Monday; the
    // point of premium is that it does not.
    const at = new Date('2026-03-07T22:00:00Z');
    expect(responseDueAt(at, 'support_premium', NY)).toEqual(new Date('2026-03-08T06:00:00Z'));
  });

  it('is unaffected by the working week, the end hour or a holiday', () => {
    const odd: BusinessCalendar = { timeZone: 'UTC', days: [], endHour: 3, holidays: new Set(['2026-03-07', '2026-03-08']) };
    const at = new Date('2026-03-07T22:00:00Z');
    expect(responseDueAt(at, 'support_premium', odd)).toEqual(new Date('2026-03-08T06:00:00Z'));
  });
});

describe('next business day (priority)', () => {
  it('means TOMORROW, whatever time today the case arrived', () => {
    // Monday 2026-03-02, early and late. Both due at Tuesday's close. If the
    // early case were due "later today" the target would be an hours clock.
    const early = responseDueAt(new Date('2026-03-02T14:05:00Z'), 'support_priority', NY); // 09:05 NY
    const late = responseDueAt(new Date('2026-03-02T21:59:00Z'), 'support_priority', NY); // 16:59 NY
    expect(local(early)).toBe('2026-03-03, 17:00');
    expect(local(late)).toBe('2026-03-03, 17:00');
  });

  it('a FRIDAY case is due Monday, not Saturday', () => {
    // The claim the whole business-day framing exists to make.
    expect(local(responseDueAt(new Date('2026-03-06T22:01:00Z'), 'support_priority', NY))).toBe('2026-03-09, 17:00');
  });

  it('a WEEKEND case starts counting from the next working day', () => {
    // Opened Saturday, so Monday is the first working day and Monday's close is
    // the deadline — the reading that favours the customer.
    expect(local(responseDueAt(new Date('2026-03-07T15:00:00Z'), 'support_priority', NY))).toBe('2026-03-09, 17:00');
    expect(local(responseDueAt(new Date('2026-03-08T15:00:00Z'), 'support_priority', NY))).toBe('2026-03-09, 17:00');
  });

  it('skips a holiday', () => {
    const withHoliday: BusinessCalendar = { ...NY, holidays: new Set(['2026-03-03']) };
    expect(local(responseDueAt(new Date('2026-03-02T14:00:00Z'), 'support_priority', withHoliday))).toBe('2026-03-04, 17:00');
  });
});

describe('two business days (standard)', () => {
  it('is Wednesday for a Monday case', () => {
    expect(local(responseDueAt(new Date('2026-03-02T14:00:00Z'), 'support_standard', NY))).toBe('2026-03-04, 17:00');
  });

  it('a THURSDAY case crosses the weekend to Monday', () => {
    // Thu -> Fri (1) -> Mon (2). Six calendar days, two working ones: the
    // arithmetic "48 business hours" was hiding when it read as two days.
    expect(local(responseDueAt(new Date('2026-03-05T14:00:00Z'), 'support_standard', NY))).toBe('2026-03-09, 17:00');
  });

  it('is always LATER than priority for the same case', () => {
    // The ladder has to hold at every opening instant, not just on average.
    for (const iso of [
      '2026-03-02T14:00:00Z', '2026-03-05T14:00:00Z', '2026-03-06T22:01:00Z',
      '2026-03-07T15:00:00Z', '2026-03-09T09:00:00Z',
    ]) {
      const std = responseDueAt(new Date(iso), 'support_standard', NY)!;
      const pri = responseDueAt(new Date(iso), 'support_priority', NY)!;
      expect(std.getTime()).toBeGreaterThan(pri.getTime());
    }
  });
});

describe('the deadline lands at the configured CLOSE, in the configured zone', () => {
  it('uses the end hour', () => {
    expect(local(responseDueAt(new Date('2026-03-02T14:00:00Z'), 'support_priority', { ...NY, endHour: 20 })))
      .toBe('2026-03-03, 20:00');
  });

  it('is zone-correct across a DST transition', () => {
    // US DST starts 2026-03-08. A Friday 2026-03-06 case is due Monday the 9th
    // at 17:00 LOCAL — which is a different UTC instant than it would have been
    // the week before. A fixed-offset implementation gets this an hour wrong,
    // which is exactly why the config takes an IANA zone and not "EST".
    const due = responseDueAt(new Date('2026-03-06T22:01:00Z'), 'support_priority', NY)!;
    expect(local(due)).toBe('2026-03-09, 17:00');
    expect(due.toISOString()).toBe('2026-03-09T21:00:00.000Z'); // EDT = UTC-4
    const before = responseDueAt(new Date('2026-02-27T22:01:00Z'), 'support_priority', NY)!;
    expect(local(before)).toBe('2026-03-02, 17:00');
    expect(before.toISOString()).toBe('2026-03-02T22:00:00.000Z'); // EST = UTC-5
  });

  it('respects a different zone entirely', () => {
    const tokyo: BusinessCalendar = { ...NY, timeZone: 'Asia/Tokyo' };
    const due = responseDueAt(new Date('2026-03-02T01:00:00Z'), 'support_priority', tokyo)!;
    expect(local(due, 'Asia/Tokyo')).toBe('2026-03-03, 17:00');
  });
});

describe('a broken calendar never stops a case being opened', () => {
  it('yields no deadline when no day is a working day', () => {
    // Rather than looping forever looking for one.
    expect(responseDueAt(new Date('2026-03-02T14:00:00Z'), 'support_priority', { ...NY, days: [] })).toBeNull();
  });

  it('yields no deadline when the holiday list swallows the whole search window', () => {
    const allHolidays: string[] = [];
    for (let d = new Date('2026-03-02T12:00:00Z'); d < new Date('2027-06-01T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
      allHolidays.push(d.toISOString().slice(0, 10));
    }
    const cal: BusinessCalendar = { ...NY, holidays: new Set(allHolidays) };
    expect(responseDueAt(new Date('2026-03-02T14:00:00Z'), 'support_priority', cal)).toBeNull();
  });
});

describe('businessCalendar() reads the environment', () => {
  it('defaults to US Eastern as an IANA ZONE, Mon-Fri, 17:00, no holidays', () => {
    const cal = businessCalendar();
    // `America/New_York`, not `EST`: EST is permanently UTC-5, so an EST default
    // would put the desk an hour out for the eight months that are EDT.
    expect(cal.timeZone).toBe('America/New_York');
    expect(cal.days).toEqual([1, 2, 3, 4, 5]);
    expect(cal.endHour).toBe(17);
    expect(cal.holidays.size).toBe(0);
  });

  it('falls back to UTC for an unknown zone instead of throwing', () => {
    // A bad timezone must not surface as an Intl exception from inside a
    // request path, so the fallback is deliberate and validated here.
    process.env.SUPPORT_BUSINESS_HOURS_TZ = 'Mars/Olympus_Mons';
    expect(businessCalendar().timeZone).toBe('UTC');
  });

  it('accepts a configured zone that IS valid', () => {
    process.env.SUPPORT_BUSINESS_HOURS_TZ = 'Europe/London';
    expect(businessCalendar().timeZone).toBe('Europe/London');
  });

  it('parses the working week, dropping anything that is not a weekday index', () => {
    process.env.SUPPORT_BUSINESS_HOURS_DAYS = '0,6, 3 ,9,-1,abc,3';
    expect(businessCalendar().days).toEqual([0, 3, 6]);
  });

  it('parses holidays, dropping anything not YYYY-MM-DD', () => {
    process.env.SUPPORT_BUSINESS_HOURS_HOLIDAYS = '2026-12-25, 2027-01-01 ,25/12/2026,';
    expect([...businessCalendar().holidays].sort()).toEqual(['2026-12-25', '2027-01-01']);
  });

  it('clamps the end hour to a real hour', () => {
    process.env.SUPPORT_BUSINESS_HOURS_END_HOUR = '99';
    expect(businessCalendar().endHour).toBeLessThanOrEqual(23);
    process.env.SUPPORT_BUSINESS_HOURS_END_HOUR = '-5';
    expect(businessCalendar().endHour).toBeGreaterThanOrEqual(0);
  });
});
