// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /api/observability/pvc-autoexpand — Alertmanager-driven PVC expansion.
 *
 * Alertmanager routes the storage alerts here (deploy/aws/eks/config/alertmanager/
 * alertmanager.yml) and this grows the claim they name. Separate from the
 * `/alert-webhook` relay on purpose: that one FANS OUT notifications, this one
 * MUTATES cluster storage, and they should not share a blast radius, a rate
 * limiter, or a reason to be enabled.
 *
 * Auth is the same per-instance shared secret (helpers/alertmanager-auth.ts).
 *
 * Only alerts that actually describe a filling PersistentVolume are acted on —
 * `status: firing`, a known alertname, and both `namespace` and
 * `persistentvolumeclaim` labels. Anything else is counted and ignored rather
 * than rejected, because Alertmanager groups alerts and a batch legitimately
 * arrives with a mix.
 */

import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { authenticateAlertmanager } from '../helpers/alertmanager-auth.js';
import { withController } from '../helpers/controller-helper.js';
import { incCounter } from '../observability/metrics.js';
import { expandClaim, type AutoExpandResult } from '../services/pvc-autoexpand.js';

const logger = createLogger('pvc-autoexpand');

/** The alerts that mean "a PersistentVolume is running out of room". */
const ACTIONABLE = new Set(['PersistentVolumeFillingUp', 'PersistentVolumeCriticallyFull']);

interface IncomingAlert {
  status?: string;
  labels?: Record<string, string>;
}

export const pvcAutoExpandWebhook = withController('PVC auto-expand', async (req, res) => {
  const auth = authenticateAlertmanager(req);
  if (!auth.ok) {
    if (auth.reason !== 'no-instances') {
      logger.warn('PVC auto-expand webhook rejected', { reason: auth.reason });
    }
    return sendError(res, auth.status, auth.message);
  }

  const body = req.body as { alerts?: IncomingAlert[] } | undefined;
  if (!body || !Array.isArray(body.alerts)) {
    return sendError(res, 400, 'Invalid webhook payload');
  }

  // De-duplicate within the batch: Alertmanager can group the warning and the
  // critical rule for the SAME claim into one POST, and acting twice would burn
  // the cooldown on a no-op.
  const seen = new Set<string>();
  const targets: { namespace: string; claim: string }[] = [];
  let ignored = 0;
  for (const alert of body.alerts) {
    const labels = alert.labels ?? {};
    if (alert.status !== 'firing' || !ACTIONABLE.has(labels.alertname ?? '')) { ignored++; continue; }
    const namespace = labels.namespace;
    const claim = labels.persistentvolumeclaim;
    if (!namespace || !claim) { ignored++; continue; }
    const key = `${namespace}/${claim}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ namespace, claim });
  }
  if (ignored > 0) incCounter('pvc_autoexpand_ignored_total', {}, ignored);

  const results: AutoExpandResult[] = [];
  for (const t of targets) {
    // Sequential, not Promise.all: each call takes a Redis lock and may modify
    // an EBS volume. Concurrency buys nothing here (a batch is a handful of
    // claims) and would make the API-server load spiky under an alert storm.
    results.push(await expandClaim(t.namespace, t.claim, config.pvcAutoExpand));
  }

  const summary = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  logger.info('PVC auto-expand processed', { instance: auth.instance.id, considered: targets.length, ignored, ...summary });
  sendSuccess(res, 200, { considered: targets.length, ignored, results });
});
