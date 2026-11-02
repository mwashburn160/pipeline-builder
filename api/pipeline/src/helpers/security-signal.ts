// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The scorecard's security signal per pipeline, read in one pass for a whole
 * roll-up: the org's LIVE plugin exposures (pipeline-data `openExposures`, the
 * one predicate every exposure reader shares) and the latest artifact security
 * reports, partitioned by pipeline.
 */

import { openExposures } from '@pipeline-builder/pipeline-data';
import { NO_SECURITY_SIGNAL, type ScorecardSecurityInput } from './scorecard.js';
import { securityReportStore, summarizeReports, type StoredSecurityReport } from '../services/security-report-store.js';

/** KEV-listed findings among an exposure's stored top findings. */
function kevIn(findings: ReadonlyArray<Record<string, unknown>>): number {
  return findings.filter((f) => f.kev === true).length;
}

/**
 * Security input for each of `pipelineIds`. Each source is fail-soft on its own
 * (a reporting outage scores on what is left, never fails the scorecard):
 * `warn` is told which one was skipped.
 */
export async function securitySignals(
  orgId: string,
  pipelineIds: readonly string[],
  warn: (msg: string, meta?: Record<string, unknown>) => void,
): Promise<Map<string, ScorecardSecurityInput>> {
  const out = new Map<string, ScorecardSecurityInput>(pipelineIds.map((id) => [id, { exposures: { ...NO_SECURITY_SIGNAL.exposures }, artifact: null }]));
  const wanted = new Set(pipelineIds);

  try {
    for (const e of await openExposures(orgId)) {
      const signal = wanted.has(e.pipelineId) ? out.get(e.pipelineId) : undefined;
      if (!signal) continue;
      signal.exposures.count++;
      signal.exposures.critical += e.criticalCount;
      signal.exposures.high += e.highCount;
      signal.exposures.kev += kevIn(e.topFindings);
    }
  } catch (err) {
    warn('Scorecard plugin exposures unavailable; security scored without them', { error: (err as Error).message });
  }

  try {
    const byPipeline = new Map<string, StoredSecurityReport[]>();
    for (const r of await securityReportStore().latest(orgId, pipelineIds)) {
      byPipeline.set(r.pipelineId, [...(byPipeline.get(r.pipelineId) ?? []), r]);
    }
    for (const [id, reports] of byPipeline) {
      const { counts, reports: n, latestAt } = summarizeReports(reports);
      const signal = out.get(id);
      if (signal) signal.artifact = { reports: n, critical: counts.critical, high: counts.high, kev: counts.kev, latestAt: latestAt?.toISOString() ?? null };
    }
  } catch (err) {
    warn('Scorecard artifact security reports unavailable; security scored without them', { error: (err as Error).message });
  }
  return out;
}
