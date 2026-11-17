// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Five-field cron: parse, validate, and find the next run in a timezone.
 *
 * One grammar for every schedule the platform reads, so a schedule the API
 * accepts is one the scheduler honours and one a Kubernetes CronJob would take:
 *
 * - `minute hour day-of-month month day-of-week`;
 * - each field `*`, `N`, `a-b`, `* /n`, `a-b/n`, `N/n` (N through the maximum; 6
 *   in day-of-week) or a
 *   comma list of those (written without the space; it is only there to keep
 *   this comment open);
 * - month names `JAN`–`DEC` and weekday names `SUN`–`SAT`, any case;
 * - day-of-week 0–7, with 7 meaning Sunday; `?` means `*` in either day field;
 * - the macros `@yearly` / `@annually`, `@monthly`, `@weekly`, `@daily` /
 *   `@midnight` and `@hourly`.
 *
 * Day matching follows Kubernetes CronJob (robfig/cron): when BOTH day fields
 * are restricted, a day matching EITHER fires; otherwise the restricted one
 * decides. Only a bare `*` or `?` counts as unrestricted — a stepped star such as
 * `* /2` restricts its field, so `0 0 * /2 * MON` fires on odd days AND on
 * Mondays. (Classic Vixie cron treats a stepped star as unrestricted here.)
 *
 * Times are read in the zone passed to {@link nextCronRun}, default UTC. Across a
 * DST switch, a time inside the spring-forward gap runs shifted by the gap (02:30
 * on a 02:00→03:00 night runs at 03:30), and a time the fall-back repeats runs
 * once, at its first occurrence.
 */

import { civilIn, instantOfCivil, type CivilDateTime } from './calendar.js';

/** One parsed field: the allowed values, and whether it was unrestricted (a bare `*` or `?`). */
export interface CronField {
  readonly values: ReadonlySet<number>;
  readonly any: boolean;
}

/** A parsed expression. Day-of-week values are 0 = Sunday … 6 = Saturday. */
export interface ParsedCron {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

/** Why an expression was refused, for a 400. */
export const CRON_GRAMMAR_HINT =
  'A cron expression has 5 fields (minute hour day-of-month month day-of-week), each "*", a number, a range (a-b), '
  + 'a step (*/n or a-b/n) or a comma list of those; months and weekdays may be names (JAN, MON). '
  + 'The macros @yearly, @monthly, @weekly, @daily and @hourly are accepted. It must describe a time that actually occurs.';

// A Map, not an object literal: a lookup keyed by caller input must not reach
// `Object.prototype` (`constructor`, `toString`), whose members are not strings.
const MACROS: ReadonlyMap<string, string> = new Map([
  ['@yearly', '0 0 1 1 *'],
  ['@annually', '0 0 1 1 *'],
  ['@monthly', '0 0 1 * *'],
  ['@weekly', '0 0 * * 0'],
  ['@daily', '0 0 * * *'],
  ['@midnight', '0 0 * * *'],
  ['@hourly', '0 * * * *'],
]);

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface FieldSpec {
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
  /** Names map to `index + nameBase`. */
  readonly nameBase?: number;
  readonly dayOfWeek?: boolean;
  /** `?` is accepted as `*`. */
  readonly question?: boolean;
}

const FIELDS: readonly FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31, question: true },
  { min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { min: 0, max: 7, names: DAY_NAMES, nameBase: 0, dayOfWeek: true, question: true },
];

/** A number or a name; null when it is neither. */
function atom(text: string, spec: FieldSpec): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  const i = spec.names?.indexOf(text.toUpperCase()) ?? -1;
  return i >= 0 ? i + (spec.nameBase ?? 0) : null;
}

function parseField(text: string, spec: FieldSpec): CronField | null {
  if (text === '') return null;
  const star = text === '*' || (spec.question === true && text === '?');
  const values = new Set<number>();
  for (const part of (star ? '*' : text).split(',')) {
    const [range, stepText, ...extra] = part.split('/');
    if (extra.length > 0 || !range) return null;
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) return null;
      step = Number(stepText);
    }
    // An open-ended range (`*`, `N/n`) stops at 6 in day-of-week: 7 is only an
    // alias for Sunday, so running through it would make `1/2` (Mon, Wed, Fri)
    // fire on Sundays too.
    const openMax = spec.dayOfWeek ? 6 : spec.max;
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = spec.min;
      hi = openMax;
    } else if (range.includes('-')) {
      const [a, b, ...more] = range.split('-');
      const av = atom(a ?? '', spec);
      const bv = atom(b ?? '', spec);
      if (more.length > 0 || av === null || bv === null || av > bv) return null;
      lo = av;
      hi = bv;
    } else {
      const v = atom(range, spec);
      if (v === null) return null;
      lo = v;
      // `7/n` is Sunday alone, not an empty range.
      hi = stepText !== undefined ? Math.max(v, openMax) : v;
    }
    if (lo < spec.min || hi > spec.max) return null;
    for (let v = lo; v <= hi; v += step) values.add(spec.dayOfWeek && v === 7 ? 0 : v);
  }
  return { values, any: star };
}

/** Parse an expression, or null when any part of it is malformed. */
export function parseCron(expression: string): ParsedCron | null {
  const trimmed = expression.trim();
  const parts = (MACROS.get(trimmed.toLowerCase()) ?? trimmed).split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = parts.map((p, i) => parseField(p, FIELDS[i]!));
  if (fields.some((f) => f === null)) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as CronField[];
  return { minute: minute!, hour: hour!, dayOfMonth: dayOfMonth!, month: month!, dayOfWeek: dayOfWeek! };
}

function dayMatches(c: ParsedCron, day: Date): boolean {
  const domOk = c.dayOfMonth.values.has(day.getUTCDate());
  const dowOk = c.dayOfWeek.values.has(day.getUTCDay());
  if (!c.dayOfMonth.any && !c.dayOfWeek.any) return domOk || dowOk;
  return domOk && dowOk;
}

/** How far ahead to look before calling an expression unsatisfiable (`0 0 31 2 *`). */
const HORIZON_MS = 5 * 366 * 86_400_000;

/**
 * The next CIVIL minute matching `c` strictly after civil time `after`, both held
 * as naive-UTC milliseconds (civil parts read as if they were UTC). Skips whole
 * months, days and hours that cannot match, so a sparse schedule resolves in a
 * few hundred steps.
 */
function nextCivilMatch(c: ParsedCron, after: number): number | null {
  const t = new Date(after);
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = after + HORIZON_MS;
  while (t.getTime() <= limit) {
    if (!c.month.values.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!dayMatches(c, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!c.hour.values.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
    } else if (!c.minute.values.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
    } else {
      return t.getTime();
    }
  }
  return null;
}

const civilOfNaive = (ms: number): CivilDateTime => {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: 0,
  };
};

/**
 * The first instant strictly after `from` at which the schedule fires, reading
 * the expression in `timeZone` (default UTC). Null when the expression is
 * malformed or never fires within five years.
 *
 * @throws RangeError when `timeZone` is not one the runtime knows.
 */
export function nextCronRun(expression: string | ParsedCron, from: Date, timeZone = 'UTC'): Date | null {
  const c = typeof expression === 'string' ? parseCron(expression) : expression;
  if (!c) return null;
  const f = civilIn(from, timeZone);
  let cursor = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  const limit = cursor + HORIZON_MS;
  while (cursor <= limit) {
    const match = nextCivilMatch(c, cursor);
    if (match === null) return null;
    const instant = instantOfCivil(civilOfNaive(match), timeZone);
    // A repeated (fall-back) or gap-shifted civil time can map to an instant at
    // or before `from`; keep looking past it.
    if (instant.getTime() > from.getTime()) return instant;
    cursor = match;
  }
  return null;
}

/** Whether an expression parses AND fires at least once. */
export function isValidCron(expression: string): boolean {
  return nextCronRun(expression, new Date()) !== null;
}
