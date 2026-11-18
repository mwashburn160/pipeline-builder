// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-destination alert delivery health (pipeline-data `alert_destination_status`).
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

import { createLogger, errorMessage, leaderLockKey } from '@pipeline-builder/api-core';
import { runWithTenantContext, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { IntervalSweepDefinition } from './background-sweeps.js';
import { notifyOrgAdmins } from './platform-client.js';
import { config } from '../config/index.js';
import { setGauge } from '../observability/metrics.js';

const logger = createLogger('alert-delivery-status');

/** Delivery error CLASSES (never the downstream status code or host). */
export const DELIVERY_ERROR_KINDS = ['timeout', 'rejected', 'unreachable', 'unknown-channel'] as const;
export type DeliveryErrorKind = typeof DELIVERY_ERROR_KINDS[number];

/** A destination nothing has tried to reach for this long drops out (retention sweep). */
export const DESTINATION_STATUS_TTL_MS = 30 * 86_400_000;

/** Read lazily so importing this module touches no schema (suites stub pipeline-data). */
const T = () => schema.alertDestinationStatus;

/**
 * Every read and write here is operator work across orgs (the relay fans one
 * webhook out to every org's destinations), so it runs under a sysadmin tenant
 * context — FORCE'd RLS on `alert_destination_status` still governs it.
 */
function asSystem<R>(fn: () => Promise<R>): Promise<R> {
  return runWithTenantContext({ isSuperAdmin: true }, fn);
}

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
    if (outcome.ok) {
      await asSystem(() => withTenantTx((tx) => tx.insert(T()).values({
        destinationId: d.id,
        orgId: d.orgId,
        channel: d.channel,
        lastAttemptAt: now,
        lastOk: true,
        lastErrorKind: null,
        lastSuccessAt: now,
        consecutiveFailures: 0,
        notifiedAt: null,
      }).onConflictDoUpdate({
        target: T().destinationId,
        set: { orgId: d.orgId, channel: d.channel, lastAttemptAt: now, lastOk: true, lastErrorKind: null, lastSuccessAt: now, consecutiveFailures: 0, notifiedAt: null },
      })));
      return;
    }
    const [updated] = await asSystem(() => withTenantTx((tx) => tx.insert(T()).values({
      destinationId: d.id,
      orgId: d.orgId,
      channel: d.channel,
      lastAttemptAt: now,
      lastOk: false,
      lastErrorKind: outcome.kind,
      lastFailureAt: now,
      consecutiveFailures: 1,
    }).onConflictDoUpdate({
      target: T().destinationId,
      set: {
        orgId: d.orgId,
        channel: d.channel,
        lastAttemptAt: now,
        lastOk: false,
        lastErrorKind: outcome.kind,
        lastFailureAt: now,
        consecutiveFailures: sql`${T().consecutiveFailures} + 1`,
      },
    }).returning({ consecutiveFailures: T().consecutiveFailures, notifiedAt: T().notifiedAt })));
    if (!updated || updated.consecutiveFailures < DESTINATION_FAILURE_NOTIFY_THRESHOLD || updated.notifiedAt) return;
    // Claim the notice atomically so two relays crossing the threshold together send one email.
    const claimed = await asSystem(() => withTenantTx((tx) => tx.update(T())
      .set({ notifiedAt: now })
      .where(and(eq(T().destinationId, d.id), isNull(T().notifiedAt)))
      .returning({ destinationId: T().destinationId })));
    if (claimed.length === 0) return;
    await notifyOrgOfFailingDestination(d, updated.consecutiveFailures, outcome.kind);
  } catch (err) {
    logger.warn('Could not record alert delivery status', { destinationId: d.id, error: errorMessage(err) });
  }
}

/** The notice's plain-text body (the relay's tenant leg sends text). */
export function failingDestinationText(d: StatusDestination, failures: number, kind: DeliveryErrorKind): string {
  const settingsUrl = `${config.app.frontendUrl}/dashboard/observability/alert-destinations`;
  return [
    'Hello,',
    '',
    `Alerts for your organization could not be delivered to the ${d.channel} destination "${d.label ?? d.channel}" the last ${failures} times we tried (reason: ${kind}).`,
    '',
    'Until it is fixed, alerts sent there are not reaching anyone. Check that the destination is still valid - for example, that a Slack webhook has not been revoked - and use "Send test" to confirm it works:',
    settingsUrl,
    '',
    'We send this once per failing streak; you will not hear again about this destination until it has delivered successfully.',
  ].join('\n');
}

/**
 * Tell the org's active owners/admins that a destination keeps failing. Never
 * throws. Platform resolves the recipients (it owns the member directory).
 */
async function notifyOrgOfFailingDestination(d: StatusDestination, failures: number, kind: DeliveryErrorKind): Promise<void> {
  const sent = await notifyOrgAdmins({
    orgId: d.orgId,
    subject: `Alert destination "${d.label ?? d.channel}" is failing`,
    text: failingDestinationText(d, failures, kind),
  });
  if (sent) logger.info('Told the org its alert destination keeps failing', { orgId: d.orgId, destinationId: d.id, failures });
  else logger.warn('Failing-destination notice was not sent', { orgId: d.orgId, destinationId: d.id });
}

function iso(d: Date | null | undefined): string | null {
  return d ? new Date(d).toISOString() : null;
}

/** Statuses for a set of destinations, by id (missing = never attempted). */
export async function deliveryStatusesFor(destinationIds: readonly string[]): Promise<Map<string, DeliveryStatusView>> {
  const out = new Map<string, DeliveryStatusView>();
  if (destinationIds.length === 0) return out;
  const rows = await asSystem(() => withTenantTx((tx) => tx.select().from(T()).where(inArray(T().destinationId, [...destinationIds]))));
  for (const r of rows) {
    out.set(r.destinationId, {
      lastAttemptAt: new Date(r.lastAttemptAt).toISOString(),
      lastOk: r.lastOk,
      lastErrorKind: (r.lastErrorKind as DeliveryErrorKind | null) ?? null,
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
  // One row per (channel, org): failing when ANY of the org's destinations on
  // that channel last failed.
  const rows = await asSystem(() => withTenantTx((tx) => tx
    .select({ channel: T().channel, orgId: T().orgId, failing: sql<boolean>`bool_or(NOT ${T().lastOk})` })
    .from(T())
    .where(gte(T().lastAttemptAt, since))
    .groupBy(T().channel, T().orgId)));
  const byChannel: Record<string, { attempted: number; failing: number }> = {};
  for (const r of rows) {
    const c = (byChannel[r.channel] ??= { attempted: 0, failing: 0 });
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

/** Drop status rows nothing has tried to reach within {@link DESTINATION_STATUS_TTL_MS}. */
export async function pruneStaleDeliveryStatus(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DESTINATION_STATUS_TTL_MS);
  const removed = await asSystem(() => withTenantTx((tx) => tx.delete(T())
    .where(lt(T().lastAttemptAt, cutoff))
    .returning({ destinationId: T().destinationId })));
  return removed.length;
}

/** The retention half of the status table (Mongo's TTL index did this before the move). */
export function deliveryStatusRetentionSweep(intervalMs: number = 6 * 60 * 60 * 1000): IntervalSweepDefinition {
  return {
    name: 'alert-delivery-status-retention',
    lockKey: leaderLockKey('ops-center', 'alert-delivery-status-retention'),
    // A bounded DELETE by age: two replicas racing it delete the same rows once.
    concurrencySafe: true,
    intervalMs,
    run: async () => {
      const removed = await pruneStaleDeliveryStatus();
      if (removed > 0) logger.info('Pruned stale alert delivery status rows', { removed });
    },
  };
}
