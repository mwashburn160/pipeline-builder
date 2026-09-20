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
 */

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
