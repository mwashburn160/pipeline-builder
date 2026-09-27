// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Period resolution for scheduled reports.
 *
 * This is the piece most likely to be subtly wrong, and wrong here means a
 * manager's weekly report silently covers the wrong days. Three hazards it has to
 * survive:
 *
 *  - DST. A week spanning a transition is not 168 hours. Anything that added
 *    `7 * 24 * 3600_000` would shift every boundary by an hour for half the year.
 *  - Month/quarter arithmetic is CIVIL, not elapsed time — months differ in
 *    length, so it has to be done on calendar fields.
 *  - Timezone. The period must be cut where the team works, not where the
 *    database session happens to be.
 */

import { describe, it, expect } from '@jest/globals';
import {
  rejectUnreportablePeriod,
  resolvePeriod,
  resolvePeriodByLabel,
} from '../src/api/reporting/stakeholder/period.js';

const CHICAGO = 'America/Chicago';
const UTC = 'UTC';

/** The wall-clock reading of an instant in a zone, for assertions. */
function wall(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant).replace(', ', ' ');
}

describe('resolvePeriod — weekly', () => {
  it('reports the LAST COMPLETE week, not the one in progress', () => {
    // Wednesday 2026-09-23 in Chicago.
    const now = new Date('2026-09-23T15:00:00Z');
    const p = resolvePeriod('weekly', CHICAGO, 'monday', now);
    // Monday 2026-09-14 → Monday 2026-09-21 (exclusive).
    expect(wall(p.start, CHICAGO)).toBe('2026-09-14 00:00');
    expect(wall(p.end, CHICAGO)).toBe('2026-09-21 00:00');
  });

  it('starts the week at local midnight, so Sunday evening belongs to the right week', () => {
    // The original defect: bucketing in UTC put Chicago's Sunday 18:00-24:00 into
    // the NEXT week, so Monday's report lost Sunday evening's work.
    const p = resolvePeriod('weekly', CHICAGO, 'monday', new Date('2026-09-23T15:00:00Z'));
    // Local midnight Monday is 05:00 UTC (CDT, UTC-5) — not 00:00 UTC.
    expect(p.start.toISOString()).toBe('2026-09-14T05:00:00.000Z');
  });

  it('gives the previous week as the comparison period, contiguous with the reported one', () => {
    const p = resolvePeriod('weekly', CHICAGO, 'monday', new Date('2026-09-23T15:00:00Z'));
    expect(wall(p.prevStart, CHICAGO)).toBe('2026-09-07 00:00');
    // No gap and no overlap: prevEnd IS start.
    expect(p.prevEnd.getTime()).toBe(p.start.getTime());
  });

  it('shifts the boundary a day earlier for a Sunday-week org', () => {
    const mon = resolvePeriod('weekly', CHICAGO, 'monday', new Date('2026-09-23T15:00:00Z'));
    const sun = resolvePeriod('weekly', CHICAGO, 'sunday', new Date('2026-09-23T15:00:00Z'));
    expect(wall(sun.start, CHICAGO)).toBe('2026-09-13 00:00');
    expect(wall(sun.end, CHICAGO)).toBe('2026-09-20 00:00');
    expect(sun.start.getTime()).toBeLessThan(mon.start.getTime());
  });

  it('is exactly 7 local days across the US spring-forward, not 168 hours', () => {
    // US DST begins Sunday 2026-03-08. The week containing it is 167 hours long.
    const p = resolvePeriod('weekly', CHICAGO, 'monday', new Date('2026-03-17T12:00:00Z'));
    expect(wall(p.start, CHICAGO)).toBe('2026-03-09 00:00');
    expect(wall(p.end, CHICAGO)).toBe('2026-03-16 00:00');
    const hours = (p.end.getTime() - p.start.getTime()) / 3_600_000;
    // Both boundaries are after the transition here, so this week IS 168h —
    // what matters is that both land on local midnight.
    expect(hours).toBe(168);
  });

  it('keeps both boundaries at local midnight for the week that CONTAINS the transition', () => {
    // Reporting on the week of 2026-03-02..03-09, which contains spring-forward:
    // 167 hours, and any elapsed-ms arithmetic would put the end at 23:00.
    const p = resolvePeriod('weekly', CHICAGO, 'monday', new Date('2026-03-10T12:00:00Z'));
    expect(wall(p.start, CHICAGO)).toBe('2026-03-02 00:00');
    expect(wall(p.end, CHICAGO)).toBe('2026-03-09 00:00');
    expect((p.end.getTime() - p.start.getTime()) / 3_600_000).toBe(167);
  });

  it('keeps both boundaries at local midnight across fall-back (169 hours)', () => {
    // US DST ends Sunday 2026-11-01, so the week Mon 10-26 → Mon 11-02 contains the
    // transition and is 169 hours long. `now` must sit in the FOLLOWING week for
    // that to be the last complete one.
    const p = resolvePeriod('weekly', CHICAGO, 'monday', new Date('2026-11-05T12:00:00Z'));
    expect(wall(p.start, CHICAGO)).toBe('2026-10-26 00:00');
    expect(wall(p.end, CHICAGO)).toBe('2026-11-02 00:00');
    expect((p.end.getTime() - p.start.getTime()) / 3_600_000).toBe(169);
  });

  it('labels the week ISO-style', () => {
    const p = resolvePeriod('weekly', UTC, 'monday', new Date('2026-09-23T15:00:00Z'));
    expect(p.label).toMatch(/^2026-W\d{2}$/);
  });
});

describe('resolvePeriod — monthly', () => {
  it('reports the last complete month', () => {
    const p = resolvePeriod('monthly', CHICAGO, 'monday', new Date('2026-09-15T12:00:00Z'));
    expect(wall(p.start, CHICAGO)).toBe('2026-08-01 00:00');
    expect(wall(p.end, CHICAGO)).toBe('2026-09-01 00:00');
    expect(p.label).toBe('2026-08');
  });

  it('handles the January boundary by rolling the year', () => {
    const p = resolvePeriod('monthly', UTC, 'monday', new Date('2026-01-10T12:00:00Z'));
    expect(p.label).toBe('2025-12');
    expect(wall(p.prevStart, UTC)).toBe('2025-11-01 00:00');
  });

  it('does not lose a day comparing a 31-day month to a 28-day one', () => {
    // Civil arithmetic, not elapsed ms: March's previous month is February,
    // whatever their lengths.
    const p = resolvePeriod('monthly', UTC, 'monday', new Date('2026-04-05T12:00:00Z'));
    expect(p.label).toBe('2026-03');
    expect(wall(p.start, UTC)).toBe('2026-03-01 00:00');
    expect(wall(p.prevStart, UTC)).toBe('2026-02-01 00:00');
    expect(wall(p.prevEnd, UTC)).toBe('2026-03-01 00:00');
  });
});

describe('resolvePeriod — quarterly', () => {
  it('reports the last complete quarter', () => {
    const p = resolvePeriod('quarterly', UTC, 'monday', new Date('2026-08-15T12:00:00Z'));
    // Q3 is in progress ⇒ report Q2.
    expect(p.label).toBe('2026-Q2');
    expect(wall(p.start, UTC)).toBe('2026-04-01 00:00');
    expect(wall(p.end, UTC)).toBe('2026-07-01 00:00');
  });

  it('rolls back across the year for Q1', () => {
    const p = resolvePeriod('quarterly', UTC, 'monday', new Date('2026-02-10T12:00:00Z'));
    expect(p.label).toBe('2025-Q4');
    expect(wall(p.prevStart, UTC)).toBe('2025-07-01 00:00');
  });

  it('snaps to quarter months regardless of where in the quarter `now` falls', () => {
    for (const day of ['2026-07-01T12:00:00Z', '2026-08-20T12:00:00Z', '2026-09-30T12:00:00Z']) {
      const p = resolvePeriod('quarterly', UTC, 'monday', new Date(day));
      expect([day, p.label]).toEqual([day, '2026-Q2']);
    }
  });
});

describe('resolvePeriodByLabel', () => {
  it('round-trips a weekly label', () => {
    const resolved = resolvePeriod('weekly', UTC, 'monday', new Date('2026-09-23T15:00:00Z'));
    const byLabel = resolvePeriodByLabel(resolved.label, 'weekly', UTC, 'monday');
    expect(byLabel?.start.toISOString()).toBe(resolved.start.toISOString());
    expect(byLabel?.end.toISOString()).toBe(resolved.end.toISOString());
  });

  it('round-trips monthly and quarterly labels', () => {
    for (const cadence of ['monthly', 'quarterly'] as const) {
      const now = new Date('2026-08-15T12:00:00Z');
      const resolved = resolvePeriod(cadence, UTC, 'monday', now);
      const byLabel = resolvePeriodByLabel(resolved.label, cadence, UTC, 'monday');
      expect([cadence, byLabel?.start.toISOString()]).toEqual([cadence, resolved.start.toISOString()]);
    }
  });

  it('rejects a label that does not match the cadence', () => {
    // Asking for a month with a week label is a client bug, not an empty report.
    expect(resolvePeriodByLabel('2026-W38', 'monthly', UTC)).toBeNull();
    expect(resolvePeriodByLabel('2026-08', 'weekly', UTC)).toBeNull();
    expect(resolvePeriodByLabel('2026-Q3', 'weekly', UTC)).toBeNull();
  });

  it('rejects malformed and out-of-range labels', () => {
    for (const bad of ['', 'last-week', '2026-W00', '2026-W54', '2026-13', '2026-Q5', '26-W1']) {
      expect([bad, resolvePeriodByLabel(bad, 'weekly', UTC)]).toEqual([bad, null]);
    }
  });

  it('resolves a backfill label in the report timezone, not UTC', () => {
    const utc = resolvePeriodByLabel('2026-08', 'monthly', UTC);
    const chi = resolvePeriodByLabel('2026-08', 'monthly', CHICAGO);
    // Same civil month, different instants — Chicago's August starts 5h later.
    expect(chi!.start.getTime()).toBeGreaterThan(utc!.start.getTime());
    expect(wall(chi!.start, CHICAGO)).toBe('2026-08-01 00:00');
  });
});

/**
 * Refusals. A period the data cannot support must be REFUSED with the reason —
 * a report labelled `2026-Q1` that quietly covers only its last 30 days is worse
 * than no report, because the manager reading it cannot tell.
 */
describe('rejectUnreportablePeriod', () => {
  const period = resolvePeriod('weekly', UTC, 'monday', new Date('2026-09-23T15:00:00Z'));

  it('accepts a complete period inside retention', () => {
    expect(rejectUnreportablePeriod(period, { minFromMs: 0, now: new Date('2026-09-23T15:00:00Z') })).toBeNull();
  });

  it('refuses a period that has not finished', () => {
    // `now` before the period end ⇒ in progress.
    const r = rejectUnreportablePeriod(period, { minFromMs: 0, now: new Date('2026-09-18T00:00:00Z') });
    expect(r?.reason).toBe('in_progress');
    expect(r?.message).toContain('2026-W');
  });

  it('refuses a period whose events have been purged', () => {
    const r = rejectUnreportablePeriod(period, {
      minFromMs: new Date('2026-09-20T00:00:00Z').getTime(),
      now: new Date('2026-09-23T15:00:00Z'),
    });
    expect(r?.reason).toBe('before_retention');
    expect(r?.message).toContain('purged');
  });

  it('measures retention from the COMPARISON period, because change is part of the report', () => {
    // A floor between prevStart and start still breaks "vs last week" — it would
    // silently read zero rather than "unavailable".
    const floor = new Date(period.start.getTime() - 86_400_000).getTime();
    const withPrev = rejectUnreportablePeriod(period, { minFromMs: floor, now: new Date('2026-09-23T15:00:00Z') });
    expect(withPrev?.reason).toBe('before_retention');

    // Opting out of the comparison makes the same window reportable.
    const without = rejectUnreportablePeriod(period, {
      minFromMs: floor, now: new Date('2026-09-23T15:00:00Z'), includePrevious: false,
    });
    expect(without).toBeNull();
  });

  it('treats minFromMs 0 as unlimited retention', () => {
    const ancient = resolvePeriodByLabel('2019-01', 'monthly', UTC)!;
    expect(rejectUnreportablePeriod(ancient, { minFromMs: 0, now: new Date('2026-09-23T15:00:00Z') })).toBeNull();
  });
});
