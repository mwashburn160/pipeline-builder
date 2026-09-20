// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "Your SCIM provisioning is degraded" notice (3b).
 *
 * The plan's post-downgrade rule has a quiet failure mode: an unentitled org's
 * SCIM endpoint keeps accepting deactivate and delete, so removals still land and
 * nothing looks broken — while every create and update is refused. From the IdP's
 * side that reads as a stream of 403s in a log nobody watches; from the admin's
 * side, new hires silently stop appearing. So the FIRST refusal tells the org's
 * owners and admins, in-app and by email.
 *
 * Throttled to once per day per org. A misconfigured IdP retries a failed create
 * every few minutes, and an inbox with 300 identical notices is the same as no
 * notice at all. The throttle is Redis-backed (`SET NX EX`), so replicas share
 * it; with no Redis configured it degrades to a per-process memory of the same
 * window — at worst one notice per replica per day, which is still not a storm.
 *
 * Fire-and-forget throughout: a notification failure must never change the SCIM
 * response the IdP sees.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { toOrgId } from './org-id.js';
import { Organization, User, UserOrganization } from '../models/index.js';

const logger = createLogger('scim-entitlement-notice');

/** One notice per org per day. */
const NOTICE_TTL_SECONDS = 24 * 60 * 60;

/** Fallback window when Redis isn't configured: orgId → epoch ms of last notice. */
const inProcess = new Map<string, number>();

/** Claim the once-a-day slot for `orgId`, or report that it is already taken. */
async function claimNoticeSlot(orgId: string): Promise<boolean> {
  try {
    const { getRedisClient } = await import('../utils/redis-client.js');
    const redis = await getRedisClient();
    if (redis) {
      const claimed = await redis.set(`scim:downgrade-notice:${orgId}`, '1', 'EX', NOTICE_TTL_SECONDS, 'NX');
      return claimed !== null;
    }
  } catch (err) {
    logger.debug('SCIM notice throttle: Redis unavailable, using the in-process window', { error: errorMessage(err) });
  }
  const last = inProcess.get(orgId) ?? 0;
  if (Date.now() - last < NOTICE_TTL_SECONDS * 1000) return false;
  inProcess.set(orgId, Date.now());
  return true;
}

/**
 * Tell an org's owners/admins that SCIM is refusing everything but removals
 * because the SSO entitlement lapsed. Never throws; returns whether a notice was
 * actually sent (false when the daily slot was already claimed).
 */
export async function notifyScimEntitlementLapsed(orgId: string): Promise<boolean> {
  try {
    if (!(await claimNoticeSlot(orgId))) return false;

    const [org, admins] = await Promise.all([
      Organization.findById(toOrgId(orgId)).select('name').lean(),
      UserOrganization.find({ organizationId: toOrgId(orgId), isActive: true, role: { $in: ['owner', 'admin'] } })
        .select('userId').lean(),
    ]);
    if (!org || admins.length === 0) return false;
    const orgName = (org as { name: string }).name;

    const subject = `SCIM provisioning is limited for ${orgName}`;
    const body = `Your identity provider called the SCIM API for ${orgName}, but ${orgName} no longer holds the `
      + 'SSO entitlement that SCIM is part of.\n\n'
      + 'Deactivating and deleting users still works, so anyone you remove in your directory still loses access here. '
      + 'Creating users, updating them and changing group membership are being refused.\n\n'
      + 'Restore the SSO entitlement (Team or Enterprise plan, or the SSO add-on) to resume full provisioning.';

    const users = await User.find({ _id: { $in: admins.map((a) => a.userId) } }).select('email').lean();
    const emails = users.map((u) => (u as { email: string }).email).filter(Boolean);

    const { emailService } = await import('../utils/email.js');
    const { sendInAppNotification } = await import('./in-app-notify.js');
    await Promise.all([
      emails.length > 0 ? emailService.send({ to: emails, subject, text: body }) : Promise.resolve(true),
      // Targeted per admin, not org-wide: this is an administrative warning, not
      // something every member needs in their inbox.
      ...admins.map((a) => sendInAppNotification({
        recipientOrgId: orgId,
        recipientUserId: String((a as { userId: unknown }).userId),
        subject,
        content: body,
      })),
    ]);
    logger.info('[SCIM] notified admins that the SSO entitlement lapsed', { orgId, admins: admins.length });
    return true;
  } catch (err) {
    logger.warn('[SCIM] entitlement-lapsed notification failed (best-effort)', { orgId, error: errorMessage(err) });
    return false;
  }
}
