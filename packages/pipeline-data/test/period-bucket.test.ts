// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The report time-bucket expression.
 *
 * Two defects it exists to prevent, both of which made a manager's report cover
 * the wrong days:
 *
 *  - Bucketing ran in the DATABASE SESSION's timezone, UTC in every deploy. A
 *    Chicago team's week therefore began 18:00 Sunday local, so Monday's report
 *    cut off Sunday evening's work and filed it under the previous week.
 *  - Postgres `DATE_TRUNC('week', …)` is ISO-8601 and always starts MONDAY, with
 *    no setting to change it. A Sunday-week org needs the boundary moved either
 *    side of the truncation; nothing in the database does that for you.
 *
 * These assert the generated SQL rather than running Postgres, because what is
 * being pinned is the shape of the expression — that the conversion happens
 * BEFORE the truncation, and that `tz` rides as a bound parameter rather than
 * being interpolated into the statement.
 */

import { describe, it, expect } from '@jest/globals';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { bucketKey, periodBucket } from '../src/api/reporting/sql-helpers.js';

const dialect = new PgDialect();

/** Render a fragment the way the driver would: `$n` placeholders + bound params. */
function rendered(fragment: SQL): { text: string; params: unknown[] } {
  const q = dialect.sqlToQuery(fragment);
  return { text: q.sql, params: q.params };
}

describe('periodBucket', () => {
  it('converts to the report timezone BEFORE truncating', () => {
    // The order is the whole fix: truncating first and converting after would
    // still cut the period on UTC boundaries.
    const { text } = rendered(periodBucket('week', sql`e.started_at`, 'America/Chicago'));
    expect(text).toContain('AT TIME ZONE');
    expect(text.indexOf('AT TIME ZONE')).toBeGreaterThan(text.indexOf('DATE_TRUNC'));
    expect(text).toMatch(/DATE_TRUNC\(\$\d+, \(e\.started_at AT TIME ZONE \$\d+\)\)/);
  });

  it('binds the timezone as a parameter, never inlines it', () => {
    const { text, params } = rendered(periodBucket('month', sql`e.started_at`, 'Europe/Berlin'));
    expect(params).toContain('Europe/Berlin');
    expect(text).not.toContain('Europe/Berlin');
  });

  it('binds the interval as a parameter too', () => {
    const { params } = rendered(periodBucket('quarter', sql`completed_at`, 'UTC'));
    expect(params).toContain('quarter');
  });

  it('supports quarter, for quarterly reports', () => {
    expect(() => periodBucket('quarter', sql`completed_at`, 'UTC')).not.toThrow();
  });

  it('shifts the boundary a day either side of the truncation for a Sunday week', () => {
    // Postgres cannot be told to start a week on Sunday, so the only way is
    // +1 day, truncate, -1 day.
    const { text } = rendered(periodBucket('week', sql`e.started_at`, 'America/Chicago', 'sunday'));
    expect(text).toContain("+ INTERVAL '1 day'");
    expect(text).toContain("- INTERVAL '1 day'");
    expect(text).toContain("DATE_TRUNC('week'");
  });

  it('does NOT shift for a Monday week — that is what DATE_TRUNC already does', () => {
    const { text } = rendered(periodBucket('week', sql`e.started_at`, 'UTC', 'monday'));
    expect(text).not.toContain("INTERVAL '1 day'");
  });

  it('never shifts a non-week interval, whatever the week start', () => {
    // A Sunday week start says nothing about where a month or quarter begins.
    for (const interval of ['day', 'month', 'quarter']) {
      const { text } = rendered(periodBucket(interval, sql`e.started_at`, 'UTC', 'sunday'));
      expect([interval, text.includes("INTERVAL '1 day'")]).toEqual([interval, false]);
    }
  });

  it('defaults to a Monday week when no start is given', () => {
    const withDefault = rendered(periodBucket('week', sql`e.started_at`, 'UTC')).text;
    const explicit = rendered(periodBucket('week', sql`e.started_at`, 'UTC', 'monday')).text;
    expect(withDefault).toBe(explicit);
  });

  it('rejects an interval outside the allow-list', () => {
    // The route is the security boundary, but this fails fast with a clear error
    // if anything ever reaches the service directly.
    expect(() => periodBucket("week'); DROP TABLE x--", sql`e.started_at`, 'UTC')).toThrow(/Invalid report interval/);
    expect(() => periodBucket('fortnight', sql`e.started_at`, 'UTC')).toThrow(/Invalid report interval/);
  });
});

/**
 * Report cache keys carried the interval and date range but NOT the bucketing
 * settings, so once bucketing became timezone-aware, a Chicago request and a UTC
 * request for the same window would have shared one entry — and whichever ran
 * second would read the other's weeks.
 */
describe('bucketKey', () => {
  it('distinguishes timezones', () => {
    expect(bucketKey('America/Chicago')).not.toBe(bucketKey('UTC'));
  });

  it('distinguishes week starts within one timezone', () => {
    expect(bucketKey('UTC', 'sunday')).not.toBe(bucketKey('UTC', 'monday'));
  });

  it('is stable for the same settings', () => {
    expect(bucketKey('Asia/Tokyo', 'sunday')).toBe(bucketKey('Asia/Tokyo', 'sunday'));
  });

  it('defaults to the pre-timezone behaviour, so an omitted value cannot move a boundary', () => {
    expect(bucketKey('UTC')).toBe(bucketKey('UTC', 'monday'));
  });
});
