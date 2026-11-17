// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { isValidCron, nextCronRun, parseCron } from '../src/utils/cron.js';

const at = (s: string): Date => new Date(s);
const next = (expr: string, from: string, tz?: string): string | undefined => nextCronRun(expr, at(from), tz)?.toISOString();

describe('parseCron', () => {
  it.each([
    '* * * * *', '0 0 * * *', '*/15 9-17 * * 1-5', '0 0 1,15 * *', '5/10 * * * *', '0 0 * * 7', '0 0 ? * MON-FRI',
    '0 12 * JAN,jul *', '@daily', '@Hourly', '@yearly', '@annually', '@monthly', '@weekly', '@midnight',
  ])('accepts %s', (expr) => {
    expect(parseCron(expr)).not.toBeNull();
  });

  it.each([
    '', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * 32 * *', '* * * 13 *', '* * * * 8',
    '5-1 * * * *', '*/0 * * * *', '1/2/3 * * * *', '-1 * * * *', '* * * FOO *', '@reboot', 'a b c d e', '1,,2 * * * *',
  ])('refuses %s', (expr) => {
    expect(parseCron(expr)).toBeNull();
  });

  it('folds 7 into Sunday and keeps * over the week to one Sunday', () => {
    expect([...parseCron('0 0 * * 7')!.dayOfWeek.values]).toEqual([0]);
    expect(parseCron('0 0 * * *')!.dayOfWeek.values.size).toBe(7);
    expect([...parseCron('0 0 * * SUN,sat')!.dayOfWeek.values].sort()).toEqual([0, 6]);
  });

  it('refuses, rather than throws on, an Object.prototype member name', () => {
    for (const expr of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(parseCron(expr)).toBeNull();
      expect(isValidCron(expr)).toBe(false);
    }
  });

  it('runs an open-ended day-of-week step to Saturday, not through 7 (Sunday)', () => {
    expect([...parseCron('0 0 * * 1/2')!.dayOfWeek.values].sort()).toEqual([1, 3, 5]);
    expect([...parseCron('0 0 * * 0/3')!.dayOfWeek.values].sort()).toEqual([0, 3, 6]);
    expect([...parseCron('0 0 * * 7/2')!.dayOfWeek.values]).toEqual([0]);
    // An explicit range through 7 still names Sunday.
    expect([...parseCron('0 0 * * 5-7')!.dayOfWeek.values].sort()).toEqual([0, 5, 6]);
  });

  it('marks only an unrestricted field as any', () => {
    const c = parseCron('0 0 ? * 1')!;
    expect(c.dayOfMonth.any).toBe(true);
    expect(c.dayOfWeek.any).toBe(false);
    expect(parseCron('*/2 * * * *')!.minute.any).toBe(false);
  });
});

describe('nextCronRun in UTC', () => {
  it('is strictly after from', () => {
    expect(next('0 0 * * *', '2026-11-16T00:00:00Z')).toBe('2026-11-17T00:00:00.000Z');
    expect(next('* * * * *', '2026-11-16T10:00:30Z')).toBe('2026-11-16T10:01:00.000Z');
  });

  it('honours every field', () => {
    expect(next('30 14 * * 1-5', '2026-11-14T00:00:00Z')).toBe('2026-11-16T14:30:00.000Z'); // Sat → Mon
    expect(next('0 9 1 */3 *', '2026-11-16T00:00:00Z')).toBe('2027-01-01T09:00:00.000Z');
    expect(next('0 0 29 2 *', '2026-03-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
    expect(next('@monthly', '2026-11-16T00:00:00Z')).toBe('2026-12-01T00:00:00.000Z');
  });

  it('fires on either restricted day field (day OR, as Kubernetes CronJob)', () => {
    // The 1st, or any Friday: Fri 2026-11-20 comes first.
    expect(next('0 0 1 * 5', '2026-11-16T00:00:00Z')).toBe('2026-11-20T00:00:00.000Z');
    expect(next('0 0 1 * 5', '2026-11-28T00:00:00Z')).toBe('2026-12-01T00:00:00.000Z');
  });

  it('treats a stepped star as restricting its day field, as Kubernetes does (not classic Vixie)', () => {
    // Odd days OR Mondays. Vixie would read `*/2` as unrestricted and fire on Mondays only (the 23rd).
    expect(next('0 0 */2 * 1', '2026-11-17T00:00:00Z')).toBe('2026-11-19T00:00:00.000Z'); // Thu the 19th: odd
    expect(next('0 0 */2 * 1', '2026-11-29T00:00:00Z')).toBe('2026-11-30T00:00:00.000Z'); // Mon the 30th: even, but Monday
  });

  it('is null for a schedule that never fires', () => {
    expect(nextCronRun('0 0 31 2 *', at('2026-01-01T00:00:00Z'))).toBeNull();
    expect(isValidCron('0 0 31 2 *')).toBe(false);
    expect(isValidCron('0 0 31 * *')).toBe(true);
  });
});

describe('nextCronRun in a zone', () => {
  const NY = 'America/New_York';

  it('reads the expression in the zone, across DST', () => {
    expect(next('0 9 * * *', '2026-07-01T00:00:00Z', NY)).toBe('2026-07-01T13:00:00.000Z');
    expect(next('0 9 * * *', '2026-12-01T00:00:00Z', NY)).toBe('2026-12-01T14:00:00.000Z');
  });

  it('a time in the spring-forward gap runs when the gap ends', () => {
    expect(next('30 2 * * *', '2026-03-08T05:00:00Z', NY)).toBe('2026-03-08T07:30:00.000Z');
    expect(next('30 2 * * *', '2026-03-08T08:00:00Z', NY)).toBe('2026-03-09T06:30:00.000Z');
  });

  it('a time repeated by the fall-back runs once', () => {
    const first = nextCronRun('30 1 * * *', at('2026-11-01T04:00:00Z'), NY)!;
    const second = nextCronRun('30 1 * * *', first, NY)!;
    expect(second.getTime() - first.getTime()).toBeGreaterThan(20 * 3_600_000);
  });

  it('throws on a zone the runtime does not know', () => {
    expect(() => nextCronRun('* * * * *', new Date(), 'Mars/Olympus')).toThrow(RangeError);
  });
});
