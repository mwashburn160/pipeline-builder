// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { schema, withTenantTx } from '@pipeline-builder/pipeline-core';
import { alertDestinationService } from './alert-destination-service';

type OrgAlertDestination = typeof schema.orgAlertDestination.$inferSelect;

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
      const ok = await deliverOne(d, alert).catch((err) => {
        logger.warn('Destination delivery threw', {
          destinationId: d.id, channel: d.channel, error: errorMessage(err),
        });
        return false;
      });
      if (ok) delivered++; else failed++;
    }
  }

  return { delivered, skipped, failed };
}

/**
 * Deliver one alert to one destination. Channel-specific * - `slack`  POST a Slack-shaped block payload to the webhook URL
 * - `webhook`  POST the Alertmanager-style alert payload as-is
 * - `in-app`  append a row to the `messages` table; the org's inbox UI
 * surfaces it via the platform message service..
 */
async function deliverOne(d: OrgAlertDestination, alert: AlertmanagerWebhook['alerts'][number]): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    if (d.channel === 'slack') {
      const body = JSON.stringify(slackPayload(alert));
      const resp = await fetch(d.target, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!resp.ok) {
        logger.warn('Slack delivery non-2xx', { destinationId: d.id, status: resp.status });
        return false;
      }
      return true;
    }
    if (d.channel === 'webhook') {
      const resp = await fetch(d.target, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert),
      });
      if (!resp.ok) {
        logger.warn('Webhook delivery non-2xx', { destinationId: d.id, status: resp.status });
        return false;
      }
      return true;
    }
    if (d.channel === 'in-app') {
      // in-app alerts get an entry in the org's `messages` inbox.
      // Authored by the system org so the recipient sees a clear sender;
      // priority maps from alert severity (critical → urgent, warning → high).
      // We're already inside `runWithTenantContext({ isSuperAdmin: true })`
      // (set by the alertWebhook controller) so withTenantTx can write across
      // orgs under FORCE'd RLS on the `messages` table.
      const sev = alert.labels.severity ?? 'info';
      const priority = sev === 'critical' ? 'urgent': sev === 'warning' ? 'high': 'normal';
      const subject = `[${sev.toUpperCase()}] ${alert.labels.alertname ?? 'Alert'}`;
      const content = inAppContent(alert);
      try {
        await withTenantTx(async (tx) => tx.insert(schema.message).values({
          orgId: 'system',
          recipientOrgId: d.orgId,
          createdBy: 'alert-relay',
          updatedBy: 'alert-relay',
          messageType: 'announcement',
          subject,
          content,
          priority,
        }));
        return true;
      } catch (err) {
        logger.warn('In-app alert insert failed', {
          destinationId: d.id, orgId: d.orgId, error: errorMessage(err),
        });
        return false;
      }
    }
    return false;
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      logger.warn('Destination delivery timed out', { destinationId: d.id, timeoutMs: DELIVERY_TIMEOUT_MS });
    } else {
      logger.warn('Destination delivery failed', { destinationId: d.id, error: errorMessage(err) });
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the plain-text content of an in-app `messages` row from an alert.
 * Kept short  the inbox UI is a single message body, not a dashboard.
 * Labels other than `alertname`/`severity`/`tenancy` are appended as
 * `key=value` pairs so operators can correlate without leaving the inbox.
 */
function inAppContent(alert: AlertmanagerWebhook['alerts'][number]): string {
  const lines: string[] = [];
  if (alert.annotations.summary) lines.push(alert.annotations.summary);
  if (alert.annotations.description) lines.push('', alert.annotations.description);
  const extraLabels = Object.entries(alert.labels)
    .filter(([k]) => !['alertname', 'severity', 'tenancy', 'org_id'].includes(k))
    .map(([k, v]) => `${k}=${v}`);
  if (extraLabels.length > 0) lines.push('', extraLabels.join(' '));
  lines.push('', `Status: ${alert.status} · Started: ${alert.startsAt}`);
  return lines.join('\n');
}

/** Build a Slack incoming-webhook payload from an alert. Color matches
 * severity so on-call eyeballs find critical alerts faster. */
function slackPayload(alert: AlertmanagerWebhook['alerts'][number]): Record<string, unknown> {
  const sev = alert.labels.severity ?? 'info';
  const color = sev === 'critical' ? '#dc2626': sev === 'warning' ? '#eab308': '#3b82f6';
  const titleEmoji = alert.status === 'resolved' ? '✅': sev === 'critical' ? '🚨': '⚠️';
  return {
    attachments: [{
      color,
      title: `${titleEmoji} [${sev.toUpperCase()}] ${alert.labels.alertname ?? 'Alert'}`,
      text: alert.annotations.summary ?? '',
      fields: [
        ...(alert.annotations.description ? [{ title: 'Detail', value: alert.annotations.description, short: false }]: []),
        ...Object.entries(alert.labels)
          .filter(([k]) => !['alertname', 'severity', 'tenancy'].includes(k))
          .map(([k, v]) => ({ title: k, value: v, short: true })),
        { title: 'Status', value: alert.status, short: true },
        { title: 'Started', value: alert.startsAt, short: true },
      ],
      footer: 'Pipeline Builder alerts',
    }],
  };
}
