// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { schema } from '@pipeline-builder/pipeline-core';
import { alertDestinationService } from './alert-destination-service.js';
import { getNotificationChannel, type NotificationMessage, type Severity } from './notification-channels.js';
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

/**
 * Fan-out timeout for a single destination POST. Tight on purpose  a slow
 * Slack tenant shouldn't hold up the whole relay (Alertmanager retries the
 * webhook anyway). Override via `ALERT_DELIVERY_TIMEOUT_MS`.
 */
const DELIVERY_TIMEOUT_MS = parseInt(process.env.ALERT_DELIVERY_TIMEOUT_MS || '5000', 10);

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

  for (const alert of payload.alerts) {
    const orgId = alert.labels.org_id;
    if (!orgId) {
      // Platform-wide alert that shouldn't have hit this relay  Alertmanager
      // routing should have sent it to the ops-team Slack receiver. Count
      // as skipped + log; helps catch a routing bug if it ever happens.
      skipped++;
      logger.debug('Skipping alert without org_id', { alertname: alert.labels.alertname });
      continue;
    }

    const severity = (alert.labels.severity === 'critical' ? 'critical': 'warning') as 'critical' | 'warning';
    let destinations: OrgAlertDestination[] = [];
    try {
      destinations = await alertDestinationService.findForDelivery(orgId, severity);
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

/** Normalize the alert's raw `severity` label to the three rendered tiers. */
function alertSeverity(alert: Alert): Severity {
  return alert.labels.severity === 'critical' ? 'critical'
    : alert.labels.severity === 'warning' ? 'warning'
      : 'info';
}

/** Map an Alertmanager alert + destination onto the transport-agnostic message. */
function toNotificationMessage(d: OrgAlertDestination, alert: Alert): NotificationMessage {
  return {
    severity: alertSeverity(alert),
    status: alert.status,
    timestamp: alert.startsAt,
    title: alert.labels.alertname ?? 'Alert',
    summary: alert.annotations.summary ?? '',
    detail: alert.annotations.description,
    labels: alert.labels,
    recipientOrgId: d.orgId,
    raw: alert, // generic `webhook` channel forwards this unchanged
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
    return result;
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      logger.warn('Destination delivery timed out', { destinationId: d.id, timeoutMs: DELIVERY_TIMEOUT_MS });
    } else {
      logger.warn('Destination delivery failed', { destinationId: d.id, error: errorMessage(err) });
    }
    incCounter('alert_notification_delivery', { channel: d.channel, result: 'failed' });
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}
