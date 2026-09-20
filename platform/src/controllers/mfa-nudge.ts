// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The own-account half of the password-only prompt (see `helpers/mfa-nudge.ts`
 * for why there is no "enable MFA" flag anywhere near it).
 *
 *   POST   /user/mfa-prompt/snooze   — "Not now", for SNOOZE_DAYS days
 *   POST   /user/mfa-prompt/decline  — "Don't ask again"
 *   DELETE /user/mfa-prompt          — "Ask me again" (undoes either)
 *
 * All three act on the CALLER's own account and take no body: the deadline is
 * computed server-side so a client cannot post itself a ten-year snooze. None
 * is step-up gated and none needs a permission, because none of them changes
 * what the session can do — hiding a banner is not a weakening, and demanding a
 * second factor in order to postpone being asked for a second factor would be a
 * joke at the expense of the person we are trying to help.
 *
 * The current state is NOT read here: `GET /user/profile` already reports it
 * alongside `authFactors`, which is the only place it is meaningful (the prompt
 * exists only for an account with no factor). That also keeps it readable from
 * a bootstrap-admin enrolment session, which may call `/user/profile` and
 * almost nothing else.
 */

import { sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { requireAuthUserId, withController } from '../helpers/controller-helper.js';
import { clearMfaNudge, declineMfaNudge, snoozeMfaNudge, SNOOZE_DAYS } from '../helpers/mfa-nudge.js';

/** POST /user/mfa-prompt/snooze — hide the prompt for SNOOZE_DAYS days. */
export const snoozeMfaPrompt = withController('Snooze the two-factor prompt', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const snoozedUntil = await snoozeMfaNudge(userId);
  // Deliberately NOT audited. A snooze is a recurring, reversible UI preference
  // — at one row a week per password-only account it would bury the decline
  // below, which is the event that actually says something about the account.
  sendSuccess(res, 200, { snoozedUntil: snoozedUntil.toISOString(), snoozeDays: SNOOZE_DAYS });
});

/** POST /user/mfa-prompt/decline — stop prompting until the person asks again. */
export const declineMfaPrompt = withController('Decline the two-factor prompt', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const declinedAt = await declineMfaNudge(userId);
  // Audited, unlike the snooze: this is a durable decision to stay on one
  // factor, and the org's admins can see the COUNT of people who made it — the
  // trail is how anyone finds out who, on the surface that already gates that.
  audit(req, 'user.mfa.prompt_declined', { targetType: 'user', targetId: userId });
  sendSuccess(res, 200, { declinedAt: declinedAt.toISOString() });
});

/** DELETE /user/mfa-prompt — be prompted normally again. */
export const resetMfaPrompt = withController('Restore the two-factor prompt', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  await clearMfaNudge(userId);
  // Audited for the same reason as the decline, and because a reviewer reading
  // "declined" needs to be able to see that it was later withdrawn.
  audit(req, 'user.mfa.prompt_restored', { targetType: 'user', targetId: userId });
  sendSuccess(res, 200, { cleared: true });
});
