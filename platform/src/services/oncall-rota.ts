// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Publish whether anyone is on call, as a gauge whose job is to report ABSENCE.
 *
 * This is the check the rest of on-call paging cannot perform on itself. Every
 * other signal in the feature reports that something happened — an alert fired,
 * a case approached its deadline, a page was accepted. A rota with nobody
 * assigned next Tuesday produces no signal at all, right up until 02:00
 * Tuesday, and then the absence of a page is indistinguishable from a quiet
 * night. So the question has to be asked on a schedule and answered on a
 * Monday.
 *
 * THE GAUGE IS NOT WRITTEN WHEN THE ANSWER IS UNKNOWN, which is the only
 * subtlety here and the one that decides whether the alert built on it is
 * honest. A failed API call, a revoked token or an expired plan all produce "I
 * do not know" — and writing 0 for that would publish "fully covered", exactly
 * the reassurance this check exists to withhold. An absent series makes
 * `OnCallScheduleGap` not fire, which is correct: it is a statement about the
 * rota, and a statement about the rota cannot be made from a failed request.
 * `oncall_rota_reads_total{outcome}` is where the unknown becomes visible.
 */

import { createLogger, fetchRotaCoverage, onCallInboundConfig } from '@pipeline-builder/api-core';
import { incCounter, setGauge } from '@pipeline-builder/api-server';

const logger = createLogger('oncall-rota');

export async function publishRotaCoverage(): Promise<void> {
  const cfg = onCallInboundConfig();
  const coverage = await fetchRotaCoverage(cfg);

  if (!coverage.known) {
    // Deliberately NO gauge write. See the module note: a 0 here would be the
    // most dangerous possible value.
    incCounter('oncall_rota_reads_total', { outcome: 'unknown' });
    return;
  }

  incCounter('oncall_rota_reads_total', { outcome: coverage.entries > 0 ? 'covered' : 'uncovered' });
  setGauge('oncall_schedule_uncovered_seconds', {}, coverage.uncoveredSeconds);

  if (coverage.uncoveredSeconds > 0) {
    // Logged as an error, not a warning: this is a 24x7 contractual response
    // target with nobody rostered against it.
    logger.error('Nobody is on call across the lookahead window', {
      lookaheadHours: cfg.lookaheadHours,
      uncoveredSeconds: coverage.uncoveredSeconds,
    });
  }
}
