// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * When a definition should next run.
 *
 * Its own module, and not part of the scheduler, because the AUTHORING ROUTES need it too:
 * creating a definition, changing its cadence or timezone, and resuming a paused one all
 * have to re-derive the schedule, and a definition with no `next_run_at` never becomes due
 * at all. Reaching into the scheduler for that would make a route depend on delivery,
 * identity and the run executor to compute a date.
 */

import { createHash } from 'node:crypto';
import { envInt } from '@pipeline-builder/api-core';
import { nextPeriodBoundary, type ReportDefinition } from '@pipeline-builder/pipeline-data';

/**
 * Hours after a period ends before it is reported.
 *
 * The ingest redrives its dead-letter queue, so a report composed at 00:00 Monday can
 * disagree with the same report composed at 06:00 — and a manager who reads a number on
 * Monday must not find a different one on Friday. Matches
 * `REPORTING_ROLLUP_SETTLE_HOURS`: a report that ran ahead of the rollup would read a
 * half-built day.
 */
export function reportSettleHours(): number {
  return envInt('REPORT_SETTLE_HOURS', 6, { min: 0 });
}

/**
 * A stable offset in `[0, REPORT_JITTER_MS)` derived from the definition id.
 *
 * A DIGEST rather than `Math.random()`, because the whole point is that the offset is the
 * SAME every period for the same definition — and rather than a hand-rolled integer hash,
 * because the ids are UUIDs and a weak mixer over near-identical strings would cluster
 * every definition created in the same second into the same minute of the window.
 */
function jitterFor(id: string): number {
  const span = envInt('REPORT_JITTER_MS', 1_800_000, { min: 0 });
  if (span === 0) return 0;
  return createHash('sha256').update(id).digest().readUInt32BE(0) % span;
}

/**
 * When this definition should next be attempted.
 *
 * The period boundary, plus the settle delay, plus a per-definition jitter. The boundary is
 * a CALENDAR fact in the report's own timezone rather than "last run + 7 days": the latter
 * drifts an hour at every DST transition and eventually fires on the wrong weekday.
 *
 * The jitter is derived from the definition ID, not random, because every weekly definition
 * in the fleet comes due at the same calendar instant and they must not all compose at
 * once — while a lead who notices their report lands around 07:20 should not find it at
 * 06:05 next week. A stable offset also means a retry does not walk the run around the
 * window.
 */
export function nextRunFor(definition: ReportDefinition, from: Date): Date {
  const boundary = nextPeriodBoundary(
    definition.cadence,
    definition.timezone,
    definition.weekStart as 'monday' | 'sunday',
    from,
  );
  return new Date(boundary.getTime() + reportSettleHours() * 3_600_000 + jitterFor(definition.id));
}
