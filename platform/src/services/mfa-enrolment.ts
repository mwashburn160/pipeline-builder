// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What enrolling a second factor ends.
 *
 * An approved MFA reset (`services/mfa-recovery.ts`) grants the person a
 * per-user ENROLMENT GRACE so they can sign in with a password and enrol a new
 * factor while their org requires MFA. The grace exists for exactly that, so it
 * ends the moment they have done it: from then on the org's policy applies to
 * them like everyone else, and their next sign-in must present the new factor.
 *
 * The PASSWORD-ONLY PROMPT's suppression ends here too, and for the same shape
 * of reason: it was a decision about an account with no factor, and there now
 * is one. Both live in this one module so that "what an enrolment ends" is a
 * list a reader can finish, rather than a set of calls scattered down the two
 * enrolment controllers.
 */

import { clearMfaNudge } from '../helpers/mfa-nudge.js';
import { User } from '../models/index.js';

/** Clear `mfaResetGraceUntil` after a factor was enrolled. Returns whether a
 *  grace was running. */
export async function clearResetGraceOnEnrolment(userId: string): Promise<boolean> {
  const result = await User.updateOne(
    { _id: userId, mfaResetGraceUntil: { $exists: true } },
    { $unset: { mfaResetGraceUntil: '' } },
  );
  return (result.modifiedCount ?? 0) > 0;
}

/**
 * Forget any "not now" / "don't ask again" the person gave the password-only
 * prompt, now that they have a factor.
 *
 * CLEARED rather than left to expire: if they later remove this factor they
 * should be asked again, not silenced by a decline they made before they had
 * one. See `helpers/mfa-nudge.ts`.
 */
export async function clearMfaNudgeOnEnrolment(userId: string): Promise<void> {
  await clearMfaNudge(userId);
}
