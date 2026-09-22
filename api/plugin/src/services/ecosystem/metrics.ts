// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin-ecosystem operations metrics (docs/plugin-publishing.md).
 *
 * GAUGES are sampled by {@link sampleEcosystemMetrics} on EVERY replica (a
 * plain, unlocked scheduler — the reads are small), so whichever pod
 * Prometheus scrapes reports current values and a former leader never keeps
 * exporting a stale queue; the alert rules aggregate with `max()`:
 *
 *  - `ecosystem_requests_pending{kind,lane,status}` — the open queue;
 *  - `ecosystem_requests_oldest_pending_age_seconds{lane}`;
 *  - `ecosystem_requests_sla_breached{lane}` — open requests past the lane's
 *    SLA (standard 48 h, security-fix 4 h);
 *  - `ecosystem_resign_jobs_pending`, `ecosystem_resign_images_done`;
 *  - `ecosystem_approvers{permission,kind}` — Ecosystem Managers holding the
 *    decision permission (`kind="holders"`) and superadmins, sampled from
 *    platform at most every {@link APPROVER_SAMPLE_MS};
 *  - `plugin_submission_backlog` — anonymous submissions in `pending_review`
 *    (gates running or awaiting moderation).
 *
 * COUNTERS and HISTOGRAMS are recorded where the event happens:
 * `ecosystem_decisions_total{kind,decision}` and
 * `ecosystem_decision_latency_seconds{kind,lane}` (the console routes, via
 * {@link recordDecision}); auto-approvals, re-sign progress/failures and
 * notification sends/drops in their own modules. Anonymous submissions count
 * `plugin_submissions_total{status}` per transition and
 * `plugin_submission_gate_failures_total{gate}` per failed gate
 * ({@link recordSubmission}, {@link recordSubmissionGateFailures}).
 */

import { createLogger, createScheduler, errorMessage, REQUEST_SLA_HOURS, type Scheduler } from '@pipeline-builder/api-core';
import { incCounter, observe, setGauge } from '@pipeline-builder/api-server';
import type { PluginPublishRequest } from '@pipeline-builder/pipeline-data';

import { platformReads } from './platform-reads.js';
import type { DecisionPermission } from './policy.js';
import { pendingResignJobs } from './resign.js';
import { OPEN_STATUSES, requests } from './store.js';
import { submissions } from './submissions-store.js';

const logger = createLogger('ecosystem-metrics');

/** Gauge sampling interval (every replica). */
export const METRICS_INTERVAL_MS = 60_000;
/** How often the approver count is re-read from platform. */
export const APPROVER_SAMPLE_MS = 5 * 60_000;
/** Open requests considered per sample (the queue is small; this only caps a pathological backlog). */
const SAMPLE_LIMIT = 5_000;
const LANES = ['standard', 'security'] as const;

/** The pending-gauge label sets set last time, so a drained combination drops to 0. */
let lastPendingKeys = new Set<string>();
let lastApproverSample = 0;

/** The SLA hours of a lane. */
export function slaHoursFor(lane: string): number {
  return (REQUEST_SLA_HOURS as Record<string, number>)[lane] ?? REQUEST_SLA_HOURS.standard;
}

/** Whether an open request is past its lane's SLA at `now`. */
export function slaBreached(r: Pick<PluginPublishRequest, 'lane' | 'createdAt'>, now: Date): boolean {
  return now.getTime() - new Date(r.createdAt).getTime() > slaHoursFor(r.lane) * 3_600_000;
}

/** One sample of every ecosystem gauge. Exported for tests. */
export async function sampleEcosystemMetrics(now: Date = new Date()): Promise<void> {
  const open = await requests.list({ statuses: OPEN_STATUSES, limit: SAMPLE_LIMIT });

  const pending = new Map<string, { kind: string; lane: string; status: string; n: number }>();
  for (const r of open) {
    const key = `${r.kind}|${r.lane}|${r.status}`;
    const row = pending.get(key) ?? { kind: r.kind, lane: r.lane, status: r.status, n: 0 };
    row.n++;
    pending.set(key, row);
  }
  for (const key of lastPendingKeys) {
    if (!pending.has(key)) {
      const [kind, lane, status] = key.split('|') as [string, string, string];
      setGauge('ecosystem_requests_pending', { kind, lane, status }, 0);
    }
  }
  for (const { kind, lane, status, n } of pending.values()) setGauge('ecosystem_requests_pending', { kind, lane, status }, n);
  lastPendingKeys = new Set(pending.keys());

  for (const lane of LANES) {
    const inLane = open.filter((r) => r.lane === lane);
    const oldest = inLane.reduce((min, r) => Math.min(min, new Date(r.createdAt).getTime()), now.getTime());
    setGauge('ecosystem_requests_oldest_pending_age_seconds', { lane }, Math.max(0, (now.getTime() - oldest) / 1000));
    setGauge('ecosystem_requests_sla_breached', { lane }, inLane.filter((r) => slaBreached(r, now)).length);
  }

  setGauge('plugin_submission_backlog', {}, (await submissions.list({ statuses: ['pending_review'] })).length);

  const jobs = await pendingResignJobs();
  setGauge('ecosystem_resign_jobs_pending', {}, jobs.length);
  setGauge('ecosystem_resign_images_done', {}, jobs.reduce((n, j) => n + j.done.length, 0));

  if (now.getTime() - lastApproverSample >= APPROVER_SAMPLE_MS) {
    lastApproverSample = now.getTime();
    for (const permission of ['plugins:moderate', 'publishers:verify'] as DecisionPermission[]) {
      const count = await platformReads().approvers(permission);
      // Unknown stays unknown: no sample rather than a false zero (the alert
      // would read a platform outage as an approver shortage).
      if (!count) continue;
      setGauge('ecosystem_approvers', { permission, kind: 'holders' }, count.holders);
      setGauge('ecosystem_approvers', { permission, kind: 'superadmins' }, count.superadmins);
    }
  }
}

/** Test hook: forget the sampler's memory (drained label sets, last approver read). */
export function resetEcosystemMetricsForTests(): void {
  lastPendingKeys = new Set();
  lastApproverSample = 0;
}

/**
 * A manager's decision on a request: `first_approval` (parked for a second
 * approver), `approved` (executed), `second_approval` (executed) or `rejected`.
 * A FINAL decision also observes the request's queue latency.
 */
export function recordDecision(
  r: Pick<PluginPublishRequest, 'kind' | 'lane' | 'createdAt'>,
  decision: 'first_approval' | 'approved' | 'second_approval' | 'rejected',
  now: Date = new Date(),
): void {
  incCounter('ecosystem_decisions_total', { kind: r.kind, decision });
  if (decision !== 'first_approval') {
    observe('ecosystem_decision_latency_seconds', { kind: r.kind, lane: r.lane }, Math.max(0, (now.getTime() - new Date(r.createdAt).getTime()) / 1000));
  }
}

/** An anonymous submission entered `status`. */
export function recordSubmission(status: string): void {
  incCounter('plugin_submissions_total', { status });
}

/** One count per failed automated gate of a submission. */
export function recordSubmissionGateFailures(gates: readonly string[]): void {
  for (const gate of new Set(gates)) incCounter('plugin_submission_gate_failures_total', { gate });
}

/** Build (not start) the sampler: every minute, on every replica (no lock). */
export function createEcosystemMetricsScheduler(): Scheduler {
  return createScheduler({
    name: 'ecosystem-metrics',
    intervalMs: METRICS_INTERVAL_MS,
    startupDelayMs: 15_000,
    run: async () => {
      try {
        await sampleEcosystemMetrics();
      } catch (err) {
        logger.warn('Ecosystem metrics sample failed', { error: errorMessage(err) });
      }
    },
  });
}
