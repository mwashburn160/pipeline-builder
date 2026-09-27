// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Producing one period's report: the part the on-demand route and the scheduler share.
 *
 * They must share it. The route runs with a caller, a request-scoped tenant context and
 * the caller's own features; the scheduler runs with none of those and authorizes as the
 * definition's OWNER. Everything BETWEEN those two ends is identical — resolve the
 * period, refuse one the data cannot support, create or reuse the run row, compose,
 * freeze the snapshot, supersede the version it replaces — and a second copy of it is
 * two places for the retention refusal or the supersede step to be forgotten.
 *
 * WHAT THE SNAPSHOT MEANS: once `completeRun` lands, the numbers are frozen. A manager
 * who read a figure on Monday sees the same figure on Friday, and the report survives
 * the retention sweep that purges the events it came from. That is the whole reason the
 * table exists, so nothing here recomputes a run that already has a snapshot unless the
 * caller explicitly asked for a new VERSION.
 */

import { createLogger, emitCounter, errorMessage } from '@pipeline-builder/api-core';
import {
  composeSnapshot,
  rejectUnreportablePeriod,
  reportingService,
  resolvePeriod,
  resolvePeriodByLabel,
  stakeholderReportStore,
  type ReportDefinition,
  type ReportRun,
  type ResolvedPeriod,
  type SectionDataSource,
} from '@pipeline-builder/pipeline-data';
import { readPosture } from './report-posture.js';
import { resolveOrgRetentionWindow } from '../helpers/retention-cap.js';

const logger = createLogger('report-runner');

/** Why a run could not be produced, in words the lead reads. */
export type RunRefusal =
  | { kind: 'bad_period'; message: string }
  | { kind: 'unreportable'; message: string }
  | { kind: 'compose_failed'; message: string };

/** A produced run, or the reason there isn't one. */
export type RunResult =
  | { ok: true; run: ReportRun; period: ResolvedPeriod; reused: boolean }
  | { ok: false; refusal: RunRefusal };

export interface ComposeRunOptions {
  definition: ReportDefinition;
  /** A specific period label, or undefined for the last complete one. */
  periodLabel?: string;
  /** Produce version N+1 rather than reusing the existing run. */
  regenerate?: boolean;
  /** Features the org holds. A section needing an absent one renders locked. */
  features: readonly string[];
  /** `[self, ...descendants]` when the definition's scope is a rollup. */
  orgIds?: string[];
  /** The org id retention is resolved against (the account ROOT for a team). */
  retentionOrgId?: string;
  now?: Date;
}

/**
 * The data source a report composes from.
 *
 * `reportingService` supplies every section's numbers; the POSTURE section is layered on
 * here rather than living on the service because it is the one panel whose data comes
 * from other services over HTTP, and pipeline-data must not make outbound service calls
 * — it is the package those services import, not a peer of theirs.
 */
export function reportDataSource(orgId: string): SectionDataSource {
  return {
    ...reportingService,
    getCompliancePosture: (scope) => readPosture(orgId, scope.from, scope.to),
  } as SectionDataSource;
}

/**
 * Resolve the period a run should cover, or say why it cannot.
 *
 * Both refusals are RETURNED rather than thrown, because both are things the lead needs
 * to read: "2026-W99 is not a week" is a typo, and "that quarter is past your retention
 * horizon" is a plan decision. A thrown 500 would tell them neither.
 */
export async function resolveRunPeriod(opts: ComposeRunOptions): Promise<{ period: ResolvedPeriod } | { refusal: RunRefusal }> {
  const { definition, periodLabel } = opts;
  const weekStart = definition.weekStart as 'monday' | 'sunday';
  const period = periodLabel
    ? resolvePeriodByLabel(periodLabel, definition.cadence, definition.timezone, weekStart)
    : resolvePeriod(definition.cadence, definition.timezone, weekStart, opts.now);
  if (!period) {
    return {
      refusal: {
        kind: 'bad_period',
        message: `"${periodLabel}" is not a ${definition.cadence} period label. `
          + 'Use 2026-W38 for weekly, 2026-08 for monthly, 2026-Q3 for quarterly.',
      },
    };
  }
  // A period the data cannot support is REFUSED with the reason, never silently
  // truncated: a report labelled 2026-Q1 that quietly covers only its last 30 days is
  // worse than no report, because nobody can tell.
  const { minFromMs } = await resolveOrgRetentionWindow(
    definition.orgId,
    'event',
    opts.retentionOrgId ?? definition.orgId,
  );
  const rejection = rejectUnreportablePeriod(period, { minFromMs, includePrevious: true, ...(opts.now ? { now: opts.now } : {}) });
  if (rejection) return { refusal: { kind: 'unreportable', message: rejection.message } };
  return { period };
}

/**
 * Compose one period into a frozen snapshot.
 *
 * On a compose failure the run row STAYS, marked failed with the reason, so the lead
 * sees why a report is missing instead of a gap in the history — which is otherwise
 * discovered by a manager asking where this week's report went.
 */
export async function composeRun(opts: ComposeRunOptions): Promise<RunResult> {
  const { definition } = opts;
  const resolved = await resolveRunPeriod(opts);
  if ('refusal' in resolved) return { ok: false, refusal: resolved.refusal };
  const { period } = resolved;

  const version = opts.regenerate
    ? await stakeholderReportStore.nextVersion(definition.id, period.start)
    : 1;
  const { run, created } = await stakeholderReportStore.createRun({
    orgId: definition.orgId,
    definitionId: definition.id,
    periodStart: period.start,
    periodEnd: period.end,
    periodLabel: period.label,
    version,
  });
  if (!created && !opts.regenerate && run.snapshot) {
    // The period already has a snapshot and nobody asked for a new version. Hand back
    // what exists: the numbers in a frozen snapshot do not change, so recomputing them
    // could only produce a different answer — which is the thing the freeze prevents.
    return { ok: true, run, period, reused: true };
  }

  try {
    const snapshot = await composeSnapshot(definition.sections, {
      source: reportDataSource(definition.orgId),
      period,
      timezone: definition.timezone,
      weekStart: definition.weekStart as 'monday' | 'sunday',
      orgId: definition.orgId,
      ...(opts.orgIds ? { orgIds: opts.orgIds } : {}),
      features: opts.features,
      ...(opts.now ? { now: opts.now } : {}),
    });
    const completed = await stakeholderReportStore.completeRun(
      definition.orgId,
      run.id,
      snapshot as unknown as Record<string, unknown>,
    );
    if (version > 1) {
      const prior = (await stakeholderReportStore.listRuns(definition.orgId, definition.id))
        .find((r) => r.periodLabel === period.label && r.version === version - 1);
      if (prior) await stakeholderReportStore.supersede(definition.orgId, prior.id, completed.id);
    }
    emitCounter('report_run_composed_total', { orgId: definition.orgId, cadence: definition.cadence });
    return { ok: true, run: completed, period, reused: false };
  } catch (err) {
    const message = 'The report could not be computed for this period.';
    await stakeholderReportStore.failRun(definition.orgId, run.id, message);
    logger.warn('Report compose failed', {
      orgId: definition.orgId,
      definitionId: definition.id,
      period: period.label,
      error: errorMessage(err),
    });
    return { ok: false, refusal: { kind: 'compose_failed', message } };
  }
}
