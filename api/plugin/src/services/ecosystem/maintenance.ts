// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ecosystem's background upkeep (docs/plans/plugin-ecosystem.md §3.3, §3.7),
 * one leader-locked scheduler:
 *
 *  - PLAN EFFECTS (§3.7 "Downgrade"): a Verified publisher whose org drops below
 *    Team (no `verified_publisher`) gets a 30-day grace period (N29, reminders
 *    at 14 and 3 days); when it lapses the tier returns to Community
 *    (`publisher.tier.change`, `reason: plan_downgrade`) and every image is
 *    re-signed. A publisher over its `listings` limit is told once (N29); its
 *    listings stay listed and the request routes refuse non-security updates.
 *  - the RE-SIGN job queue (resign.ts);
 *  - N22 MODERATION SLA-BREACH notices (sla.ts), each request announced once;
 *  - the N21 ADVISORY FAN-OUT retry (advisories.ts): an advisory published in
 *    the last day whose fan-out didn't reach every installing org (an outage
 *    mid-send) is finished here — every 15 minutes, which with the immediate
 *    send keeps delivery inside the 15-minute target (§10);
 *  - ANONYMOUS SUBMISSIONS (§4, E4): undecided submissions past their 30 days
 *    expire (artifacts deleted), and submitter emails are purged 90 days after
 *    the decision.
 */

import {
  createLogger,
  createScheduler,
  errorMessage,
  getQuotaServiceAuthHeader,
  SYSTEM_ACTOR_ID,
  SYSTEM_ORG_ID,
  TIER_FEATURES,
  type LockRedis,
  type Scheduler,
} from '@pipeline-builder/api-core';
import type { Publisher } from '@pipeline-builder/pipeline-data';

import { retryAdvisoryFanOut } from './advisories.js';
import { ecosystemDeps } from './context.js';
import { notifyPlanEffect } from './notify.js';
import { listingsQuota } from './publishers.js';
import { enqueueResign, runResignJobs } from './resign.js';
import { notifySlaBreaches } from './sla.js';
import { publishers, settings } from './store.js';
import { expireSubmissions, purgeSubmitterEmails } from './submissions.js';
import { emitPluginAudit } from '../audit.js';

const logger = createLogger('ecosystem-maintenance');

const DAY_MS = 24 * 3_600_000;
/** The Verified grace period after a downgrade below Team (§3.7). */
export const VERIFIED_GRACE_DAYS = 30;
/** Grace reminders, in days left (N29). */
export const GRACE_REMINDER_DAYS = [14, 3] as const;

const reminderKey = (id: string) => `grace-reminders:${id}`;
const overLimitKey = (id: string) => `over-listings-limit:${id}`;

/** Whether the org's plan makes it eligible for Verified. */
async function verifiedEligibleOrg(orgId: string): Promise<boolean> {
  const tier = await ecosystemDeps().quotaService.getTier(orgId, getQuotaServiceAuthHeader(orgId));
  return (TIER_FEATURES[tier] ?? []).includes('verified_publisher');
}

/** One Verified publisher's grace bookkeeping. Returns what happened (for tests/logs). */
export async function checkVerifiedGrace(p: Publisher, now: Date = new Date()): Promise<'eligible' | 'grace_started' | 'reminded' | 'downgraded' | 'in_grace' | 'restored'> {
  const orgId = p.ownerOrgId!;
  if (await verifiedEligibleOrg(orgId)) {
    if (!p.verifiedGraceUntil) return 'eligible';
    await publishers.update(p.id, { verifiedGraceUntil: null });
    await settings.remove(reminderKey(p.id));
    await notifyPlanEffect({ publisherOrgId: orgId, subject: `Verified status kept: ${p.handle}`, text: `Your plan includes Verified publishing again, so ${p.handle} stays Verified.` });
    return 'restored';
  }
  if (!p.verifiedGraceUntil) {
    const until = new Date(now.getTime() + VERIFIED_GRACE_DAYS * DAY_MS);
    await publishers.update(p.id, { verifiedGraceUntil: until });
    await notifyPlanEffect({
      publisherOrgId: orgId,
      subject: `Verified grace period started: ${p.handle}`,
      text: `Your plan no longer includes Verified publishing. ${p.handle} keeps its Verified badge until ${until.toISOString().slice(0, 10)}; upgrade to Team or Enterprise to keep it.`,
    });
    return 'grace_started';
  }
  const left = new Date(p.verifiedGraceUntil).getTime() - now.getTime();
  if (left <= 0) {
    await publishers.update(p.id, { tier: 'community', verifiedAt: null, verifiedGraceUntil: null });
    await settings.remove(reminderKey(p.id));
    await enqueueResign('publisher', p.id, 'plan_downgrade', SYSTEM_ACTOR_ID);
    emitPluginAudit({
      action: 'publisher.tier.change',
      actorId: SYSTEM_ACTOR_ID,
      orgId: SYSTEM_ORG_ID,
      affectedOrgId: orgId,
      targetType: 'publisher',
      targetId: p.id,
      details: { from: 'verified', to: 'community', reason: 'plan_downgrade' },
    });
    await notifyPlanEffect({ publisherOrgId: orgId, subject: `Verified grace period ended: ${p.handle}`, text: `${p.handle} is now a Community publisher. Its listings stay listed.` });
    return 'downgraded';
  }
  const daysLeft = Math.ceil(left / DAY_MS);
  const sent = (await settings.get<number[]>(reminderKey(p.id))) ?? [];
  const due = GRACE_REMINDER_DAYS.find((d) => daysLeft <= d && !sent.includes(d));
  if (due === undefined) return 'in_grace';
  await settings.put(reminderKey(p.id), [...sent, due], SYSTEM_ACTOR_ID);
  await notifyPlanEffect({ publisherOrgId: orgId, subject: `Verified grace period: ${daysLeft} days left for ${p.handle}`, text: `${p.handle} loses its Verified badge in ${daysLeft} days unless the plan includes Verified publishing again.` });
  return 'reminded';
}

/** Tell a publisher (once per episode) that it is over its `listings` limit. */
export async function checkListingsLimit(p: Publisher): Promise<'ok' | 'over' | 'already_over' | 'back_under'> {
  const orgId = p.ownerOrgId!;
  const quota = await listingsQuota(orgId, p.id);
  const over = quota.limit !== -1 && quota.used > quota.limit;
  const flagged = (await settings.get<boolean>(overLimitKey(p.id))) === true;
  if (over && !flagged) {
    await settings.put(overLimitKey(p.id), true, SYSTEM_ACTOR_ID);
    await notifyPlanEffect({
      publisherOrgId: orgId,
      subject: `Over your listings limit: ${p.handle}`,
      text: `${p.handle} has ${quota.used} live listings and the plan allows ${quota.limit}. Every listing stays listed, but new versions and listing updates are paused until you are back under the limit (security fixes still go through).`,
    });
    return 'over';
  }
  if (!over && flagged) {
    await settings.remove(overLimitKey(p.id));
    return 'back_under';
  }
  return over ? 'already_over' : 'ok';
}

/** One maintenance pass over every tenant publisher, then the re-sign queue, the SLA-breach notices, the advisory fan-out retry and submission upkeep. */
export async function runEcosystemMaintenance(now: Date = new Date()): Promise<{
  publishers: number;
  failures: number;
  resigned: number;
  slaBreachesNotified: number;
  advisoryOrgsNotified: number;
  submissionsExpired: number;
  submitterEmailsPurged: number;
}> {
  let failures = 0;
  const tenants = (await publishers.list()).filter((p) => p.ownerOrgId && p.ownerOrgId !== SYSTEM_ORG_ID && !p.suspendedAt);
  for (const p of tenants) {
    try {
      if (p.tier === 'verified') await checkVerifiedGrace(p, now);
      await checkListingsLimit(p);
    } catch (err) {
      failures++;
      logger.warn('Publisher upkeep failed', { publisher: p.handle, error: errorMessage(err) });
    }
  }
  const resign = await runResignJobs();
  let slaBreachesNotified = 0;
  try {
    slaBreachesNotified = await notifySlaBreaches(now);
  } catch (err) {
    failures++;
    logger.warn('SLA-breach check failed', { error: errorMessage(err) });
  }
  let advisoryOrgsNotified = 0;
  try {
    advisoryOrgsNotified = await retryAdvisoryFanOut(now);
  } catch (err) {
    failures++;
    logger.warn('Advisory fan-out retry failed', { error: errorMessage(err) });
  }
  let submissionsExpired = 0;
  let submitterEmailsPurged = 0;
  try {
    submissionsExpired = await expireSubmissions(now);
    submitterEmailsPurged = await purgeSubmitterEmails(now);
  } catch (err) {
    failures++;
    logger.warn('Submission upkeep failed', { error: errorMessage(err) });
  }
  return { publishers: tenants.length, failures, resigned: resign.resigned, slaBreachesNotified, advisoryOrgsNotified, submissionsExpired, submitterEmailsPurged };
}

/** Build (not start) the scheduler: every 15 minutes, leader-locked on the shared Redis. */
export function createEcosystemMaintenanceScheduler(redis: () => LockRedis): Scheduler {
  return createScheduler({
    name: 'ecosystem-maintenance',
    intervalMs: 15 * 60_000,
    startupDelayMs: 60_000,
    lock: { redis, key: 'ecosystem-maintenance:leader', ttlMs: 30 * 60_000 },
    run: async () => { await runEcosystemMaintenance(); },
  });
}
