// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Exemption expiry: the daily sweep that moves approved exemptions past their
 * `expiresAt` to `expired`, and warns each org before one lapses.
 *
 * WHY A SWEEP, when enforcement already ignores a lapsed row at read time
 * (`expiresAt > now` in the active-exemption predicate). Because the STORED
 * status was the only thing anything else could read: the "Expired" filter
 * always returned an empty page, and a lapsed carve-out still wore a green
 * "Approved" badge while the rule it waived had quietly started blocking again.
 * The read-time predicate stays — it is what makes enforcement exact between
 * sweeps — and the sweep makes the record say the same thing.
 *
 * WHY WARN. An exemption lapsing is a pipeline that passed yesterday and blocks
 * today. One in-app notice per org, `EXPIRY_WARN_DAYS` ahead, listing what is
 * about to lapse, gives somebody time to fix the entity. (It cannot be renewed
 * in place: the (org, rule, entity) unique index holds the approved row, so a
 * new request for it is refused until it lapses, and reopens it then.) Each
 * exemption is warned once (`expiry_warned_at`), so a skipped tick delays a
 * warning rather than losing it, and a repeated one never re-sends.
 *
 * Leader-locked and sysadmin-scoped (a cross-org sweep). A failure THROWS out of
 * the cycle so the scheduler records no success and `SchedulerJobStale` sees it.
 */

import {
  createLogger,
  createScheduler,
  DEFAULT_LEADER_LOCK_TTL_MS,
  envInt,
  leaderLockKey,
  recordAudit,
  SYSTEM_ACTOR_ID,
  type Scheduler,
} from '@pipeline-builder/api-core';
import { runWithTenantContext, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import { inAppChannel } from './notification-channels.js';

const logger = createLogger('exemption-expiry');

/** How far ahead of `expiresAt` the org is warned. */
export const EXPIRY_WARN_DAYS = envInt('COMPLIANCE_EXEMPTION_EXPIRY_WARN_DAYS', 7, { min: 1, max: 90 });
/** Sweep cadence — daily is enough at day-granularity warnings. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface LapsingRow {
  id: string;
  orgId: string;
  ruleId: string;
  entityType: string;
  entityName: string | null;
  expiresAt: Date | null;
}

function groupByOrg(rows: LapsingRow[]): Map<string, LapsingRow[]> {
  const byOrg = new Map<string, LapsingRow[]>();
  for (const r of rows) byOrg.set(r.orgId, [...(byOrg.get(r.orgId) ?? []), r]);
  return byOrg;
}

const describeRow = (r: LapsingRow) =>
  `- ${r.entityType} "${r.entityName ?? r.id}" (rule ${r.ruleId})${r.expiresAt ? ` — ${r.expiresAt.toISOString().slice(0, 10)}` : ''}`;

/**
 * Flip approved exemptions whose `expiresAt` has passed to `expired`. One audit
 * row per affected org. Returns the number of rows expired.
 */
export async function expireLapsedExemptions(now: Date = new Date()): Promise<number> {
  const expired = await withTenantTx(async (tx) => tx
    .update(schema.complianceExemption)
    .set({ status: 'expired', updatedBy: SYSTEM_ACTOR_ID, updatedAt: now })
    .where(and(
      eq(schema.complianceExemption.status, 'approved'),
      lte(schema.complianceExemption.expiresAt, now),
    ))
    .returning({
      id: schema.complianceExemption.id,
      orgId: schema.complianceExemption.orgId,
      ruleId: schema.complianceExemption.ruleId,
      entityType: schema.complianceExemption.entityType,
      entityName: schema.complianceExemption.entityName,
      expiresAt: schema.complianceExemption.expiresAt,
    })) as LapsingRow[];

  for (const [orgId, rows] of groupByOrg(expired)) {
    recordAudit({
      action: 'compliance.exemption.expire',
      actorId: SYSTEM_ACTOR_ID,
      orgId,
      targetType: 'exemption',
      details: { trigger: 'expiry', count: rows.length, ids: rows.map((r) => r.id) },
    });
  }
  if (expired.length > 0) logger.info('Expired lapsed exemptions', { count: expired.length });
  return expired.length;
}

/**
 * Warn each org about approved exemptions lapsing within `EXPIRY_WARN_DAYS`
 * that have not been warned yet. The stamp is written only after the org's
 * notice was ACCEPTED, so a message-service outage retries on the next tick.
 * Returns the number of exemptions warned.
 */
export async function warnExpiringExemptions(now: Date = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + EXPIRY_WARN_DAYS * DAY_MS);
  const due = await withTenantTx(async (tx) => tx
    .select({
      id: schema.complianceExemption.id,
      orgId: schema.complianceExemption.orgId,
      ruleId: schema.complianceExemption.ruleId,
      entityType: schema.complianceExemption.entityType,
      entityName: schema.complianceExemption.entityName,
      expiresAt: schema.complianceExemption.expiresAt,
    })
    .from(schema.complianceExemption)
    .where(and(
      eq(schema.complianceExemption.status, 'approved'),
      gt(schema.complianceExemption.expiresAt, now),
      lte(schema.complianceExemption.expiresAt, horizon),
      isNull(schema.complianceExemption.expiryWarnedAt),
    ))) as LapsingRow[];

  let warned = 0;
  for (const [orgId, rows] of groupByOrg(due)) {
    const result = await inAppChannel.deliver({
      recipientOrgId: orgId,
      messageType: 'conversation',
      priority: 'high',
      subject: `${rows.length} compliance exemption${rows.length === 1 ? '' : 's'} expire${rows.length === 1 ? 's' : ''} soon`,
      body: `These exemptions lapse within ${EXPIRY_WARN_DAYS} days. Once one does, the rule it waives applies again and `
        + 'can block the entity. Fix the entity before then, or request a new exemption once it has lapsed '
        + '(one still in force cannot be re-requested).\n\n'
        + rows.map(describeRow).join('\n'),
      payload: { event: 'compliance.exemption.expiring', orgId, ids: rows.map((r) => r.id) },
    }, {});
    if (!result.ok) {
      logger.warn('Exemption expiry warning not delivered; will retry next sweep', { orgId, count: rows.length, error: result.error });
      continue;
    }
    for (const r of rows) {
      await withTenantTx(async (tx) => tx
        .update(schema.complianceExemption)
        .set({ expiryWarnedAt: now })
        .where(eq(schema.complianceExemption.id, r.id)));
    }
    warned += rows.length;
  }
  return warned;
}

/** Start the daily leader-locked expiry sweep (expire, then warn). */
export function startExemptionExpiryScheduler(opts: { intervalMs?: number; startupDelayMs?: number } = {}): Scheduler {
  const scheduler = createScheduler({
    name: 'compliance-exemption-expiry',
    intervalMs: opts.intervalMs ?? SWEEP_INTERVAL_MS,
    startupDelayMs: opts.startupDelayMs ?? 90_000,
    lock: { key: leaderLockKey('compliance', 'exemption-expiry'), ttlMs: DEFAULT_LEADER_LOCK_TTL_MS },
    run: async () => {
      await runWithTenantContext({ isSuperAdmin: true }, async () => {
        const now = new Date();
        await expireLapsedExemptions(now);
        await warnExpiringExemptions(now);
      });
    },
  });
  scheduler.start();
  return scheduler;
}
