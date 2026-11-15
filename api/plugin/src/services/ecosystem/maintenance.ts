// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ecosystem's background upkeep (docs/runbooks/ecosystem-moderation.md),
 * one leader-locked scheduler:
 *
 * - PLAN EFFECTS: a Verified publisher whose org drops below Team (no
 * `verified_publisher`) gets a 30-day grace period (reminders at 14 and 3
 * days); when it lapses the tier returns to Community
 *    (`publisher.tier.change`, `reason: plan_downgrade`) and every image is
 * re-signed. A publisher over its `listings` limit is told once; its
 *    listings stay listed and the request routes refuse non-security updates.
 *  - the RE-SIGN job queue (resign.ts);
 * - MODERATION SLA-BREACH notices (sla.ts), each request announced once;
 * - the ADVISORY FAN-OUT retry (advisories.ts): an advisory published in the
 * last day whose fan-out didn't reach every installing org (an outage
 *    mid-send) is finished here — every 15 minutes, which with the immediate
 * send keeps delivery inside a 15-minute target;
 * - ANONYMOUS SUBMISSIONS: undecided submissions past their 30 days expire
 * (artifacts deleted), and submitter emails are purged 90 days after the
 * decision;
 *  - the SEARCH-MISS retention sweep (search-misses.ts);
 * - PUBLIC IMAGE collection (image-gc.ts): long-yanked, unreferenced
 * `public/*` digests are deleted from the registry;
 * - STALLED PUBLISHES (stalled.ts): a submission left in `publishing`, or a
 * request left `approved` but never executed, by a pod that died mid-way is
 * handed back for a moderator.
 *
 * FAILURES ARE VISIBLE: each failed step counts
 * `ecosystem_maintenance_step_failed_total{step}` (alerted as
 * EcosystemMaintenanceStepFailing — the email purge is a privacy retention
 * promise, so a silent failure there is a broken promise), and a pass in which
 * EVERY step failed throws, so the scheduler records no success and
 * SchedulerJobStale fires.
 */

import {
  createLogger,
  createScheduler,
  errorMessage,
  SYSTEM_ACTOR_ID,
  SYSTEM_ORG_ID,
  type LockRedis,
  type Scheduler, leaderLockKey, DEFAULT_LEADER_LOCK_TTL_MS,
} from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import type { Publisher } from '@pipeline-builder/pipeline-data';

import { retryAdvisoryFanOut } from './advisories.js';
import { ecosystemAudit } from './audit.js';
import { collectYankedPublicImages } from './image-gc.js';
import { notifyPlanEffect } from './notify.js';
import { listingsQuota } from './publishers.js';
import { enqueueResign, runResignJobs, signedAs } from './resign.js';
import { sweepSearchMisses } from './search-misses.js';
import { notifySlaBreaches } from './sla.js';
import { recoverStalledPublishes } from './stalled.js';
import { atomically, publishers, settings } from './store.js';
import { expireSubmissions, purgeSubmitterEmails } from './submissions.js';
import { DAY_MS } from './util.js';
import { planIncludesVerified } from './verified-eligibility.js';

const logger = createLogger('ecosystem-maintenance');

/** The Verified grace period after a downgrade below Team. */
export const VERIFIED_GRACE_DAYS = 30;
/** Grace reminders, in days left. */
export const GRACE_REMINDER_DAYS = [14, 3] as const;

/** Counter: a maintenance step that failed, by `step` (alerted). */
export const MAINTENANCE_STEP_FAILED_COUNTER = 'ecosystem_maintenance_step_failed_total';

const reminderKey = (id: string) => `grace-reminders:${id}`;
const overLimitKey = (id: string) => `over-listings-limit:${id}`;

/**
 * Whether the org's plan makes it eligible for Verified. Reads the tier FAIL
 * CLOSED: an unreadable tier throws, so the pass skips this publisher —
 * it never starts (or ends) a grace period on the fallback DEFAULT_TIER an
 * outage would otherwise report.
 */
async function verifiedEligibleOrg(orgId: string): Promise<boolean> {
  const eligible = await planIncludesVerified(orgId);
  if (eligible === null) throw new Error(`The plan tier of ${orgId} could not be read; skipping its Verified upkeep this pass`);
  return eligible;
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
    await atomically(async () => {
      await publishers.update(p.id, { tier: 'community', verifiedAt: null, verifiedGraceUntil: null });
      await settings.remove(reminderKey(p.id));
      // Lookup keeps accepting the Verified signature until every image is re-signed.
      await enqueueResign('publisher', p.id, 'plan_downgrade', SYSTEM_ACTOR_ID, signedAs(p));
    });
    ecosystemAudit({
      action: 'publisher.tier.change',
      actor: SYSTEM_ACTOR_ID,
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
export async function checkListingsLimit(p: Publisher): Promise<'ok' | 'over' | 'already_over' | 'back_under' | 'skipped'> {
  const orgId = p.ownerOrgId!;
  const quota = await listingsQuota(orgId, p.id);
  // An unreadable quota (the service's fail-open sentinel) is not "unlimited":
  // neither flag nor clear anything on it.
  if (quota.failOpen) return 'skipped';
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

/** One maintenance pass over every tenant publisher, then the re-sign queue, the SLA-breach notices, the advisory fan-out retry, submission upkeep, the search-miss sweep and public-image collection. */
export async function runEcosystemMaintenance(now: Date = new Date(), signal?: AbortSignal): Promise<{
  publishers: number;
  failures: number;
  resigned: number;
  slaBreachesNotified: number;
  advisoryOrgsNotified: number;
  submissionsExpired: number;
  submitterEmailsPurged: number;
  /** Search-miss rows pruned past retention or folded into their group. */
  searchMissesPruned: number;
  /** Long-yanked, unreferenced public images deleted from the registry. */
  publicImagesCollected: number;
  /** Abandoned mid-publish submissions handed back. */
  stalledSubmissionsRecovered: number;
}> {
  let failures = 0;
  const tenants = (await publishers.list()).filter((p) => p.ownerOrgId && p.ownerOrgId !== SYSTEM_ORG_ID && !p.suspendedAt);
  for (const p of tenants) {
    // The leader lock was lost (another replica took over): stop at once.
    if (signal?.aborted) break;
    try {
      if (p.tier === 'verified') await checkVerifiedGrace(p, now);
      await checkListingsLimit(p);
    } catch (err) {
      failures++;
      incCounter(MAINTENANCE_STEP_FAILED_COUNTER, { step: 'publisher_upkeep' });
      logger.warn('Publisher upkeep failed', { publisher: p.handle, error: errorMessage(err) });
    }
  }

  /**
   * Run one step unless the lease was lost. A step's failure (a database blip,
   * a registry outage) is counted and logged, never allowed to skip the others.
   */
  let steps = 0;
  let failedSteps = 0;
  const step = async (name: string, failed: string, fn: () => Promise<void>): Promise<void> => {
    if (signal?.aborted) return;
    steps++;
    try {
      await fn();
    } catch (err) {
      failures++;
      failedSteps++;
      incCounter(MAINTENANCE_STEP_FAILED_COUNTER, { step: name });
      logger.warn(failed, { step: name, error: errorMessage(err) });
    }
  };

  const out = {
    resigned: 0,
    slaBreachesNotified: 0,
    advisoryOrgsNotified: 0,
    submissionsExpired: 0,
    submitterEmailsPurged: 0,
    searchMissesPruned: 0,
    publicImagesCollected: 0,
    stalledSubmissionsRecovered: 0,
  };
  await step('resign', 'Re-sign pass failed', async () => { out.resigned = (await runResignJobs(undefined, signal)).resigned; });
  await step('sla_breach', 'SLA-breach check failed', async () => { out.slaBreachesNotified = await notifySlaBreaches(now); });
  await step('advisory_fanout', 'Advisory fan-out retry failed', async () => { out.advisoryOrgsNotified = await retryAdvisoryFanOut(now); });
  // Two steps, not one: the email purge is a privacy retention promise and
  // must neither be skipped by an expiry failure nor hide behind one.
  await step('submission_expiry', 'Submission expiry failed', async () => { out.submissionsExpired = await expireSubmissions(now); });
  await step('submitter_email_purge', 'Submitter email purge failed', async () => { out.submitterEmailsPurged = await purgeSubmitterEmails(now); });
  await step('stalled_publishes', 'Stalled-publish recovery failed', async () => {
    out.stalledSubmissionsRecovered = (await recoverStalledPublishes(now)).submissions;
  });
  await step('search_miss_sweep', 'Search-miss retention sweep failed', async () => {
    const swept = await sweepSearchMisses(now);
    out.searchMissesPruned = swept.pruned + swept.folded;
  });
  await step('public_image_gc', 'Public image collection failed', async () => { out.publicImagesCollected = await collectYankedPublicImages(now, signal); });
  const result = { publishers: tenants.length, failures, ...out };
  logger.info('Ecosystem maintenance pass complete', result);
  // Every step failed: the database (or the whole dependency set) is down. A
  // throw keeps the scheduler from stamping a success.
  if (steps > 0 && failedSteps === steps) {
    throw new Error(`Ecosystem maintenance: every step failed (${failedSteps})`);
  }
  return result;
}

/** Build (not start) the scheduler: every 15 minutes, leader-locked on the shared Redis. */
export function createEcosystemMaintenanceScheduler(redis: () => LockRedis): Scheduler {
  return createScheduler({
    name: 'ecosystem-maintenance',
    intervalMs: 15 * 60_000,
    startupDelayMs: 60_000,
    lock: { redis, key: leaderLockKey('plugin', 'ecosystem-maintenance'), ttlMs: DEFAULT_LEADER_LOCK_TTL_MS },
    // The lock hands the run an abort signal that fires when the lease is
    // lost; every step stops at the next checkpoint instead of racing the new leader.
    run: async (lease?: { signal?: AbortSignal }) => { await runEcosystemMaintenance(new Date(), lease?.signal); },
  });
}
