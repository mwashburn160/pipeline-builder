// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /auth/password/change-required — finish a password sign-in whose
 * password no longer meets the person's org password policy.
 *
 * The first leg (`/auth/login`, or `/auth/mfa/verify` after a second factor)
 * verified the OLD password and answered `{ passwordChangeRequired: true,
 * challengeId, minLength }` instead of a session. This leg takes the handle and
 * a NEW password, which must:
 *   - pass the platform rules (request schema + model hook),
 *   - meet the person's org policy and not be a known-breached password
 *     (`assertNewPasswordAcceptable` — the same check every password-setting
 *     path runs),
 *   - differ from the old one.
 * It then saves it, bumps `tokenVersion` (every other session and token of the
 * account ends, exactly as a normal password change does), and opens the
 * session the sign-in would have opened — with the assurance the first leg(s)
 * EARNED, carried in the challenge, never a level of its own.
 *
 * PRE-AUTH by construction (the caller holds a handle, not a session), and
 * under the `/auth` per-IP limiter like the rest of sign-in.
 */

import { sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { isBootstrapExceptionOpen, recordBootstrapSession } from '../helpers/bootstrap-admin.js';
import { clientInfoOf } from '../helpers/client-info.js';
import { withController } from '../helpers/controller-helper.js';
import { MFA_POLICY_ERROR_MAP } from '../helpers/mfa-policy.js';
import { assertNewPasswordAcceptable } from '../helpers/password-policy.js';
import { deliverSessionTokens } from '../helpers/session-cookie.js';
import { publishUserRevocation } from '../helpers/session-revocation.js';
import { User } from '../models/index.js';
import { incCounter } from '../observability/metrics.js';
import {
  consumePasswordChangeChallenge,
  peekPasswordChangeChallenge,
} from '../services/password-change-challenge.js';
import { issueTokens } from '../utils/token.js';
import { requiredPasswordChangeSchema, validateBody } from '../utils/validation.js';

export const completeRequiredPasswordChange = withController('Required password change', async (req, res) => {
  const body = validateBody(requiredPasswordChangeSchema, req.body, res);
  if (!body) return;

  const pending = await peekPasswordChangeChallenge(body.challengeId);
  if (!pending) {
    // Not an oracle: the handle is 256 unguessable bits. The UI needs to know to
    // send the person back to the password field.
    return sendError(res, 401, 'This sign-in expired. Please sign in again.', 'PASSWORD_CHANGE_CHALLENGE_INVALID');
  }

  const user = await User.findById(pending.userId).select('+password +tokenVersion +isSuperAdmin');
  if (!user || !user.password) {
    return sendError(res, 401, 'This sign-in expired. Please sign in again.', 'PASSWORD_CHANGE_CHALLENGE_INVALID');
  }
  if (await user.comparePassword(body.newPassword)) {
    return sendError(res, 400, 'Choose a password different from your current one', 'PASSWORD_UNCHANGED');
  }
  // Org policy (strictest across the person's orgs) + breached-password check.
  await assertNewPasswordAcceptable(body.newPassword, { userId: pending.userId });

  user.password = body.newPassword;
  user.tokenVersion += 1;
  await user.save();
  // Spent only now — a refused password above leaves the handle usable.
  await consumePasswordChangeChallenge(body.challengeId);
  await publishUserRevocation(pending.userId);
  audit(req, 'user.password.change', {
    targetType: 'user',
    targetId: pending.userId,
    details: { reason: 'org_password_policy', minLength: pending.minLength },
  });

  // Same bootstrap-admin rule as `/auth/login` (only a password-only sign-in
  // can still be inside it; one that passed TOTP has already closed it).
  const bootstrapPending = pending.aal < 2 && await isBootstrapExceptionOpen(user);
  const tokens = await issueTokens(user, pending.orgId ?? user.lastActiveOrgId?.toString(), {
    kind: 'interactive',
    auth: { amr: [...pending.amr], aal: pending.aal, authTime: new Date() },
    client: clientInfoOf(req),
    ...(bootstrapPending ? { mfaEnrollmentPending: true } : {}),
  });
  if (bootstrapPending) await recordBootstrapSession(req, pending.userId, user.email);

  audit(req, 'user.login', {
    targetType: 'user',
    targetId: pending.userId,
    details: { method: pending.amr.includes('mfa') ? 'pwd+totp' : 'pwd', passwordChanged: true },
  });
  incCounter('platform_logins_total');
  sendSuccess(res, 200, {
    ...deliverSessionTokens(req, res, tokens),
    ...(bootstrapPending ? { mfaEnrollmentPending: true } : {}),
  });
}, { ...MFA_POLICY_ERROR_MAP });
