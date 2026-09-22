// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * TOTP (authenticator-app) error codes.
 *
 * Thrown by `services/totp-service.ts` and mapped to HTTP status in
 * `controllers/totp.ts`, plus the recovery-code set's own refusal (the codes
 * back up whichever second factor the account holds). Dependency-free on purpose (see `webauthn-errors.ts`):
 * controllers and tests import the codes without loading the service or its
 * models.
 */

import type { ErrorMap } from '../helpers/controller-helper.js';

/** No enrolment at all, or one that was never confirmed, where an active one is
 *  required (verify a code, disable, regenerate recovery codes). → 409 */
export const TOTP_NOT_ENROLLED = 'TOTP_NOT_ENROLLED';
/** An enrolment already exists and is active — re-enrolling would silently
 *  invalidate the authenticator the person is still using. → 409 */
export const TOTP_ALREADY_ENROLLED = 'TOTP_ALREADY_ENROLLED';
/** The code (or recovery code) did not verify: wrong, expired, outside the
 *  ±1-step drift window, or a step already spent. ONE code for all of them —
 *  telling them apart tells an attacker which guess was close. → 401 */
export const TOTP_INVALID_CODE = 'TOTP_INVALID_CODE';
/** Too many consecutive failures; verification is refused until the lockout
 *  passes, whatever the next code is. → 429 */
export const TOTP_LOCKED_OUT = 'TOTP_LOCKED_OUT';
/** Removing TOTP would leave the account with no way to sign in at all (no
 *  password, no linked provider, no passkey). → 409 */
export const TOTP_LAST_SIGN_IN_METHOD = 'TOTP_LAST_SIGN_IN_METHOD';
/** The account's email domain is governed by an org that enforces SSO, so the
 *  identity provider owns its factors — enrolling one here would be a second,
 *  unmanaged MFA the org's admins can neither see nor revoke. → 403 */
export const TOTP_SSO_ENFORCED = 'TOTP_SSO_ENFORCED';
/** The sign-in MFA challenge is unknown, expired or already spent. → 401 */
export const TOTP_INVALID_CHALLENGE = 'TOTP_INVALID_CHALLENGE';

/** `POST /auth/recovery-codes` on an account that has no second factor. */
export const RECOVERY_CODES_NO_FACTOR = 'RECOVERY_CODES_NO_FACTOR';

export const RECOVERY_CODES_ERROR_MAP: ErrorMap = {
  [RECOVERY_CODES_NO_FACTOR]: {
    status: 409,
    message: 'Recovery codes back up a second factor — add a passkey or an authenticator app first.',
    code: RECOVERY_CODES_NO_FACTOR,
  },
};

