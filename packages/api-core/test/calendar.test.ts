// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import {
  addDays, addMonths, addUtcMonths, civilIn, daysInMonth, endOf, instantOfCivil, isUsableTimeZone, isoDate, isoWeek,
  parseUnitLabel, periodLabel, shiftUnit, startOf, startOfUnit, timeZoneAbbreviation, unitLabel, weekdayOf,
} from '../src/utils/calendar.js';

const utc = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
const d = (year: number, month: number, day: number) => ({ year, month, day });

describe('month lengths', () => {
  it.each([
    [2026, 1, 31], [2026, 2, 28], [2028, 2, 29], [2100, 2, 28], [2000, 2, 29], [2026, 4, 30], [2026, 12, 31],
  ])('%i-%i has %i days', (y, m, n) => {
    expect(daysInMonth(y, m)).toBe(n);
  });
});

describe('addMonths', () => {
  it('clamps into a shorter month and returns to the anchor after it', () => {
    let c = d(2026, 1, 31);
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      c = addMonths(c, 1, 31);
      seen.push(`${c.month}-${c.day}`);
    }
    expect(seen).toEqual(['2-28', '3-31', '4-30', '5-31', '6-30']);
  });

  it('defaults the anchor to the start day, so a bare step clamps and stays', () => {
    expect(addMonths(d(2026, 1, 31), 1)).toEqual(d(2026, 2, 28));
    expect(addMonths(d(2026, 2, 28), 1)).toEqual(d(2026, 3, 28));
  });

  it('crosses years both ways', () => {
    expect(addMonths(d(2026, 12, 15), 1)).toEqual(d(2027, 1, 15));
    expect(addMonths(d(2026, 1, 15), -1)).toEqual(d(2025, 12, 15));
    expect(addMonths(d(2026, 3, 31), -13)).toEqual(d(2025, 2, 28));
  });

  it('an annual Feb 29 anchor lands on Feb 28 in a common year and Feb 29 in a leap one', () => {
    expect(addMonths(d(2028, 2, 29), 12, 29)).toEqual(d(2029, 2, 28));
    expect(addMonths(d(2031, 2, 28), 12, 29)).toEqual(d(2032, 2, 29));
  });

  it('refuses an anchor that is not a day of a month', () => {
    for (const bad of [0, 32, 1.5, Number.NaN]) expect(() => addMonths(d(2026, 1, 1), 1, bad)).toThrow(RangeError);
  });
});

describe('addUtcMonths', () => {
  it('keeps the time of day', () => {
    expect(addUtcMonths(new Date('2026-01-31T23:30:15.250Z'), 1, 31)).toEqual(new Date('2026-02-28T23:30:15.250Z'));
  });
});

describe('weeks', () => {
  it('weekdayOf counts 0 = Sunday', () => {
    expect(weekdayOf(d(2026, 11, 15))).toBe(0);
    expect(weekdayOf(d(2026, 11, 16))).toBe(1);
  });

  it.each([
    [d(2026, 1, 1), 2026, 1], [d(2027, 1, 1), 2026, 53], [d(2026, 12, 28), 2026, 53], [d(2027, 1, 4), 2027, 1],
    [d(2024, 12, 30), 2025, 1], [d(2026, 11, 16), 2026, 47],
  ])('isoWeek(%o) is %i-W%i', (c, year, week) => {
    expect(isoWeek(c)).toEqual({ year, week });
  });

  it('a week starts Monday by default, Sunday when asked', () => {
    expect(startOfUnit(d(2026, 11, 18), 'week')).toEqual(d(2026, 11, 16));
    expect(startOfUnit(d(2026, 11, 18), 'week', 'sunday')).toEqual(d(2026, 11, 15));
    expect(startOfUnit(d(2026, 11, 15), 'week')).toEqual(d(2026, 11, 9));
  });

  it("a Sunday week takes its Monday's ISO number, and the label resolves back to it", () => {
    const sundayStart = d(2026, 11, 15);
    expect(unitLabel(sundayStart, 'week', 'sunday')).toBe('2026-W47');
    expect(parseUnitLabel('2026-W47', 'week', 'sunday')).toEqual(sundayStart);
    expect(parseUnitLabel('2026-W47', 'week')).toEqual(d(2026, 11, 16));
  });

  it('refuses a 53rd week in a 52-week year', () => {
    expect(parseUnitLabel('2026-W53', 'week')).toEqual(d(2026, 12, 28));
    expect(parseUnitLabel('2025-W53', 'week')).toBeNull();
  });
});

describe('labels', () => {
  it.each([
    ['day', '2026-11-16'], ['week', '2026-W47'], ['month', '2026-11'], ['quarter', '2026-Q4'], ['year', '2026'],
  ] as const)('%s label round-trips', (unit, label) => {
    const start = parseUnitLabel(label, unit)!;
    expect(start).not.toBeNull();
    expect(unitLabel(start, unit)).toBe(label);
    expect(unitLabel(shiftUnit(start, unit, 1), unit)).not.toBe(label);
  });

  it('refuses dates that do not exist', () => {
    expect(parseUnitLabel('2026-02-29', 'day')).toBeNull();
    expect(parseUnitLabel('2028-02-29', 'day')).toEqual(d(2028, 2, 29));
    expect(parseUnitLabel('2026-13', 'month')).toBeNull();
    expect(parseUnitLabel('2026-Q5', 'quarter')).toBeNull();
    expect(parseUnitLabel('2026-11', 'week')).toBeNull();
  });
});

describe('zones', () => {
  const NY = 'America/New_York';

  it('reads wall-clock parts in a zone', () => {
    expect(civilIn(new Date('2026-11-16T03:00:00Z'), NY)).toEqual({ year: 2026, month: 11, day: 15, hour: 22, minute: 0, second: 0 });
  });

  it('finds the instant of a civil midnight on both sides of DST', () => {
    expect(instantOfCivil(d(2026, 7, 1), NY).toISOString()).toBe('2026-07-01T04:00:00.000Z');
    expect(instantOfCivil(d(2026, 12, 1), NY).toISOString()).toBe('2026-12-01T05:00:00.000Z');
  });

  it('a civil time inside the spring-forward gap settles just after it', () => {
    // 2026-03-08 02:30 does not exist in New York; 03:00 EDT is 07:00Z.
    expect(instantOfCivil({ ...d(2026, 3, 8), hour: 2, minute: 30, second: 0 }, NY).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('a midnight that a midnight switch skips resolves to when that day began, not the evening before', () => {
    // Santiago jumps 00:00 → 01:00 on 2026-09-06; the day starts at 01:00 -03 (04:00Z).
    expect(instantOfCivil(d(2026, 9, 6), 'America/Santiago').toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(startOf(new Date('2026-09-06T12:00:00Z'), 'week', { timeZone: 'America/Santiago', weekStart: 'sunday' }).toISOString())
      .toBe('2026-09-06T04:00:00.000Z');
  });

  it('a time the fall-back repeats resolves to its first occurrence', () => {
    // 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST) on 2026-11-01.
    expect(instantOfCivil({ ...d(2026, 11, 1), hour: 1, minute: 30, second: 0 }, NY).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('a week across the March switch is 167 hours, not 168', () => {
    const at = new Date('2026-03-10T12:00:00Z');
    const start = startOf(at, 'week', { timeZone: NY });
    const end = endOf(at, 'week', { timeZone: NY });
    expect(start.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(startOf(new Date('2026-03-05T12:00:00Z'), 'week', { timeZone: NY }).toISOString()).toBe('2026-03-02T05:00:00.000Z');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(168);
    const prev = startOf(new Date('2026-03-05T12:00:00Z'), 'week', { timeZone: NY });
    expect((start.getTime() - prev.getTime()) / 3_600_000).toBe(167);
  });

  it('labels and ISO dates read in the zone, not UTC', () => {
    const lateSunday = new Date('2026-11-16T03:00:00Z');
    expect(isoDate(lateSunday)).toBe('2026-11-16');
    expect(isoDate(lateSunday, NY)).toBe('2026-11-15');
    expect(periodLabel(lateSunday, 'week', { timeZone: NY })).toBe('2026-W46');
    expect(periodLabel(new Date('2026-01-01T03:00:00Z'), 'year', { timeZone: NY })).toBe('2025');
  });

  it('endOf is strictly after a boundary instant', () => {
    expect(endOf(utc('2026-12-01'), 'month')).toEqual(utc('2027-01-01'));
    expect(endOf(utc('2026-10-01'), 'quarter')).toEqual(utc('2027-01-01'));
  });

  it('the abbreviation follows DST', () => {
    expect(timeZoneAbbreviation(new Date('2026-07-01T12:00:00Z'), NY)).toBe('EDT');
    expect(timeZoneAbbreviation(new Date('2026-12-01T12:00:00Z'), NY)).toBe('EST');
  });

  it('recognises usable zones', () => {
    expect(isUsableTimeZone('Europe/London')).toBe(true);
    expect(isUsableTimeZone('Mars/Olympus')).toBe(false);
    expect(() => civilIn(new Date(), 'Mars/Olympus')).toThrow(RangeError);
  });

  it('addDays is pure civil arithmetic', () => {
    expect(addDays(d(2028, 2, 28), 1)).toEqual(d(2028, 2, 29));
    expect(addDays(d(2026, 1, 1), -1)).toEqual(d(2025, 12, 31));
  });
});
