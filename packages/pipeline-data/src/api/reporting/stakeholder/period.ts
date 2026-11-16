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
 * Everything here is computed in the report's IANA timezone with api-core's
 * calendar, which does civil arithmetic and measures the zone's offset at each
 * boundary. That is what makes DST correct: a weekly period that crosses a
 * transition is not 168 hours long, and adding `7 * 24 * 3600_000` would shift
 * every boundary by an hour for half the year.
 */

import {
  civilIn, instantOfCivil, parseUnitLabel, shiftUnit, startOfUnit, unitLabel,
  type CalendarUnit, type CivilDate, type WeekStart,
} from '@pipeline-builder/api-core';
import type { ReportCadence } from '../../../database/schema/reporting-stakeholder.js';

/** The calendar unit each cadence reports on. */
const UNIT: Readonly<Record<ReportCadence, CalendarUnit>> = { weekly: 'week', monthly: 'month', quarterly: 'quarter' };

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

/** One resolved period, from its civil start. */
function periodFrom(start: CivilDate, cadence: ReportCadence, tz: string, weekStart: WeekStart): ResolvedPeriod {
  const unit = UNIT[cadence];
  return {
    start: instantOfCivil(start, tz),
    end: instantOfCivil(shiftUnit(start, unit, 1), tz),
    prevStart: instantOfCivil(shiftUnit(start, unit, -1), tz),
    prevEnd: instantOfCivil(start, tz),
    label: unitLabel(start, unit, weekStart),
  };
}

/** The civil start of the period containing `instant`, read in `tz`. */
const containingStart = (instant: Date, cadence: ReportCadence, tz: string, weekStart: WeekStart): CivilDate =>
  startOfUnit(civilIn(instant, tz), UNIT[cadence], weekStart);

/**
 * Resolve the last COMPLETE period for `cadence` in `tz`.
 *
 * The period in progress is excluded: its end is the boundary, so a Monday run
 * reports last week and a run on the 1st reports last month.
 */
export function resolvePeriod(
  cadence: ReportCadence,
  tz: string,
  weekStart: WeekStart = 'monday',
  now: Date = new Date(),
): ResolvedPeriod {
  // Start of the period CONTAINING now = end of the last complete one.
  const currentStart = containingStart(now, cadence, tz, weekStart);
  return periodFrom(shiftUnit(currentStart, UNIT[cadence], -1), cadence, tz, weekStart);
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
  weekStart: WeekStart = 'monday',
): ResolvedPeriod | null {
  const start = parseUnitLabel(label, UNIT[cadence], weekStart);
  return start ? periodFrom(start, cadence, tz, weekStart) : null;
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
  weekStart: WeekStart = 'monday',
  from: Date = new Date(),
): Date {
  return instantOfCivil(shiftUnit(containingStart(from, cadence, tz, weekStart), UNIT[cadence], 1), tz);
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
  weekStart: WeekStart,
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
  const latestStart = containingStart(latest.start, cadence, tz, weekStart);
  for (let back = 0; back < max; back += 1) {
    const period = periodFrom(shiftUnit(latestStart, UNIT[cadence], -back), cadence, tz, weekStart);
    // `since` is the last run's period END for a run that happened, so a period
    // whose end is at or before it has already been reported.
    if (period.end.getTime() <= since.getTime()) break;
    out.push(period);
  }
  return out.reverse();
}
