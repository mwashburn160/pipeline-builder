// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * When a support case's first response is DUE.
 *
 * WHY A DEADLINE FUNCTION AND NOT A CLOCK. The targets are stated in business
 * DAYS ("2 business days", "next business day"), and that choice is what makes
 * this small. An hours-based target ("48 business hours") would need an
 * accumulating within-day clock: pause at the end of the working day, resume at
 * the start of the next, count elapsed working seconds, and decide what a case
 * opened five minutes before closing is owed. A business-DAY target needs only
 * one answer — given an open timestamp, what instant is the end of the Nth
 * following working day — which is a pure function of a calendar.
 *
 * WHY THE RESULT IS FROZEN ONTO THE CASE. The caller stores this on
 * `support_case.response_due_at` at open, exactly as it freezes `level`. Three
 * things follow, and together they are the reason to do it this way:
 *
 *   - a holiday-list or working-week change after a case opens cannot move a
 *     promise already made to a customer;
 *   - the staff queue orders by a real deadline with no calendar arithmetic per
 *     row;
 *   - the standard/priority breach alert becomes CONTRACTUAL rather than the
 *     operational "the queue is not being worked" guard it has to be today,
 *     because a wall-clock quantile cannot express a business-day target at all
 *     (a priority case raised at 17:01 on a Friday is not late until Monday
 *     evening, about 79 wall-clock hours later).
 *
 * ONE PLATFORM CALENDAR, not the tenant's. With per-tenant timezones the same
 * case raised at the same instant has a different deadline per customer, and the
 * staff queue cannot be ordered by "most at risk" without computing per-tenant
 * business time for every row. One clock, one ordering, one number to defend. A
 * customer who cannot live with a business calendar at all is the PREMIUM
 * customer, which is a cleaner upsell than silently running two dozen clocks.
 */

import { addDays, civilIn, instantOfCivil, isoDateOf, isUsableTimeZone, weekdayOf, type CivilDate } from '../utils/calendar.js';
import { envInt, envStr } from '../utils/env.js';

/** How a level's target is measured. */
export type SupportTargetKind =
  /** N working days, ending at the close of the Nth. */
  | { kind: 'business-days'; days: number }
  /** N hours of wall clock, with no calendar applied at all. */
  | { kind: 'elapsed-hours'; hours: number };

/**
 * The measure behind each level's published target.
 *
 * Premium is `elapsed-hours` on purpose, and that is the whole of its 24×7
 * claim: its clock does not stop for nights, weekends or holidays, so no
 * calendar is consulted. It is also why premium is the one level whose target
 * the wall-clock histogram can check directly.
 */
export const SUPPORT_TARGET_MEASURES: Readonly<Record<string, SupportTargetKind>> = {
  support_standard: { kind: 'business-days', days: 2 },
  support_priority: { kind: 'business-days', days: 1 },
  support_premium: { kind: 'elapsed-hours', hours: 8 },
};

/** The resolved business calendar. */
export interface BusinessCalendar {
  /** IANA zone. Never a fixed abbreviation — see {@link businessCalendar}. */
  timeZone: string;
  /** Working weekdays, 0 = Sunday … 6 = Saturday. */
  days: readonly number[];
  /** The hour (0–23) at which a working day CLOSES, in `timeZone`. */
  endHour: number;
  /** Non-working dates, `YYYY-MM-DD` in `timeZone`. */
  holidays: ReadonlySet<string>;
}

const isWorkingDay = (day: CivilDate, cal: BusinessCalendar): boolean =>
  cal.days.includes(weekdayOf(day)) && !cal.holidays.has(isoDateOf(day));

/**
 * The instant a first response is due, or null for a level with no target.
 *
 * For a business-day target: the close of the Nth working day AFTER the one the
 * case was opened on. A case opened on a Friday with a next-business-day target
 * is due at Monday's close, not Saturday's — Saturday is not a working day, so
 * it is not counted. A case opened ON a non-working day starts counting from the
 * next working day, which is the reading that favours the customer and is the
 * only one that can be explained in a sentence.
 *
 * The day of opening is never itself the deadline, however early the case
 * arrives. "Next business day" has to mean tomorrow, not "later today" — a case
 * opened at 09:01 and one opened at 16:59 are owed the same thing, and anything
 * else turns the target into an hours clock by the back door.
 */
export function responseDueAt(
  openedAt: Date,
  level: string,
  cal: BusinessCalendar = businessCalendar(),
): Date | null {
  const measure = SUPPORT_TARGET_MEASURES[level];
  if (!measure) return null;
  if (measure.kind === 'elapsed-hours') {
    return new Date(openedAt.getTime() + measure.hours * 3600_000);
  }
  // No working days configured at all would otherwise spin forever. Treated as
  // "no deadline" rather than a throw: a misconfigured calendar must not make
  // opening a case fail.
  if (cal.days.length === 0) return null;

  let day: CivilDate = civilIn(openedAt, cal.timeZone);
  let counted = 0;
  // Bounded: 366 steps covers a year, which is far past any holiday list that
  // is not itself a configuration error.
  for (let step = 0; step < 366 && counted < measure.days; step += 1) {
    day = addDays(day, 1);
    if (isWorkingDay(day, cal)) counted += 1;
  }
  if (counted < measure.days) return null;
  return instantOfCivil({ ...day, hour: cal.endHour, minute: 0, second: 0 }, cal.timeZone);
}

/** `1,2,3,4,5` → `[1,2,3,4,5]`, ignoring anything that is not a weekday index. */
function parseDays(raw: string): number[] {
  const out = raw.split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isInteger(v) && v >= 0 && v <= 6);
  return [...new Set(out)].sort((a, b) => a - b);
}

/** `2026-12-25,2027-01-01` → a set, ignoring anything not `YYYY-MM-DD`. */
function parseHolidays(raw: string): Set<string> {
  return new Set(raw.split(',').map((v) => v.trim()).filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)));
}

/**
 * The configured calendar.
 *
 * `SUPPORT_BUSINESS_HOURS_TZ` takes an **IANA zone**, default
 * `America/New_York`, and NOT a fixed abbreviation like `EST`. `EST` is
 * permanently UTC−5, so an `EST` setting would put the desk an hour out for the
 * eight months of the year that are EDT — the same reason
 * `ASK_SCHEDULE_TIMEZONE` takes an IANA zone for its cron windows. An
 * unrecognised zone falls back to UTC rather than throwing, because a bad
 * timezone must not stop cases being opened; it is validated here so the
 * fallback is deliberate rather than an exception thrown from `Intl` deep inside
 * a request.
 *
 * Every stored timestamp stays UTC. The zone is applied only to derive a
 * deadline.
 *
 * Holidays are an explicit operator-maintained list rather than a library: a
 * library pulls both a dependency and a holiday POLICY that cannot be explained
 * to a customer disputing a deadline.
 */
export function businessCalendar(): BusinessCalendar {
  const configured = envStr('SUPPORT_BUSINESS_HOURS_TZ', 'America/New_York');
  return {
    timeZone: isUsableTimeZone(configured) ? configured : 'UTC',
    days: parseDays(envStr('SUPPORT_BUSINESS_HOURS_DAYS', '1,2,3,4,5')),
    endHour: envInt('SUPPORT_BUSINESS_HOURS_END_HOUR', 17, { min: 0, max: 23 }),
    holidays: parseHolidays(envStr('SUPPORT_BUSINESS_HOURS_HOLIDAYS', '')),
  };
}
