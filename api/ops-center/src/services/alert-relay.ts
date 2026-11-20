// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import type { AlertRuleSeverity } from '@pipeline-builder/api-core/wire-vocabulary';
import { schema } from '@pipeline-builder/pipeline-data';
import { recordDeliveryOutcome } from './alert-delivery-status.js';
import { alertDestinationService } from './alert-destination-service.js';
import { getNotificationChannel, plainTextBody, severityToPriority, subjectLine, toAlertSeverity, type AlertNotification } from './notification-channels.js';
import { config } from '../config/index.js';
import { incCounter } from '../observability/metrics.js';

type OrgAlertDestination = typeof schema.orgAlertDestination.$inferSelect;
type Alert = AlertmanagerWebhook['alerts'][number];
type DeliveryOutcome = 'delivered' | 'failed' | 'skipped';

const logger = createLogger('alert-relay');

/** Alertmanager v2 webhook payload  minimal subset we depend on. */
export interface AlertmanagerWebhook {
  version: '4';
  groupKey: string;
  status: 'firing' | 'resolved';
  receiver: string;
  groupLabels: Record<string, string>;
  commonLabels: Record<string, string>;
  commonAnnotations: Record<string, string>;
  alerts: Array<{
    status: 'firing' | 'resolved';
    labels: Record<string, string>;
    annotations: Record<string, string>;
    startsAt: string;
    endsAt: string;
    generatorURL?: string;
    fingerprint?: string;
  }>;
}

/** Fan-out timeout for a single destination POST (see config.observability). */
const DELIVERY_TIMEOUT_MS = config.observability.alertDeliveryTimeoutMs;

/**
 * Receive an Alertmanager webhook and forward each alert to every matching
 * destination registered for its `org_id` label. One destination per channel
 * is delivered with a bounded timeout; failures are logged but don't abort
 * the rest of the fan-out.
 *
 * Returns counts so the controller can include `{ delivered, skipped, failed }`
 * in its response  useful for the relay-health Prometheus alert (if/when we
 * add one).
 */
export async function relayWebhook(payload: AlertmanagerWebhook): Promise<{
  delivered: number;
  skipped: number;
  failed: number;
}> {
  let delivered = 0;
  let skipped = 0;
  let failed = 0;

  for (const raw of payload.alerts) {
    // The controller checks only that `alerts` is an array. A malformed entry is
    // skipped, never thrown on: a throw 500s the webhook and Alertmanager
    // re-sends the whole group, duplicating what was already delivered.
    if (!isPlainObject(raw) || !isPlainObject(raw.labels)) {
      skipped++;
      logger.warn('Skipping malformed alert (no labels object)');
      continue;
    }
    const alert: Alert = isPlainObject(raw.annotations) ? raw : { ...raw, annotations: {} };
    const orgId = alert.labels.org_id;
    if (!orgId) {
      // Platform-wide alert that shouldn't have hit this relay  Alertmanager
      // routing should have sent it to the ops-team Slack receiver. Count
      // as skipped + log; helps catch a routing bug if it ever happens.
      skipped++;
      logger.debug('Skipping alert without org_id', { alertname: alert.labels.alertname });
      continue;
    }

    // Delivery tier on the destination ladder: anything below critical
    // (`info` included) reaches the warning-floor destinations.
    const tier: AlertRuleSeverity = toAlertSeverity(alert.labels.severity) === 'critical' ? 'critical' : 'warning';
    let destinations: OrgAlertDestination[] = [];
    try {
      destinations = await alertDestinationService.findForDelivery(orgId, tier);
    } catch (err) {
      // DB lookup failed  surfacing this in the response so the operator
      // knows their org's alerts aren't being delivered. The alert is still
      // visible in the in-cluster Alertmanager UI / our /alerts page.
      failed++;
      logger.warn('Destination lookup failed', { orgId, error: errorMessage(err) });
      continue;
    }

    if (destinations.length === 0) {
      skipped++;
      continue;
    }

    // Per-destination fan-out. We deliver sequentially rather than in parallel
    // so a single org with N destinations doesn't burst N requests at once;
    // the per-destination timeout is the only latency bound.
    for (const d of destinations) {
      const outcome = await deliverOne(d, alert).catch((err) => {
        logger.warn('Destination delivery threw', {
          destinationId: d.id, channel: d.channel, error: errorMessage(err),
        });
        return 'failed' as DeliveryOutcome;
      });
      if (outcome === 'delivered') delivered++;
      else if (outcome === 'skipped') skipped++;
      else failed++;
    }
  }

  return { delivered, skipped, failed };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Map an Alertmanager alert + destination onto the transport-agnostic message. */
function toNotificationMessage(d: OrgAlertDestination, alert: Alert): AlertNotification {
  const severity = toAlertSeverity(alert.labels.severity);
  const base = {
    severity,
    status: alert.status,
    timestamp: alert.startsAt,
    title: alert.labels.alertname ?? 'Alert',
    summary: alert.annotations.summary ?? '',
    detail: alert.annotations.description,
    labels: alert.labels,
  };
  return {
    ...base,
    recipientOrgId: d.orgId,
    subject: subjectLine(base),
    body: plainTextBody(base),
    priority: severityToPriority(severity),
    messageType: 'announcement',
    payload: alert, // generic `webhook` channel forwards this unchanged
    dedupeKey: alert.fingerprint,
  };
}

/**
 * Deliver one alert to one destination via its channel adapter. Owns the
 * cross-cutting concerns — the bounded-timeout AbortController and outcome
 * logging — and delegates the transport to the channel. Returns the outcome
 * so the relay can tally delivered / skipped / failed.
 */
async function deliverOne(d: OrgAlertDestination, alert: Alert): Promise<DeliveryOutcome> {
  const channel = getNotificationChannel(d.channel);
  if (!channel) {
    logger.warn('Unknown alert destination channel', { destinationId: d.id, channel: d.channel });
    incCounter('alert_notification_delivery', { channel: d.channel, result: 'failed' });
    await recordDeliveryOutcome(d, { ok: false, kind: 'unknown-channel' });
    return 'failed';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await channel.deliver(
      toNotificationMessage(d, alert),
      { value: d.target, orgId: d.orgId },
      controller.signal,
    );
    const result: DeliveryOutcome = res.skipped ? 'skipped' : res.ok ? 'delivered' : 'failed';
    if (result === 'failed') {
      logger.warn('Destination delivery non-ok', {
        destinationId: d.id, channel: d.channel, code: res.code, error: res.error,
      });
    } else if (result === 'skipped') {
      logger.debug('Destination delivery skipped', {
        destinationId: d.id, channel: d.channel, reason: res.error,
      });
    }
    incCounter('alert_notification_delivery', { channel: d.channel, result });
    // The org sees its own destination's health (a skip is not an attempt).
    if (result !== 'skipped') {
      await recordDeliveryOutcome(d, result === 'delivered' ? { ok: true } : { ok: false, kind: 'rejected' });
    }
    return result;
  } catch (err) {
    const timedOut = (err as { name?: string }).name === 'AbortError';
    if (timedOut) {
      logger.warn('Destination delivery timed out', { destinationId: d.id, timeoutMs: DELIVERY_TIMEOUT_MS });
    } else {
      logger.warn('Destination delivery failed', { destinationId: d.id, error: errorMessage(err) });
    }
    incCounter('alert_notification_delivery', { channel: d.channel, result: 'failed' });
    await recordDeliveryOutcome(d, { ok: false, kind: timedOut ? 'timeout' : 'unreachable' });
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}
