// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The weekly registry BLOB garbage-collection window, and the push freeze around
 * it — shared by the service that ENFORCES the freeze (image-registry withholds
 * `push` from every registry token it issues inside it) and the ones that must
 * plan around it (the plugin build workers, whose image push would otherwise be
 * refused mid-build and record a healthy plugin as failed).
 *
 * Every deploy tree schedules `registry garbage-collect` as the
 * `registry-blob-gc` job at {@link BLOB_GC_WINDOW}; the CronJob schedules and
 * the compose loop are pinned to these numbers by
 * test/deploy-contracts/test/registry-blob-gc-contract.test.ts. Why the freeze
 * exists is told in api/image-registry/src/services/blob-gc-window.ts.
 */
export const BLOB_GC_WINDOW = {
  /** Day of week, UTC (0 = Sunday). */
  dayOfWeekUtc: 0,
  /** GC start, UTC: 03:10. */
  startHourUtc: 3,
  startMinuteUtc: 10,
  /** The job's hard deadline (`activeDeadlineSeconds` / `timeout`), minutes. */
  maxRunMinutes: 25,
  /** Freeze kept after the deadline, minutes — slack for a slow pod kill. */
  tailMinutes: 5,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Margin past the token TTL before GC starts, so a request in flight at expiry finishes. */
const FREEZE_LEAD_MARGIN_MS = 60_000;

/**
 * The freeze intervals `[start, end)` of the windows around `nowMs` (this
 * week's, last week's and next week's — the lead can cross a day boundary).
 */
function freezeIntervals(nowMs: number, tokenTtlSeconds: number): Array<[number, number]> {
  const now = new Date(nowMs);
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysSince = (now.getUTCDay() - BLOB_GC_WINDOW.dayOfWeekUtc + 7) % 7;
  const thisWeek = midnight - daysSince * DAY_MS
    + (BLOB_GC_WINDOW.startHourUtc * 60 + BLOB_GC_WINDOW.startMinuteUtc) * 60_000;
  const lead = tokenTtlSeconds * 1000 + FREEZE_LEAD_MARGIN_MS;
  const tail = (BLOB_GC_WINDOW.maxRunMinutes + BLOB_GC_WINDOW.tailMinutes) * 60_000;
  return [thisWeek - WEEK_MS, thisWeek, thisWeek + WEEK_MS].map((gcStart) => [gcStart - lead, gcStart + tail]);
}

/** True while image-registry must not grant `push` at `nowMs`. */
export function pushFreezeActiveAt(nowMs: number, tokenTtlSeconds: number): boolean {
  return freezeIntervals(nowMs, tokenTtlSeconds).some(([start, end]) => nowMs >= start && nowMs < end);
}

/**
 * When the freeze ends, if work started at `nowMs` that pushes up to
 * `workLeadMs` later could run into it; otherwise `null`. A build worker passes
 * how long a build may run before its push, so a build that would reach its
 * push inside the freeze waits for the freeze to end instead of failing there.
 */
export function pushFreezeEndIfOverlapping(nowMs: number, tokenTtlSeconds: number, workLeadMs: number): number | null {
  for (const [start, end] of freezeIntervals(nowMs, tokenTtlSeconds)) {
    if (nowMs >= start - Math.max(0, workLeadMs) && nowMs < end) return end;
  }
  return null;
}
