// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Period resolution for scheduled reports: which complete week, month or quarter
 * a run covers, and the one before it for comparison.
 *
 * A report covers the LAST COMPLETE period, never a partial one. "Deploys this
 * week" on a Monday morning means last week — a manager reading a half-finished
 * week sees numbers that change under them.
 *
 * Everything here is computed in the report's IANA timezone, without a date
 * library. `Intl.DateTimeFormat` with a `timeZone` is the only tz database Node
 * ships, so the approach is: read the wall-clock parts in that zone, do civil
 * arithmetic on them (which is exact — months and quarters are defined on the
 * calendar, not on elapsed milliseconds), then convert the resulting civil
 * midnight back to a UTC instant by measuring the zone's offset AT that instant.
 *
 * Measuring the offset at the target instant rather than at `now` is what makes
 * DST correct: a weekly period that starts before a transition and ends after it
 * is not 168 hours long, and a resolver that added `7 * 24 * 3600_000` would
 * silently shift every boundary by an hour for half the year.
 */

import type { ReportCadence } from '../../../database/schema/reporting-stakeholder.js';

/** One resolved reporting period, plus the previous one for comparison. */
export interface ResolvedPeriod {
  /** Inclusive start of the period being reported (UTC instant). */
  start: Date;
  /** Exclusive end — also the start of the period in progress. */
  end: Date;
  /** Inclusive start of the PREVIOUS period, for period-over-period change. */
  prevStart: Date;
  /** Exclusive end of the previous period (=== `start`). */
  prevEnd: Date;
  /** Human label in the report's timezone: `2026-W38`, `2026-08`, `2026-Q3`. */
  label: string;
}

/** Civil (wall-clock) date parts in a given zone. */
interface Civil { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** Read the wall-clock parts of `instant` as they read in `tz`. */
function civilIn(instant: Date, tz: string): Civil {
  // `en-CA` yields ISO-ish `YYYY-MM-DD`, and hourCycle h23 avoids a 24:00 hour.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * The UTC instant at which the given civil time occurs in `tz`.
 *
 * Two passes: guess by treating the civil time as UTC, measure how far that guess
 * actually lands from the target in `tz`, correct, then re-measure once. The
 * second pass matters exactly at a DST transition, where the first correction can
 * overshoot into the other offset.
 *
 * For a civil midnight that does not exist (spring-forward skips it) this settles
 * on the instant just after the gap, which is the start of the day as that zone
 * experienced it — the right answer for a period boundary.
 */
function instantOfCivil(c: { year: number; month: number; day: number }, tz: string): Date {
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, 0, 0, 0);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const back = civilIn(new Date(guess), tz);
    const backUtc = Date.UTC(back.year, back.month - 1, back.day, back.hour, back.minute, back.second);
    const drift = backUtc - asUtc;
    if (drift === 0) break;
    guess -= drift;
  }
  return new Date(guess);
}

/** 0 = Monday … 6 = Sunday, for a civil date (Zeller-free: use a UTC probe). */
function civilWeekday(c: { year: number; month: number; day: number }): number {
  const dow = new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay(); // 0=Sun
  return (dow + 6) % 7; // 0=Mon
}

/** Add `days` to a civil date, normalising via UTC arithmetic (no tz involved). */
function addCivilDays(c: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Add `months` to a civil date, clamping the day into the target month. */
function addCivilMonths(c: { year: number; month: number; day: number }, months: number): { year: number; month: number; day: number } {
  const zeroBased = (c.year * 12) + (c.month - 1) + months;
  const year = Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day: Math.min(c.day, lastDay) };
}

/** The civil start of the period containing `c`. */
function startOfPeriod(
  c: Civil,
  cadence: ReportCadence,
  weekStart: 'monday' | 'sunday',
): { year: number; month: number; day: number } {
  const date = { year: c.year, month: c.month, day: c.day };
  if (cadence === 'weekly') {
    const mondayIndex = civilWeekday(date);
    // Sunday weeks start one day earlier than the Monday index implies.
    const back = weekStart === 'sunday' ? (mondayIndex + 1) % 7 : mondayIndex;
    return addCivilDays(date, -back);
  }
  if (cadence === 'monthly') return { year: c.year, month: c.month, day: 1 };
  // Quarterly: Jan/Apr/Jul/Oct.
  const qStartMonth = Math.floor((c.month - 1) / 3) * 3 + 1;
  return { year: c.year, month: qStartMonth, day: 1 };
}

/** Shift a civil period start by `n` whole periods. */
function shiftPeriod(
  start: { year: number; month: number; day: number },
  cadence: ReportCadence,
  n: number,
): { year: number; month: number; day: number } {
  if (cadence === 'weekly') return addCivilDays(start, 7 * n);
  if (cadence === 'monthly') return addCivilMonths(start, n);
  return addCivilMonths(start, 3 * n);
}

/**
 * ISO-8601 week number of a civil date. Used only for the weekly LABEL, and
 * deliberately ISO even for a Sunday-week org: `2026-W38` is a recognised
 * notation and inventing a Sunday-based numbering would make labels
 * non-comparable with anything else.
 */
function isoWeek(c: { year: number; month: number; day: number }): { year: number; week: number } {
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day));
  const day = (d.getUTCDay() + 6) % 7; // 0=Mon
  d.setUTCDate(d.getUTCDate() - day + 3); // nearest Thursday
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { year: isoYear, week };
}

/** The label for a period, from its civil start. */
function formatLabel(start: { year: number; month: number; day: number }, cadence: ReportCadence): string {
  if (cadence === 'weekly') {
    const { year, week } = isoWeek(start);
    return `${year}-W${String(week).padStart(2, '0')}`;
  }
  if (cadence === 'monthly') return `${start.year}-${String(start.month).padStart(2, '0')}`;
  return `${start.year}-Q${Math.floor((start.month - 1) / 3) + 1}`;
}

/**
 * Resolve the last COMPLETE period for `cadence` in `tz`.
 *
 * The period in progress is excluded: its end is the boundary, so a Monday run
 * reports last week and a run on the 1st reports last month.
 */
export function resolvePeriod(
  cadence: ReportCadence,
  tz: string,
  weekStart: 'monday' | 'sunday' = 'monday',
  now: Date = new Date(),
): ResolvedPeriod {
  const nowCivil = civilIn(now, tz);
  // Start of the period CONTAINING now = end of the last complete one.
  const currentStart = startOfPeriod(nowCivil, cadence, weekStart);
  const start = shiftPeriod(currentStart, cadence, -1);
  const prevStart = shiftPeriod(currentStart, cadence, -2);
  return {
    start: instantOfCivil(start, tz),
    end: instantOfCivil(currentStart, tz),
    prevStart: instantOfCivil(prevStart, tz),
    prevEnd: instantOfCivil(start, tz),
    label: formatLabel(start, cadence),
  };
}

/**
 * Resolve a SPECIFIC period by its label (`2026-W38`, `2026-08`, `2026-Q3`), for
 * on-demand runs and backfills. Returns null when the label does not parse or
 * does not match the cadence.
 */
export function resolvePeriodByLabel(
  label: string,
  cadence: ReportCadence,
  tz: string,
  weekStart: 'monday' | 'sunday' = 'monday',
): ResolvedPeriod | null {
  let start: { year: number; month: number; day: number } | null = null;

  const week = /^(\d{4})-W(\d{2})$/.exec(label);
  const month = /^(\d{4})-(\d{2})$/.exec(label);
  const quarter = /^(\d{4})-Q([1-4])$/.exec(label);

  if (cadence === 'weekly' && week) {
    const year = Number(week[1]);
    const wk = Number(week[2]);
    if (wk < 1 || wk > 53) return null;
    // ISO week 1 contains Jan 4th; walk back to that week's start.
    const jan4 = { year, month: 1, day: 4 };
    const week1Start = startOfPeriod(
      { ...jan4, hour: 0, minute: 0, second: 0 },
      'weekly',
      weekStart,
    );
    start = addCivilDays(week1Start, (wk - 1) * 7);
    // A 53rd week that does not exist in this ISO year lands in the next one.
    if (isoWeek(start).year !== year && wk === 53) return null;
  } else if (cadence === 'monthly' && month) {
    const m = Number(month[2]);
    if (m < 1 || m > 12) return null;
    start = { year: Number(month[1]), month: m, day: 1 };
  } else if (cadence === 'quarterly' && quarter) {
    start = { year: Number(quarter[1]), month: (Number(quarter[2]) - 1) * 3 + 1, day: 1 };
  }
  if (!start) return null;

  const end = shiftPeriod(start, cadence, 1);
  const prevStart = shiftPeriod(start, cadence, -1);
  return {
    start: instantOfCivil(start, tz),
    end: instantOfCivil(end, tz),
    prevStart: instantOfCivil(prevStart, tz),
    prevEnd: instantOfCivil(start, tz),
    label: formatLabel(start, cadence),
  };
}

/**
 * Why a period cannot be reported. Returned rather than thrown so a route can
 * turn it into a 4xx with the reason, and the scheduler can pause with it.
 */
export type PeriodRejection =
  | { reason: 'in_progress'; message: string }
  | { reason: 'before_retention'; message: string };

/**
 * Refuse a period the org's data cannot support.
 *
 * A window older than the retention horizon must be REFUSED with the reason, not
 * silently truncated: a report labelled `2026-Q1` that quietly covers only the
 * last 30 days of it is worse than no report, because a manager cannot tell.
 *
 * `minFromMs` is the retention floor from `orgRetentionWindowFromSettings`
 * (0 = unlimited).
 */
export function rejectUnreportablePeriod(
  period: ResolvedPeriod,
  opts: { minFromMs: number; now?: Date; includePrevious?: boolean },
): PeriodRejection | null {
  const now = opts.now ?? new Date();
  if (period.end.getTime() > now.getTime()) {
    return {
      reason: 'in_progress',
      message: `Period ${period.label} has not finished yet (ends ${period.end.toISOString()}). A report covers the last COMPLETE period.`,
    };
  }
  if (opts.minFromMs > 0) {
    // The comparison period is part of the report when a section shows change, so
    // its start is the real floor — otherwise "vs last week" silently reads zero.
    const earliest = opts.includePrevious === false ? period.start : period.prevStart;
    if (earliest.getTime() < opts.minFromMs) {
      return {
        reason: 'before_retention',
        message: `Period ${period.label} starts ${earliest.toISOString()}, before this organization's reporting retention horizon (${new Date(opts.minFromMs).toISOString()}). The underlying events have been purged.`,
      };
    }
  }
  return null;
}

/**
 * The instant the period CONTAINING `from` ends — that is, the moment the next
 * complete period becomes reportable.
 *
 * This is what a definition's `nextRunAt` is derived from, and it is deliberately
 * the boundary rather than "last run + 7 days": a weekly report whose next run is
 * computed by adding elapsed milliseconds drifts an hour at every DST transition
 * and eventually fires on a Sunday. The boundary is a calendar fact in the
 * report's own timezone, so it is the same answer whatever the previous run did.
 *
 * Strictly after `from`: a `from` sitting exactly on a boundary gets the NEXT one,
 * so a run that completes at the instant of the boundary cannot re-claim it.
 */
export function nextPeriodBoundary(
  cadence: ReportCadence,
  tz: string,
  weekStart: 'monday' | 'sunday' = 'monday',
  from: Date = new Date(),
): Date {
  const containing = startOfPeriod(civilIn(from, tz), cadence, weekStart);
  return instantOfCivil(shiftPeriod(containing, cadence, 1), tz);
}

/**
 * Every COMPLETE period that ended after `since`, oldest first.
 *
 * This is the catch-up list: a service that was down over a weekend, a definition
 * created with a back-dated `nextRunAt`, or a scheduler disabled by its kill switch
 * for a fortnight all leave periods that were never reported. Returning them in
 * order matters — a manager reading three weekly reports that arrive at once needs
 * them to make sense read downwards.
 *
 * `max` bounds the walk. A definition untouched for two years must not produce 104
 * weekly reports in one cycle; the cap means the oldest are skipped, which is the
 * right trade — nobody wants last April's weekly status, and the snapshot for it
 * would be past the retention horizon anyway.
 */
export function completePeriodsSince(
  cadence: ReportCadence,
  tz: string,
  weekStart: 'monday' | 'sunday',
  since: Date | null,
  now: Date = new Date(),
  max = 4,
): ResolvedPeriod[] {
  const latest = resolvePeriod(cadence, tz, weekStart, now);
  if (max <= 0) return [];
  // No previous run: report the latest complete period only. A definition created
  // today does not owe its owner a backfill they never asked for.
  if (!since) return [latest];

  const out: ResolvedPeriod[] = [];
  const latestStart = startOfPeriod(civilIn(latest.start, tz), cadence, weekStart);
  for (let back = 0; back < max; back += 1) {
    const start = shiftPeriod(latestStart, cadence, -back);
    const instant = instantOfCivil(start, tz);
    // `since` is the last run's period END for a run that happened, so a period
    // whose end is at or before it has already been reported.
    if (instantOfCivil(shiftPeriod(start, cadence, 1), tz).getTime() <= since.getTime()) break;
    const prevStart = shiftPeriod(start, cadence, -1);
    out.push({
      start: instant,
      end: instantOfCivil(shiftPeriod(start, cadence, 1), tz),
      prevStart: instantOfCivil(prevStart, tz),
      prevEnd: instant,
      label: formatLabel(start, cadence),
    });
  }
  return out.reverse();
}
