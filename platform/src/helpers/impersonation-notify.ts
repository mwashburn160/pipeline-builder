// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Telling a team that its parent viewed one of its members.
 *
 * Under the ancestor path nobody is ASKED — a parent already administers its
 * teams — but the team is still INFORMED. No challenge is not the same as no
 * notice, and the notification costs nothing while keeping the relationship
 * honest.
 *
 * Fire-and-forget: this must never block or fail the session it describes. That
 * is the right trade HERE precisely because the message is not load-bearing —
 * nobody is waiting on it to decide anything. A consent CHALLENGE cannot reuse
 * this contract, because there a dropped message becomes a silent expiry that
 * reads as a refusal.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { sendInAppNotification, sendInAppNotificationConfirmed } from './in-app-notify.js';
import { toOrgId } from './org-id.js';
import { describeDuration, IMPERSONATION_REQUEST_TTL_MS } from '../constants/impersonation.js';
import { Organization, User, UserOrganization } from '../models/index.js';

const logger = createLogger('impersonation-notify');

/**
 * Notify the admins of `orgId` that `requesterId` opened a read-only session as
 * one of their members. Never throws.
 */
export async function notifyTeamOfAncestorImpersonation(input: {
  orgId: string;
  requesterId: string;
  targetUserId: string;
}): Promise<void> {
  try {
    const [org, requester, target, admins] = await Promise.all([
      Organization.findById(toOrgId(input.orgId)).select('name').lean(),
      User.findById(input.requesterId).select('username email').lean(),
      User.findById(input.targetUserId).select('username email').lean(),
      UserOrganization.find({
        organizationId: input.orgId,
        isActive: true,
        role: { $in: ['owner', 'admin'] },
      }).select('userId').lean(),
    ]);
    if (!org || admins.length === 0) return;

    const who = (u: unknown) =>
      (u as { username?: string; email?: string } | null)?.username
      ?? (u as { email?: string } | null)?.email
      ?? 'a user';

    // One message per admin: the in-app route targets a single recipient, and
    // "first to see it" is not a thing here — every admin is being informed,
    // not racing to decide.
    await Promise.all(
      admins.map((a) =>
        sendInAppNotification({
          recipientOrgId: input.orgId,
          recipientUserId: String((a as { userId: unknown }).userId),
          subject: `Parent-organization access to ${(org as { name: string }).name}`,
          content:
            `${who(requester)} opened a read-only session as ${who(target)}. `
            + 'Parent-organization admins can view their teams\' members without a '
            + 'separate approval; the session is read-only and cannot change anything. '
            + 'It appears in this organization\'s audit log.',
        }),
      ),
    );
  } catch (err) {
    // Informational only — never let it affect the session it describes.
    logger.warn('Ancestor-impersonation notice failed (non-blocking)', {
      orgId: input.orgId, error: String(err),
    });
  }
}

/**
 * LOUDLY tell an org's admins that emergency access was taken over its policy.
 *
 * Returns how many admins were actually reached, so the audit event can record
 * it. This does NOT gate the access: blocking an emergency on a notification
 * failure would defeat the point of emergency access. But a silent failure must
 * be visible afterwards — otherwise break-glass quietly becomes the unobserved
 * bypass it is designed not to be.
 */
export async function notifyOrgOfBreakglass(input: {
  orgId: string;
  requesterId: string;
  targetUserId: string;
  justification: string;
  recentCount: number;
  awaitingSecondSysadmin: boolean;
}): Promise<{ attempted: number; delivered: number }> {
  try {
    const [org, requester, target, admins] = await Promise.all([
      Organization.findById(toOrgId(input.orgId)).select('name').lean(),
      User.findById(input.requesterId).select('username email').lean(),
      User.findById(input.targetUserId).select('username email').lean(),
      UserOrganization.find({
        organizationId: input.orgId, isActive: true, role: { $in: ['owner', 'admin'] },
      }).select('userId').lean(),
    ]);
    if (!org || admins.length === 0) return { attempted: 0, delivered: 0 };

    const who = (u: unknown) =>
      (u as { username?: string } | null)?.username
      ?? (u as { email?: string } | null)?.email
      ?? 'a user';

    const content =
      `EMERGENCY ACCESS: ${who(requester)} ${input.awaitingSecondSysadmin ? 'has requested' : 'has taken'} `
      + `emergency read-only access to ${who(target)}'s account, bypassing this organization's `
      + 'impersonation policy.\n\n'
      + `Justification given: "${input.justification}"\n\n`
      + (input.awaitingSecondSysadmin
        ? 'This requires approval from a second platform administrator before it takes effect.\n\n'
        : '')
      + `This operator has used emergency access ${input.recentCount + 1} time(s) in the last 30 days. `
      + 'The session is view-only, and appears in this organization\'s audit log. '
      + 'An organization admin can end it at any time: /dashboard/access-requests';

    const outcomes = await Promise.all(admins.map((a) =>
      sendInAppNotificationConfirmed({
        recipientOrgId: input.orgId,
        recipientUserId: String((a as { userId: unknown }).userId),
        subject: `Emergency access to ${(org as { name: string }).name}`,
        content,
      })));
    return { attempted: admins.length, delivered: outcomes.filter(Boolean).length };
  } catch (err) {
    logger.warn('Break-glass notice failed', { orgId: input.orgId, error: String(err) });
    return { attempted: 0, delivered: 0 };
  }
}

/**
 * Tell the person who asked for access that their request was decided.
 *
 * Fire-and-forget, deliberately — unlike the challenge. The decision is already
 * recorded and shows on the requester's Access requests page either way, so a
 * lost notice delays them rather than losing anything. (A lost CHALLENGE is
 * different: nobody would ever be asked.) Without this, a requester would have to
 * keep checking back to learn they'd been approved — and an approval unopened
 * within the hour lapses.
 */
export async function notifyRequesterOfDecision(input: {
  requesterId: string;
  targetUserId: string;
  deciderId: string;
  approved: boolean;
  breakglass: boolean;
}): Promise<void> {
  try {
    const [requester, target, decider] = await Promise.all([
      User.findById(input.requesterId).select('username email lastActiveOrgId').lean(),
      User.findById(input.targetUserId).select('username email').lean(),
      User.findById(input.deciderId).select('username email').lean(),
    ]);
    // The requester's inbox lives under their own active org.
    const recipientOrgId = (requester as { lastActiveOrgId?: unknown } | null)?.lastActiveOrgId;
    if (!requester || recipientOrgId == null) return;

    const who = (u: unknown) =>
      (u as { username?: string } | null)?.username
      ?? (u as { email?: string } | null)?.email
      ?? 'someone';
    const what = input.breakglass ? 'emergency access to' : 'your request to view';
    const account = `${who(target)}'s account`;

    const subject = input.approved
      ? (input.breakglass ? 'Emergency access approved' : 'Access request approved')
      : (input.breakglass ? 'Emergency access denied' : 'Access request denied');
    const content = input.approved
      ? `${who(decider)} approved ${what} ${account}. Open it from /dashboard/access-requests `
        + `within ${describeDuration(IMPERSONATION_REQUEST_TTL_MS)}, or the approval lapses.`
      : `${who(decider)} denied ${what} ${account}.`;

    await sendInAppNotification({
      recipientOrgId: String(recipientOrgId),
      recipientUserId: input.requesterId,
      subject,
      content,
    });
  } catch (err) {
    logger.warn('Decision notice failed (non-blocking)', { requesterId: input.requesterId, error: String(err) });
  }
}
