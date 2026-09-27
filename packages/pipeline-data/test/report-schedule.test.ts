// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The period arithmetic a SCHEDULE depends on.
 *
 * `report-period.test.ts` covers resolving the period a report COVERS. This covers the
 * two questions the scheduler asks instead — when does the next one become reportable,
 * and which ones were missed — and it is mostly about the cases where the obvious
 * implementation is wrong:
 *
 *  - "last run + 7 days" drifts an hour at every DST transition and eventually fires on
 *    the wrong weekday, so the boundary must be a CALENDAR fact in the report's zone;
 *  - a boundary computed from an instant already ON a boundary must give the NEXT one,
 *    or a run completing at that instant re-claims the period it just did;
 *  - a definition that has never run is owed ONE report, not a backfill nobody asked for;
 *  - a definition dormant for a year is owed a CAPPED number, oldest dropped.
 */

import { describe, it, expect } from '@jest/globals';
import { completePeriodsSince, nextPeriodBoundary, resolvePeriod } from '../src/api/reporting/stakeholder/period.js';

/** Monday 2026-09-21 12:00 in Chicago (CDT, UTC-5). */
const MID_WEEK = new Date('2026-09-21T17:00:00.000Z');
const CHI = 'America/Chicago';

describe('nextPeriodBoundary', () => {
  it('is the end of the period containing `from`', () => {
    // The week containing Monday 2026-09-21 ends at Monday 2026-09-28 00:00 Chicago.
    expect(nextPeriodBoundary('weekly', CHI, 'monday', MID_WEEK).toISOString())
      .toBe('2026-09-28T05:00:00.000Z');
  });

  it('is strictly after an instant that sits exactly ON a boundary', () => {
    const boundary = nextPeriodBoundary('weekly', CHI, 'monday', MID_WEEK);
    // Without "strictly after", a run finishing at the boundary would compute the same
    // boundary again, claim the period it had just reported, and deliver it twice.
    expect(nextPeriodBoundary('weekly', CHI, 'monday', boundary).getTime())
      .toBeGreaterThan(boundary.getTime());
  });

  it('crosses a DST transition without shifting the wall-clock boundary', () => {
    // US DST ends Sunday 2026-11-01. The week containing 2026-10-26 therefore is NOT
    // 168 hours long, and a scheduler that added 7 * 24 * 3600_000 would put the
    // boundary an hour out — every week, for half the year.
    const before = new Date('2026-10-28T17:00:00.000Z');
    const boundary = nextPeriodBoundary('weekly', CHI, 'monday', before);
    // Monday 2026-11-02 00:00 Chicago is UTC-6 by then, so 06:00Z.
    expect(boundary.toISOString()).toBe('2026-11-02T06:00:00.000Z');
    expect(boundary.getTime() - before.getTime()).not.toBe(5 * 86_400_000);
  });

  it('is the 1st for monthly and the quarter start for quarterly', () => {
    expect(nextPeriodBoundary('monthly', 'UTC', 'monday', new Date('2026-09-21T00:00:00Z')).toISOString())
      .toBe('2026-10-01T00:00:00.000Z');
    expect(nextPeriodBoundary('quarterly', 'UTC', 'monday', new Date('2026-09-21T00:00:00Z')).toISOString())
      .toBe('2026-10-01T00:00:00.000Z');
  });

  it('honours a Sunday week start', () => {
    expect(nextPeriodBoundary('weekly', 'UTC', 'sunday', new Date('2026-09-21T00:00:00Z')).toISOString())
      .toBe('2026-09-27T00:00:00.000Z');
  });
});

describe('completePeriodsSince', () => {
  it('returns just the latest complete period when there is no previous run', () => {
    const periods = completePeriodsSince('weekly', CHI, 'monday', null, MID_WEEK);
    expect(periods).toHaveLength(1);
    // A definition created today does not owe its owner a backfill they never asked for.
    expect(periods[0]?.label).toBe(resolvePeriod('weekly', CHI, 'monday', MID_WEEK).label);
  });

  it('returns nothing when the last run already covered the latest period', () => {
    const latest = resolvePeriod('weekly', CHI, 'monday', MID_WEEK);
    // `since` is the end of the period already reported.
    expect(completePeriodsSince('weekly', CHI, 'monday', latest.end, MID_WEEK)).toEqual([]);
  });

  it('lists every missed period OLDEST FIRST', () => {
    // Three weeks behind.
    const since = new Date('2026-08-31T05:00:00.000Z');
    const periods = completePeriodsSince('weekly', CHI, 'monday', since, MID_WEEK, 10);
    expect(periods.length).toBeGreaterThan(1);
    const labels = periods.map((p) => p.label);
    // Oldest first, because three weekly reports arriving at once only make sense read
    // downwards.
    expect([...labels].sort()).toEqual(labels);
    expect(labels[labels.length - 1]).toBe(resolvePeriod('weekly', CHI, 'monday', MID_WEEK).label);
  });

  it('caps the catch-up, dropping the OLDEST', () => {
    const since = new Date('2025-01-01T00:00:00.000Z');
    const capped = completePeriodsSince('weekly', CHI, 'monday', since, MID_WEEK, 3);
    expect(capped).toHaveLength(3);
    // The cap keeps the NEWEST three: nobody wants last April's weekly status, and the
    // oldest would be past the retention horizon anyway.
    expect(capped[2]?.label).toBe(resolvePeriod('weekly', CHI, 'monday', MID_WEEK).label);
  });

  it('returns nothing when the cap is zero', () => {
    expect(completePeriodsSince('weekly', CHI, 'monday', null, MID_WEEK, 0)).toEqual([]);
  });

  it('gives each period the PREVIOUS one as its comparison window', () => {
    const periods = completePeriodsSince('weekly', CHI, 'monday', new Date('2026-08-31T05:00:00.000Z'), MID_WEEK, 3);
    for (const p of periods) {
      // A catch-up report must compare against the week before ITSELF, not against the
      // week before now — otherwise a backfilled report's "vs last week" is wrong.
      expect(p.prevEnd.getTime()).toBe(p.start.getTime());
      expect(p.prevStart.getTime()).toBeLessThan(p.start.getTime());
    }
  });
});
