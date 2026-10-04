// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /api/observability/node-disk-autoexpand — Alertmanager-driven growth of
 * the ec2 instance's data volume.
 *
 * Sibling of /observability/pvc-autoexpand, kept separate because the actuators
 * are unrelated: that one patches a PersistentVolumeClaim through the
 * Kubernetes API, this one calls ec2:ModifyVolume and then runs a fixed SSM
 * document to resize the filesystem. Separate endpoints mean each is enabled,
 * permissioned and fails independently.
 *
 * Unlike the PVC path there is nothing per-alert to extract: every
 * NodeDisk* alert on this target points at the same one volume. So the batch
 * collapses to a single decision, and the cooldown inside the service is what
 * keeps a grouped warning+critical pair from acting twice.
 */

import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { authenticateAlertmanager } from '../helpers/alertmanager-auth.js';
import { withController } from '../helpers/controller-helper.js';
import { incCounter } from '../observability/metrics.js';
import { expandNodeDisk } from '../services/node-disk-autoexpand.js';

const logger = createLogger('node-disk-autoexpand');

const ACTIONABLE = new Set(['NodeDiskFillingUp', 'NodeDiskCriticallyFull']);

export const nodeDiskAutoExpandWebhook = withController('Node disk auto-expand', async (req, res) => {
  const auth = authenticateAlertmanager(req);
  if (!auth.ok) {
    if (auth.reason !== 'no-instances') logger.warn('Node-disk auto-expand rejected', { reason: auth.reason });
    return sendError(res, auth.status, auth.message);
  }

  const body = req.body as { alerts?: { status?: string; labels?: Record<string, string> }[] } | undefined;
  if (!body || !Array.isArray(body.alerts)) return sendError(res, 400, 'Invalid webhook payload');

  const firing = body.alerts.filter((a) => a.status === 'firing' && ACTIONABLE.has(a.labels?.alertname ?? ''));
  if (firing.length === 0) {
    incCounter('node_disk_autoexpand_ignored_total', {}, body.alerts.length);
    return sendSuccess(res, 200, { considered: 0, ignored: body.alerts.length });
  }

  const result = await expandNodeDisk(config.nodeDiskAutoExpand);
  logger.info('Node-disk auto-expand processed', { instance: auth.instance.id, firing: firing.length, outcome: result.outcome });
  sendSuccess(res, 200, { considered: 1, ignored: body.alerts.length - firing.length, result });
});
