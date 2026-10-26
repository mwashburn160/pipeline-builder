// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /api/observability/postgres-rung — Alertmanager-driven vertical scaling.
 *
 * Alertmanager routes the Postgres CPU/memory alerts here (each target's
 * config/alertmanager/alertmanager.yml) and this moves the named workload one
 * rung up or down. Separate from the `/alert-webhook` relay for the same reason
 * `/pvc-autoexpand` is: that one FANS OUT notifications, this one MUTATES a
 * running database, and they should not share a blast radius, a rate limiter,
 * or a reason to be enabled.
 *
 * Auth is the same per-instance shared secret (helpers/alertmanager-auth.ts).
 *
 * THE DIRECTION COMES FROM THE ALERT NAME, never from the request body. A
 * webhook that took `{"direction":"up"}` would let anything holding the relay
 * token resize the primary; the alert names are a closed set this file owns.
 */

import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { authenticateAlertmanager } from '../helpers/alertmanager-auth.js';
import { withController } from '../helpers/controller-helper.js';
import { incCounter } from '../observability/metrics.js';
import { scaleRung, type Direction, type RungResult, type Workload } from '../services/postgres-rung.js';

const logger = createLogger('postgres-rung');

/**
 * The closed set of alerts that mean "move a rung", and which way.
 *
 * Saturation is split by WORKLOAD because the two scale differently: the
 * primary has only this ladder (writes do not scale horizontally), while a
 * standby scales OUT first and reaches the ladder only at its replica ceiling.
 *
 * `PostgresReadReplicaSaturated` fires above KEDA's own threshold (85% vs 75%),
 * so its arrival already means the autoscaler could not fix it — but the
 * service re-checks the live replica count, because an alert cannot see it.
 */
const ACTIONABLE: Record<string, { workload: Workload; direction: Direction }> = {
  PostgresPrimaryCpuSaturated: { workload: 'primary', direction: 'up' },
  PostgresPrimaryMemoryPressure: { workload: 'primary', direction: 'up' },
  PostgresPrimaryUnderutilised: { workload: 'primary', direction: 'down' },
  PostgresReadReplicaSaturated: { workload: 'replica', direction: 'up' },
  PostgresReadReplicaUnderutilised: { workload: 'replica', direction: 'down' },
};

interface IncomingAlert {
  status?: string;
  labels?: Record<string, string>;
}

export const postgresRungWebhook = withController('Postgres rung scaling', async (req, res) => {
  const auth = authenticateAlertmanager(req);
  if (!auth.ok) {
    if (auth.reason !== 'no-instances') {
      logger.warn('Postgres rung webhook rejected', { reason: auth.reason });
    }
    return sendError(res, auth.status, auth.message);
  }

  const body = req.body as { alerts?: IncomingAlert[] } | undefined;
  if (!body || !Array.isArray(body.alerts)) {
    return sendError(res, 400, 'Invalid webhook payload');
  }

  // Collapse the batch to at most ONE decision per workload, and let UP win.
  //
  // Alertmanager groups alerts, so a single POST legitimately carries the CPU
  // and the memory rule for the same workload — acting twice would burn the
  // cooldown on a no-op. More importantly it can carry an UP and a DOWN for the
  // same workload during a transition, and resolving that toward UP is the
  // safe direction: being one rung too large costs money, being one rung too
  // small on a saturated single primary costs writes.
  const decisions = new Map<Workload, Direction>();
  let ignored = 0;
  for (const alert of body.alerts) {
    const labels = alert.labels ?? {};
    const match = ACTIONABLE[labels.alertname ?? ''];
    if (alert.status !== 'firing' || !match) { ignored++; continue; }
    const existing = decisions.get(match.workload);
    if (existing === 'up') continue;
    decisions.set(match.workload, match.direction === 'up' ? 'up' : (existing ?? 'down'));
  }
  if (ignored > 0) incCounter('postgres_rung_ignored_total', {}, ignored);

  const namespace = config.postgresRung.namespace;
  const results: RungResult[] = [];
  for (const [workload, direction] of decisions) {
    // Sequential, not Promise.all: each call takes a Redis lock and may restart
    // a database container. Concurrency buys nothing (at most two workloads)
    // and scaling the primary and its standbys at the same instant would remove
    // the fallback the read path depends on.
    results.push(await scaleRung(namespace, workload, direction, config.postgresRung));
  }

  const summary = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  logger.info('Postgres rung scaling processed', {
    instance: auth.instance.id, considered: decisions.size, ignored, ...summary,
  });
  sendSuccess(res, 200, { considered: decisions.size, ignored, results });
});
