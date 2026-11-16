// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Calendar arithmetic: civil dates, month lengths, period boundaries and labels,
 * in any IANA timezone, without a date library.
 *
 * Billing periods, report periods, cron schedules and support deadlines are all
 * defined on the CALENDAR, not on elapsed milliseconds. A month is 28 to 31 days
 * long and a week that crosses a DST switch is 167 or 169 hours, so adding a fixed
 * number of milliseconds drifts. Everything here works the same way instead:
 *
 * 1. read the wall-clock parts of an instant in a zone ({@link civilIn});
 * 2. do exact arithmetic on those parts ({@link addDays}, {@link addMonths}); and
 * 3. convert the resulting civil time back to an instant by measuring the zone's
 *    offset AT that instant ({@link instantOfCivil}).
 *
 * `Intl.DateTimeFormat` is the only tz database Node ships, which is why step 1
 * goes through it. Every function defaults to UTC, the zone every stored
 * timestamp and every billing period is in.
 *
 * Month length: {@link addMonths} clamps the day into the target month and takes
 * an explicit anchor day, so a period anchored on the 31st runs
 * Jan 31 → Feb 28 → Mar 31 → Apr 30 rather than sliding to the 28th for good.
 */

import type { WeekStart } from './params.js';

/** A calendar date: `month` is 1–12, `day` is 1–31. */
export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** A calendar date with a wall-clock time (24-hour). */
export interface CivilDateTime extends CivilDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The units a period can be measured in. */
export const CALENDAR_UNITS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export type CalendarUnit = (typeof CALENDAR_UNITS)[number];

const DAY_MS = 86_400_000;

/** One formatter per zone: constructing `Intl.DateTimeFormat` is the expensive part. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    // `en-CA` yields ISO-ordered parts; `h23` avoids the `24:00` midnight some
    // engines render under `hour12: false`.
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * Whether `timeZone` is a zone this runtime can compute in. A bare offset
 * (`+05:00`) or an unknown name is not.
 */
export function isUsableTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The wall-clock parts of `instant` as they read in `timeZone`.
 *
 * @throws RangeError when the zone is not one the runtime knows.
 */
export function civilIn(instant: Date, timeZone = 'UTC'): CivilDateTime {
  if (timeZone === 'UTC') {
    return {
      year: instant.getUTCFullYear(),
      month: instant.getUTCMonth() + 1,
      day: instant.getUTCDate(),
      hour: instant.getUTCHours(),
      minute: instant.getUTCMinutes(),
      second: instant.getUTCSeconds(),
    };
  }
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** `Date.UTC` of a civil date-time, treating its parts as if they were UTC. */
const naiveUtc = (c: CivilDate & Partial<CivilDateTime>): number =>
  Date.UTC(c.year, c.month - 1, c.day, c.hour ?? 0, c.minute ?? 0, c.second ?? 0);

/** How far ahead of UTC the zone's clock reads at `instant`, in ms. */
const offsetAt = (instant: number, timeZone: string): number => naiveUtc(civilIn(new Date(instant), timeZone)) - instant;

/**
 * The instant at which civil time `c` occurs in `timeZone` (midnight when no
 * time is given).
 *
 * The zone's offset is sampled a day either side of the target, which brackets
 * any real DST transition, and each candidate is checked by reading it back:
 *
 * - a time that occurs once gets that instant;
 * - a time the fall-back repeats gets the EARLIER of its two instants;
 * - a time inside the spring-forward gap does not occur, and is shifted forward
 *   by the gap's length (02:30 on a 02:00→03:00 night is 03:30). A civil midnight
 *   in a zone that switches at midnight therefore resolves to the moment that day
 *   began, never to the evening before.
 *
 * These are the `compatible` rules of `Temporal` and `java.time`.
 */
export function instantOfCivil(c: CivilDate & Partial<CivilDateTime>, timeZone = 'UTC'): Date {
  const target = naiveUtc(c);
  if (timeZone === 'UTC') return new Date(target);
  const before = target - offsetAt(target - DAY_MS, timeZone);
  const after = target - offsetAt(target + DAY_MS, timeZone);
  const reads = (instant: number): boolean => naiveUtc(civilIn(new Date(instant), timeZone)) === target;
  if (reads(Math.min(before, after))) return new Date(Math.min(before, after));
  if (reads(Math.max(before, after))) return new Date(Math.max(before, after));
  // In the gap: the pre-transition offset carries the time past it.
  return new Date(before);
}

/** The number of days in `month` (1–12) of `year`: 28, 29, 30 or 31. */
export function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The weekday of a civil date: 0 = Sunday … 6 = Saturday, as cron and `Date` count. */
export function weekdayOf(c: CivilDate): number {
  return new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay();
}

/** `c` moved by `days` (negative goes back). Pure civil arithmetic; no zone involved. */
export function addDays(c: CivilDate, days: number): CivilDate {
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * `c` moved by `months`, landing on `anchorDay` (default: `c.day`) clamped to the
 * target month's length.
 *
 * Passing the anchor rather than reading it off `c` is what keeps a series on its
 * day: Jan 31 + 1 month is Feb 28, and Feb 28 + 1 month with anchor 31 is Mar 31,
 * not Mar 28.
 *
 * @throws RangeError when `anchorDay` is not an integer 1–31.
 */
export function addMonths(c: CivilDate, months: number, anchorDay: number = c.day): CivilDate {
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new RangeError(`anchor day must be an integer 1-31, got ${anchorDay}`);
  }
  const index = c.year * 12 + (c.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return { year, month, day: Math.min(anchorDay, daysInMonth(year, month)) };
}

/**
 * `instant` moved by `months` in UTC, landing on `anchorDay` clamped to the month
 * and keeping the time of day. The billing-period step.
 */
export function addUtcMonths(instant: Date, months: number, anchorDay: number = instant.getUTCDate()): Date {
  const c = civilIn(instant);
  const date = addMonths(c, months, anchorDay);
  return new Date(Date.UTC(
    date.year, date.month - 1, date.day,
    instant.getUTCHours(), instant.getUTCMinutes(), instant.getUTCSeconds(), instant.getUTCMilliseconds(),
  ));
}

/** The civil date that starts the `unit` containing `c`. Quarters start Jan/Apr/Jul/Oct. */
export function startOfUnit(c: CivilDate, unit: CalendarUnit, weekStart: WeekStart = 'monday'): CivilDate {
  switch (unit) {
    case 'day':
      return { year: c.year, month: c.month, day: c.day };
    case 'week': {
      const first = weekStart === 'sunday' ? 0 : 1;
      return addDays(c, -((weekdayOf(c) - first + 7) % 7));
    }
    case 'month':
      return { year: c.year, month: c.month, day: 1 };
    case 'quarter':
      return { year: c.year, month: Math.floor((c.month - 1) / 3) * 3 + 1, day: 1 };
    case 'year':
      return { year: c.year, month: 1, day: 1 };
  }
}

/** A period start moved by `n` whole units. */
export function shiftUnit(start: CivilDate, unit: CalendarUnit, n: number): CivilDate {
  switch (unit) {
    case 'day': return addDays(start, n);
    case 'week': return addDays(start, 7 * n);
    case 'month': return addMonths(start, n);
    case 'quarter': return addMonths(start, 3 * n);
    case 'year': return addMonths(start, 12 * n);
  }
}

/** The ISO-8601 week-numbering year and week (1–53) of a civil date. */
export function isoWeek(c: CivilDate): { year: number; week: number } {
  // The ISO week belongs to the year of its Thursday.
  const thursday = addDays(c, 3 - ((weekdayOf(c) + 6) % 7));
  const jan1 = Date.UTC(thursday.year, 0, 1);
  const week = Math.floor((naiveUtc(thursday) - jan1) / (7 * DAY_MS)) + 1;
  return { year: thursday.year, week };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** `YYYY-MM-DD` of a civil date. */
export const isoDateOf = (c: CivilDate): string => `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)}`;

/**
 * The label of the `unit` containing `c`:
 * `2026-11-16`, `2026-W47`, `2026-11`, `2026-Q4` or `2026`.
 *
 * Weeks are labelled by ISO week even when they start on Sunday: `2026-W47` is a
 * recognised notation, and a Sunday-based numbering would not compare with
 * anything else. A Sunday week takes the number of the ISO week its Monday is in,
 * so it shares a label with the Monday week it overlaps by six days.
 */
export function unitLabel(c: CivilDate, unit: CalendarUnit, weekStart: WeekStart = 'monday'): string {
  switch (unit) {
    case 'day': return isoDateOf(c);
    case 'week': {
      const start = startOfUnit(c, 'week', weekStart);
      const { year, week } = isoWeek(weekStart === 'sunday' ? addDays(start, 1) : start);
      return `${year}-W${pad(week)}`;
    }
    case 'month': return `${pad(c.year, 4)}-${pad(c.month)}`;
    case 'quarter': return `${pad(c.year, 4)}-Q${Math.floor((c.month - 1) / 3) + 1}`;
    case 'year': return pad(c.year, 4);
  }
}

/**
 * The civil start of the period a {@link unitLabel} names, or null when the label
 * does not parse, does not match `unit`, or names a date that does not exist
 * (`2026-02-30`, a 53rd week in a 52-week year).
 */
export function parseUnitLabel(label: string, unit: CalendarUnit, weekStart: WeekStart = 'monday'): CivilDate | null {
  let m: RegExpExecArray | null;
  switch (unit) {
    case 'day': {
      m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
      if (!m) return null;
      const c = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
      return c.month >= 1 && c.month <= 12 && c.day >= 1 && c.day <= daysInMonth(c.year, c.month) ? c : null;
    }
    case 'week': {
      m = /^(\d{4})-W(\d{2})$/.exec(label);
      if (!m) return null;
      const year = Number(m[1]);
      const week = Number(m[2]);
      if (week < 1 || week > 53) return null;
      // ISO week 1 is the Monday week containing Jan 4th. A Sunday week carries
      // the number of its Monday, so it starts the day before.
      const monday = shiftUnit(startOfUnit({ year, month: 1, day: 4 }, 'week'), 'week', week - 1);
      const iso = isoWeek(monday);
      if (iso.year !== year || iso.week !== week) return null;
      return weekStart === 'sunday' ? addDays(monday, -1) : monday;
    }
    case 'month': {
      m = /^(\d{4})-(\d{2})$/.exec(label);
      if (!m) return null;
      const month = Number(m[2]);
      return month >= 1 && month <= 12 ? { year: Number(m[1]), month, day: 1 } : null;
    }
    case 'quarter': {
      m = /^(\d{4})-Q([1-4])$/.exec(label);
      return m ? { year: Number(m[1]), month: (Number(m[2]) - 1) * 3 + 1, day: 1 } : null;
    }
    case 'year': {
      m = /^(\d{4})$/.exec(label);
      return m ? { year: Number(m[1]), month: 1, day: 1 } : null;
    }
  }
}

/** Options for the instant-level helpers. */
export interface ZoneOptions {
  /** IANA zone the calendar is read in. Default UTC. */
  timeZone?: string;
  /** Default Monday (ISO). */
  weekStart?: WeekStart;
}

/** The instant the `unit` containing `instant` starts, in the given zone. */
export function startOf(instant: Date, unit: CalendarUnit, opts: ZoneOptions = {}): Date {
  const tz = opts.timeZone ?? 'UTC';
  return instantOfCivil(startOfUnit(civilIn(instant, tz), unit, opts.weekStart), tz);
}

/**
 * The instant the `unit` containing `instant` ends (exclusive), which is the next
 * one's start. Strictly after `instant`, even when `instant` sits on a boundary.
 */
export function endOf(instant: Date, unit: CalendarUnit, opts: ZoneOptions = {}): Date {
  const tz = opts.timeZone ?? 'UTC';
  return instantOfCivil(shiftUnit(startOfUnit(civilIn(instant, tz), unit, opts.weekStart), unit, 1), tz);
}

/** The {@link unitLabel} of the `unit` containing `instant`, read in the given zone. */
export function periodLabel(instant: Date, unit: CalendarUnit, opts: ZoneOptions = {}): string {
  const tz = opts.timeZone ?? 'UTC';
  return unitLabel(civilIn(instant, tz), unit, opts.weekStart);
}

/** `YYYY-MM-DD` of `instant` as read in `timeZone` (default UTC). */
export function isoDate(instant: Date, timeZone = 'UTC'): string {
  return isoDateOf(civilIn(instant, timeZone));
}

/**
 * The zone's abbreviation at `instant` (`EST` in winter, `EDT` in summer), or the
 * zone name when the runtime has no short name for it.
 */
export function timeZoneAbbreviation(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(instant);
  return parts.find((p) => p.type === 'timeZoneName')?.value || timeZone;
}
