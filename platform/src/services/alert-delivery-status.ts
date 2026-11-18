// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-destination alert delivery health (models/alert-destination-status.ts).
 *
 * Three jobs:
 *   1. {@link recordDeliveryOutcome} — after every real attempt the relay makes,
 *      stamp the destination's last outcome. Best-effort: a status write that
 *      fails must never fail the delivery it describes.
 *   2. The org is TOLD. When a destination fails
 *      {@link DESTINATION_FAILURE_NOTIFY_THRESHOLD} times in a row, the org's
 *      owners and admins get one email (and nothing more until it delivers
 *      again) — an org whose only destination is broken can't be told through it.
 *   3. {@link publishDeliveryHealth} — a sweep publishes, per channel, how many
 *      ORGS attempted delivery in the last hour and how many of those are
 *      failing (`alert_destination_orgs{channel,state}`). The platform alert
 *      (`AlertRelayDeliveryFailing`) fires on that ratio across orgs, so one
 *      tenant's revoked webhook reaches that tenant, not the platform's pager.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { ADMIN_ORG_ROLES } from '@pipeline-builder/api-core/wire-vocabulary';
import type { IntervalSweepDefinition } from './background-sweeps.js';
import { config } from '../config/index.js';
import type { AlertDestinationStatusData, DeliveryErrorKind } from '../models/alert-destination-status.js';
import { setGauge } from '../observability/metrics.js';

// Models are loaded lazily: this module is imported by the alert-destinations
// controller and the relay, whose import graphs (and the suites that mock
// mongoose under them) must not pull in the whole models barrel.
const statusModel = async () => (await import('../models/alert-destination-status.js')).default;

const logger = createLogger('alert-delivery-status');

/** Consecutive failures before the org's admins are emailed. */
export const DESTINATION_FAILURE_NOTIFY_THRESHOLD = 3;

/** The window `publishDeliveryHealth` counts orgs over. */
export const DELIVERY_HEALTH_WINDOW_MS = 60 * 60 * 1000;

/** How often the health gauges are recomputed. */
export const DELIVERY_HEALTH_INTERVAL_MS = 5 * 60 * 1000;

/** The destination fields the status needs. */
export interface StatusDestination {
  id: string;
  orgId: string;
  channel: string;
  label?: string;
}

/** What the destinations list shows for one destination (null = never attempted). */
export interface DeliveryStatusView {
  lastAttemptAt: string;
  lastOk: boolean;
  lastErrorKind: DeliveryErrorKind | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
}

/**
 * Record one delivery attempt's outcome. Never throws. A `failed` outcome that
 * reaches the threshold (and hasn't been notified since the last success)
 * emails the org's admins once.
 */
export async function recordDeliveryOutcome(
  d: StatusDestination,
  outcome: { ok: true } | { ok: false; kind: DeliveryErrorKind },
  now: Date = new Date(),
): Promise<void> {
  try {
    const AlertDestinationStatus = await statusModel();
    if (outcome.ok) {
      await AlertDestinationStatus.updateOne(
        { destinationId: d.id },
        {
          $set: {
            orgId: d.orgId,
            channel: d.channel,
            lastAttemptAt: now,
            lastOk: true,
            lastErrorKind: null,
            lastSuccessAt: now,
            consecutiveFailures: 0,
            notifiedAt: null,
          },
        },
        { upsert: true },
      );
      return;
    }
    const updated = await AlertDestinationStatus.findOneAndUpdate(
      { destinationId: d.id },
      {
        $set: { orgId: d.orgId, channel: d.channel, lastAttemptAt: now, lastOk: false, lastErrorKind: outcome.kind, lastFailureAt: now },
        $inc: { consecutiveFailures: 1 },
      },
      { upsert: true, new: true },
    ).lean();
    if (!updated || updated.consecutiveFailures < DESTINATION_FAILURE_NOTIFY_THRESHOLD || updated.notifiedAt) return;
    // Claim the notice atomically so two relays crossing the threshold together send one email.
    const claimed = await AlertDestinationStatus.updateOne(
      { destinationId: d.id, notifiedAt: null },
      { $set: { notifiedAt: now } },
    );
    if ((claimed.modifiedCount ?? 0) === 0) return;
    await notifyOrgOfFailingDestination(d, updated.consecutiveFailures, outcome.kind);
  } catch (err) {
    logger.warn('Could not record alert delivery status', { destinationId: d.id, error: errorMessage(err) });
  }
}

/** Email the org's active owners/admins that a destination keeps failing. Never throws. */
async function notifyOrgOfFailingDestination(d: StatusDestination, failures: number, kind: DeliveryErrorKind): Promise<void> {
  try {
    const [{ Organization, User, UserOrganization }, { toOrgId }] = await Promise.all([
      import('../models/index.js'),
      import('../helpers/org-id.js'),
    ]);
    const [org, admins] = await Promise.all([
      Organization.findById(toOrgId(d.orgId)).select('name').lean(),
      UserOrganization.find({ organizationId: toOrgId(d.orgId), isActive: true, role: { $in: [...ADMIN_ORG_ROLES] } })
        .select('userId').lean(),
    ]);
    if (!org || admins.length === 0) return;
    const users = await User.find({ _id: { $in: admins.map((a) => a.userId) } }).select('email').lean();
    const to = users.map((u) => u.email).filter((e): e is string => typeof e === 'string' && e.length > 0);
    if (to.length === 0) return;
    const { emailService } = await import('../utils/email.js');
    const { alertDestinationFailingTemplate } = await import('../utils/email-templates.js');
    await emailService.send({
      to,
      ...alertDestinationFailingTemplate({
        organizationName: String((org as { name?: string }).name ?? ''),
        destinationLabel: d.label ?? d.channel,
        channel: d.channel,
        failures,
        reason: kind,
        settingsUrl: `${config.app.frontendUrl}/dashboard/observability/alert-destinations`,
      }),
    });
    logger.info('Told the org its alert destination keeps failing', { orgId: d.orgId, destinationId: d.id, failures });
  } catch (err) {
    logger.warn('Failing-destination notice was not sent', { orgId: d.orgId, destinationId: d.id, error: errorMessage(err) });
  }
}

function iso(d: Date | null | undefined): string | null {
  return d ? new Date(d).toISOString() : null;
}

/** Statuses for a set of destinations, by id (missing = never attempted). */
export async function deliveryStatusesFor(destinationIds: readonly string[]): Promise<Map<string, DeliveryStatusView>> {
  const out = new Map<string, DeliveryStatusView>();
  if (destinationIds.length === 0) return out;
  const AlertDestinationStatus = await statusModel();
  const rows = await AlertDestinationStatus.find({ destinationId: { $in: [...destinationIds] } }).lean<AlertDestinationStatusData[]>();
  for (const r of rows) {
    out.set(r.destinationId, {
      lastAttemptAt: new Date(r.lastAttemptAt).toISOString(),
      lastOk: r.lastOk,
      lastErrorKind: r.lastErrorKind ?? null,
      lastSuccessAt: iso(r.lastSuccessAt),
      lastFailureAt: iso(r.lastFailureAt),
      consecutiveFailures: r.consecutiveFailures,
    });
  }
  return out;
}

/**
 * Publish `alert_destination_orgs{channel,state="attempted"|"failing"}`: orgs
 * with a delivery attempt on that channel in the last hour, and those whose
 * most recent attempt on it failed. Throws on a read failure (it is a sweep —
 * the scheduler must see it).
 */
export async function publishDeliveryHealth(now: Date = new Date()): Promise<Record<string, { attempted: number; failing: number }>> {
  const since = new Date(now.getTime() - DELIVERY_HEALTH_WINDOW_MS);
  const AlertDestinationStatus = await statusModel();
  const rows = await AlertDestinationStatus.aggregate<{ _id: { channel: string; orgId: string }; failing: boolean }>([
    { $match: { lastAttemptAt: { $gte: since } } },
    { $group: { _id: { channel: '$channel', orgId: '$orgId' }, failing: { $max: { $cond: ['$lastOk', 0, 1] } } } },
    { $project: { failing: { $eq: ['$failing', 1] } } },
  ]);
  const byChannel: Record<string, { attempted: number; failing: number }> = {};
  for (const r of rows) {
    const c = (byChannel[r._id.channel] ??= { attempted: 0, failing: 0 });
    c.attempted += 1;
    if (r.failing) c.failing += 1;
  }
  const { ALERT_CHANNELS } = await import('@pipeline-builder/api-core/wire-vocabulary');
  // Every known channel is published (zeros included), so a recovered channel
  // clears instead of holding its last failing value.
  for (const channel of new Set<string>([...ALERT_CHANNELS, ...Object.keys(byChannel)])) {
    const c = byChannel[channel] ?? { attempted: 0, failing: 0 };
    setGauge('alert_destination_orgs', { channel, state: 'attempted' }, c.attempted);
    setGauge('alert_destination_orgs', { channel, state: 'failing' }, c.failing);
  }
  return byChannel;
}

/**
 * The health gauges as a background sweep. On EVERY replica, deliberately: a
 * gauge is per-pod, so a leader-locked publisher would leave the other pods
 * exporting whatever they last computed (a former leader's stale "failing"),
 * and the reading is one cheap aggregate over a small collection.
 */
export function deliveryHealthSweep(intervalMs: number = DELIVERY_HEALTH_INTERVAL_MS): IntervalSweepDefinition {
  return {
    name: 'alert-delivery-health',
    intervalMs,
    run: async () => { await publishDeliveryHealth(); },
  };
}
