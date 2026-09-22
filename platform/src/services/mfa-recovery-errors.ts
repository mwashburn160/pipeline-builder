// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Two-person MFA reset error codes, thrown by services/mfa-recovery.ts, and
 * {@link MFA_RESET_ERROR_MAP} mapping them to HTTP status. Dependency-free on
 * purpose (see `org-errors.ts`).
 */

import type { ErrorMap } from '../helpers/controller-helper.js';

export const MFA_RESET_NOT_FOUND = 'MFA_RESET_NOT_FOUND';
export const MFA_RESET_NOT_MEMBER = 'MFA_RESET_NOT_MEMBER';
export const MFA_RESET_SELF = 'MFA_RESET_SELF';
export const MFA_RESET_PLATFORM_ADMIN = 'MFA_RESET_PLATFORM_ADMIN';
export const MFA_RESET_ALREADY_PENDING = 'MFA_RESET_ALREADY_PENDING';
export const MFA_RESET_NOT_PENDING = 'MFA_RESET_NOT_PENDING';
export const MFA_RESET_EXPIRED = 'MFA_RESET_EXPIRED';
export const MFA_RESET_SECOND_PERSON_REQUIRED = 'MFA_RESET_SECOND_PERSON_REQUIRED';

export const MFA_RESET_ERROR_MAP: ErrorMap = {
  [MFA_RESET_NOT_FOUND]: { status: 404, message: 'MFA reset request not found', code: MFA_RESET_NOT_FOUND },
  [MFA_RESET_NOT_MEMBER]: { status: 404, message: 'That person is not an active member of this organization', code: MFA_RESET_NOT_MEMBER },
  [MFA_RESET_SELF]: {
    status: 409,
    message: 'You can\'t reset your own two-factor authentication — use a recovery code, or ask another admin.',
    code: MFA_RESET_SELF,
  },
  [MFA_RESET_PLATFORM_ADMIN]: {
    status: 403,
    message: 'A platform administrator\'s factors can only be reset by the platform operators.',
    code: MFA_RESET_PLATFORM_ADMIN,
  },
  [MFA_RESET_ALREADY_PENDING]: {
    status: 409,
    message: 'A reset for this person is already waiting for approval.',
    code: MFA_RESET_ALREADY_PENDING,
  },
  [MFA_RESET_NOT_PENDING]: { status: 409, message: 'This request has already been decided.', code: MFA_RESET_NOT_PENDING },
  [MFA_RESET_EXPIRED]: { status: 410, message: 'This request expired before it was approved. File a new one.', code: MFA_RESET_EXPIRED },
  [MFA_RESET_SECOND_PERSON_REQUIRED]: {
    status: 403,
    message: 'A reset must be approved by a different admin than the one who requested it (and never by the person being reset).',
    code: MFA_RESET_SECOND_PERSON_REQUIRED,
  },
};

