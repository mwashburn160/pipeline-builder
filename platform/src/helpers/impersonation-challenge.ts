// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sending an impersonation CHALLENGE — asking someone to approve a session.
 *
 * Not yet reached: sessions still auto-approve until the consent policy is
 * switched on. Built now so that switch is the only thing left to land.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { sendInAppNotificationConfirmed } from './in-app-notify.js';
import type { ImpersonationApproverMode } from '../models/index.js';
import { User, UserOrganization } from '../models/index.js';

const logger = createLogger('impersonation-challenge');

/**
 * Where a person acts on a request. Without this the challenge is plain text with
 * nothing to click — the recipient learns someone wants in and has no way to answer.
 */
export const ACCESS_REQUESTS_PATH = '/dashboard/access-requests';

/** The org forbids the impersonated user from approving their own session. */
export const CHALLENGE_SELF_APPROVAL_FORBIDDEN = 'IMPERSONATION_SELF_APPROVAL_FORBIDDEN';
/** No pinned org, so there are no admins to ask. */
export const CHALLENGE_NO_ORG = 'IMPERSONATION_CHALLENGE_NO_ORG';

/**
 * Decide where a challenge may go.
 *
 * When an org forbids self-approval, a `user`-routed request is REFUSED — it is
 * not quietly rerouted to the admins. The requester chose a recipient
 * deliberately; widening that silently would send an access request to people
 * who never expected it and hide from the requester that their choice was
 * overridden. They can re-request with `org_admin` explicitly.
 */
export function resolveChallengeRoute(
  requested: ImpersonationApproverMode | undefined,
  allowSelfApproval: boolean,
): { ok: true; mode: ImpersonationApproverMode } | { ok: false; code: string } {
  const mode = requested ?? 'user';
  if (mode === 'user' && !allowSelfApproval) return { ok: false, code: CHALLENGE_SELF_APPROVAL_FORBIDDEN };
  return { ok: true, mode };
}

export interface ChallengeDelivery {
  /** How many recipients the challenge was addressed to. */
  attempted: number;
  /** How many actually received it. Zero means nobody can answer. */
  delivered: number;
}

/**
 * Send the challenge and report how many recipients actually received it.
 *
 * The caller MUST treat `delivered === 0` as undeliverable rather than leaving
 * the request `pending`. Delivery is in-app only, so a failed message has no
 * fallback — and a pending request nobody can see would sit for an hour and
 * then expire, reading to the operator exactly like a refusal.
 */
export async function sendImpersonationChallenge(input: {
  mode: ImpersonationApproverMode;
  orgId: string;
  targetUserId: string;
  requesterId: string;
  reason?: string;
}): Promise<ChallengeDelivery> {
  const recipients = input.mode === 'user'
    ? [input.targetUserId]
    : (await UserOrganization.find({
      organizationId: input.orgId,
      isActive: true,
      role: { $in: ['owner', 'admin'] },
    }).select('userId').lean()).map((a) => String((a as { userId: unknown }).userId));

  if (recipients.length === 0) return { attempted: 0, delivered: 0 };

  const requester = await User.findById(input.requesterId).select('username email').lean();
  const requesterName = (requester as { username?: string; email?: string } | null)?.username
    ?? (requester as { email?: string } | null)?.email
    ?? 'A platform operator';

  // Everything the reader needs to make a real decision: who, why, what they
  // would see, that it is read-only, for how long, and that it can be stopped.
  // A dialog without these is a "click yes" box, which manufactures the
  // appearance of consent while delivering none.
  const subject = input.mode === 'user'
    ? 'Request to view your account'
    : 'Request to view a member\'s account';
  const reasonLine = input.reason ? `Reason given: "${input.reason}"\n\n` : 'No reason was given.\n\n';
  const content =
    `${requesterName} is asking to view ${input.mode === 'user' ? 'your account' : 'a member\'s account'} `
    + 'in this organization.\n\n'
    + reasonLine
    + 'If approved, they will see what that account sees, for 15 minutes. It is view-only: '
    + 'no changes can be made. You can end the session at any time. '
    + 'The request expires in 1 hour if nobody responds.\n\n'
    + `Approve or deny it: ${ACCESS_REQUESTS_PATH}`;

  const outcomes = await Promise.all(
    recipients.map((recipientUserId) =>
      sendInAppNotificationConfirmed({ recipientOrgId: input.orgId, recipientUserId, subject, content }),
    ),
  );
  const delivered = outcomes.filter(Boolean).length;

  if (delivered === 0) {
    logger.warn('Impersonation challenge reached nobody', {
      orgId: input.orgId, mode: input.mode, attempted: recipients.length,
    });
  }
  return { attempted: recipients.length, delivered };
}
