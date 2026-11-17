// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared `withController` error map for the two `/user/**` controllers —
 * `controllers/user-profile.ts` (profile + preferences) and
 * `controllers/user-credentials.ts` (sessions, tokens, access keys).
 *
 * It lives in helpers because a controller may never import another controller
 * (`test/controller-imports.test.ts`), and because the two halves must keep
 * answering a given domain error with the SAME status and message: these are
 * the responses clients already handle.
 */

import { MFA_POLICY_ERROR_MAP } from './mfa-policy.js';
import { SESSION_AUTH_MISSING, TOKEN_SCOPE_ESCALATION } from '../services/auth-errors.js';
import { ORG_SNAPSHOT_FAILED } from '../services/org-errors.js';
import { RL_LAST_PRIVILEGED_MEMBER } from '../services/roles-errors.js';
import {
  PROFILE_USER_NOT_FOUND,
  PROFILE_EMAIL_TAKEN,
  PROFILE_EMAIL_SSO_MANAGED,
  PROFILE_INVALID_CREDENTIALS,
  PROFILE_PAT_LIMIT,
  USER_OWNER_HAS_ORGS,
} from '../services/user-errors.js';

export const userErrorMap = {
  [TOKEN_SCOPE_ESCALATION]: { status: 403, message: 'A scoped token can only mint credentials with the same scope' },
  // Fail closed: a caller whose token carries no assurance claims can't have
  // them inherited by anything it mints.
  [SESSION_AUTH_MISSING]: { status: 401, message: 'Session cannot mint credentials — please sign in again' },
  [PROFILE_USER_NOT_FOUND]: { status: 404, message: 'User not found' },
  [PROFILE_EMAIL_TAKEN]: { status: 409, message: 'Email already in use' },
  [PROFILE_EMAIL_SSO_MANAGED]: { status: 403, message: 'Your organization requires single sign-on (SSO) for this email address, so it cannot be changed here. Ask your organization\'s administrator.' },
  [PROFILE_INVALID_CREDENTIALS]: { status: 401, message: 'Current password incorrect' },
  [USER_OWNER_HAS_ORGS]: { status: 400, message: 'Cannot delete account while you own an organization that has other members or teams. Transfer ownership (or remove its teams) first — GET /user/account/deletion lists which.' },
  // Sole-owner self-delete: an owned org's recovery snapshot failed, so nothing was deleted.
  [ORG_SNAPSHOT_FAILED]: { status: 502, message: 'Could not capture your organization\'s recovery snapshot — nothing was deleted. Please retry shortly.' },
  [RL_LAST_PRIVILEGED_MEMBER]: { status: 409, message: 'Cannot delete your account while you are the last member of an admin or super-admin role.' },
  [PROFILE_PAT_LIMIT]: { status: 409, message: 'You have reached the maximum number of active access keys. Revoke one first.' },
  // A re-issue (generate-token, sign-out-everywhere) for an org that now
  // requires MFA is refused for an `aal: 1` session — the same refusal sign-in
  // would have given.
  ...MFA_POLICY_ERROR_MAP,
};
