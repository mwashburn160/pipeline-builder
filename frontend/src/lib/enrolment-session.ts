// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import api from '@/lib/api';
import { decodeJwt } from '@/lib/jwt';

/**
 * Is this the bootstrap administrator's ENROLMENT-LIMITED session?
 *
 * A fresh install's only admin has no second factor, so their password sign-in
 * yields an `aal: 1` session flagged `mfaEnrollmentPending`. Platform admits it
 * to enrolment, sign-out/refresh and the routes `init-platform.sh` calls, and
 * refuses everything else with 403 `MFA_ENROLLMENT_REQUIRED`
 * (`platform/src/helpers/bootstrap-admin.ts`).
 *
 * Read from the ACCESS TOKEN rather than the profile: the flag lives in the
 * claims, and the profile read is itself one of the calls that would be refused.
 *
 * Fails to `false` — an absent or malformed token is not an enrolment session,
 * and treating it as one would strand an ordinary user on the enrolment page.
 */
export function isEnrolmentPendingSession(): boolean {
  try {
    const token = api.getAccessToken();
    return !!token && decodeJwt(token)?.payload?.mfaEnrollmentPending === true;
  } catch {
    return false;
  }
}

/** Where such a session is sent, and the only page it can usefully render. */
export const ENROLMENT_PATHNAME = '/dashboard/security';
export const ENROLMENT_HREF = '/dashboard/security?tab=factors#passkeys';
