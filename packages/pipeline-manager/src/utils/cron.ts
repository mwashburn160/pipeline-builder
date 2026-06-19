// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Convert a standard 5-field cron expression into an AWS EventBridge cron
 * expression, and guard against schedules that fire more often than every
 * 15 minutes.
 *
 * Standard cron:    `minute hour day-of-month month day-of-week`
 * EventBridge cron: `cron(minute hour day-of-month month day-of-week year)`
 *
 * The non-obvious differences EventBridge imposes:
 *  - a 6th field (year), which we always set to `*`;
 *  - day-of-month and day-of-week may NOT both be `*` — exactly one must be `?`;
 *  - day-of-week is 1–7 with 1 = Sunday, whereas standard cron is 0–6 (or 7)
 *    with 0/7 = Sunday — so numeric day-of-week values must be remapped.
 */

/** Minimum allowed spacing between fires, in minutes. */
export const MIN_SCHEDULE_INTERVAL_MIN = 15;

/** Expand a cron minute field (wildcard, step "/n", ranges "a-b", lists "a,b") to the sorted set of minutes it fires on. */
function expandMinuteField(field: string): number[] {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const slash = part.split('/');
    const rangePart = slash[0] ?? '';
    const stepPart = slash[1];
    const step = stepPart !== undefined ? parseInt(stepPart, 10) : 1;
    if (stepPart !== undefined && (!Number.isInteger(step) || step < 1)) {
      throw new Error(`Invalid step in minute field: "${part}"`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = 0; hi = 59;
    } else if (rangePart.includes('-')) {
      const ends = rangePart.split('-');
      lo = parseInt(ends[0] ?? '', 10);
      hi = parseInt(ends[1] ?? '', 10);
    } else {
      lo = hi = parseInt(rangePart, 10);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi > 59 || lo > hi) {
      throw new Error(`Invalid minute field: "${part}"`);
    }
    for (let m = lo; m <= hi; m += step) out.add(m);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Throw if `fiveField` would fire more often than every {@link MIN_SCHEDULE_INTERVAL_MIN}
 * minutes. Conservative: the smallest cyclic gap in the minute field is the worst-case
 * spacing (it's only ever larger once the hour/day fields restrict things further).
 */
export function assertScheduleInterval(fiveField: string): void {
  const parts = fiveField.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Schedule must be a 5-field cron ("minute hour day-of-month month day-of-week"), got: "${fiveField}"`);
  }
  const minutes = expandMinuteField(parts[0]!);
  if (minutes.length === 0) throw new Error(`Minute field matches nothing: "${parts[0]}"`);
  // Smallest cyclic gap across the hour boundary (e.g. {0,50} → gaps 50 and 10).
  let minGap = 60;
  if (minutes.length > 1) {
    for (let i = 0; i < minutes.length; i++) {
      const cur = minutes[i]!;
      const next = minutes[(i + 1) % minutes.length]!;
      const gap = (next - cur + 60) % 60 || 60;
      minGap = Math.min(minGap, gap);
    }
  }
  if (minGap < MIN_SCHEDULE_INTERVAL_MIN) {
    throw new Error(
      `Schedule "${fiveField}" fires every ${minGap} minute(s); the minimum is ${MIN_SCHEDULE_INTERVAL_MIN}. ` +
      `Use a sparser schedule (e.g. "0 0 * * *" for daily, "*/15 * * * *" for the densest allowed).`,
    );
  }
}

/** Remap a standard cron day-of-week token (0–7, 0/7=Sun) to EventBridge (1–7, 1=Sun). Passes through names and `*`/`?`. */
function remapDayOfWeek(field: string): string {
  if (field === '*' || field === '?') return field;
  // Token may contain lists/ranges/steps of numbers and/or 3-letter names.
  return field.replace(/\d+/g, (n) => {
    const v = parseInt(n, 10);
    if (v < 0 || v > 7) throw new Error(`Invalid day-of-week value: "${n}"`);
    return String((v % 7) + 1); // 0→1 (Sun), 6→7 (Sat), 7→1 (Sun)
  });
}

/**
 * Convert a validated 5-field cron expression to an AWS EventBridge `cron(...)`
 * expression. Also enforces the 15-minute guard.
 */
export function toEventBridgeCron(fiveField: string): string {
  assertScheduleInterval(fiveField); // also validates the 5-field shape
  const f = fiveField.trim().split(/\s+/);
  const [minute, hour, domRaw, month, dowRaw] = [f[0]!, f[1]!, f[2]!, f[3]!, f[4]!];

  let dom = domRaw;
  let dow = remapDayOfWeek(dowRaw);

  // EventBridge: exactly one of day-of-month / day-of-week must be `?`.
  if (dom === '*' && dow === '*') {
    dow = '?'; // unrestricted both → pin day-of-week to ?
  } else if (dom !== '*' && dow === '*') {
    dow = '?'; // specific day-of-month → day-of-week must be ?
  } else if (dom === '*' && dow !== '*') {
    dom = '?'; // specific day-of-week → day-of-month must be ?
  }
  // (both specific is left as-is; EventBridge rejects it, surfacing a clear error)

  return `cron(${minute} ${hour} ${dom} ${month} ${dow} *)`;
}
