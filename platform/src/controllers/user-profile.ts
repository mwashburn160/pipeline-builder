// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, ECOSYSTEM_EMAIL_PREFERENCE_FIELD_NAMES, sendError, sendSuccess, resolveUserFeatures } from '@pipeline-builder/api-core';
import type { QuotaTier } from '@pipeline-builder/api-core';
import { PASSWORD_MAX_LENGTH } from '../constants/password.js';
import { audit } from '../helpers/audit.js';
import { loadFactorUser, resolveAuthFactors } from '../helpers/auth-factors.js';
import { requireAuthUserId, withController } from '../helpers/controller-helper.js';
import { reportableMfaNudge, type StoredMfaNudge } from '../helpers/mfa-nudge.js';
import { resolveEffectiveMfaPolicy } from '../helpers/mfa-policy.js';
import { passwordPolicyForPerson } from '../helpers/password-policy.js';
import { clearRefreshCookie } from '../helpers/session-cookie.js';
import { userErrorMap } from '../helpers/user-error-map.js';
import { formatUserResponse, toOverridesRecord, type OrgMembership, type UserResponseInput } from '../helpers/user-response.js';
import { userProfileService, type PreferencesPatch } from '../services/index.js';
import { validateBody, updateProfileSchema, changePasswordSchema } from '../utils/validation.js';

const logger = createLogger('user-profile-controller');

/** Notification preferences a client may set; anything else is rejected. */
const NOTIFICATION_PREFERENCE_KEYS: ReadonlySet<string> = new Set(['muteQuotaWarnings']);

/** GET /user/profile — current user with active-org context. */
export const getUser = withController('Get user profile', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  const { user, memberships, orgMap } = await userProfileService.getProfileWithOrgs(userId);

  const organizations: OrgMembership[] = memberships.map(m => {
    const org = orgMap.get(m.organizationId.toString());
    return { id: m.organizationId.toString(), name: org?.name || 'Unknown', role: m.role };
  });

  // Resolve active org tier and features for the JWT-active org.
  const activeOrgId = req.user!.organizationId || (user as { lastActiveOrgId?: { toString(): string } }).lastActiveOrgId?.toString();
  let activeOrgName: string | null = null;
  let activeOrgRole: string | null = null;
  let tier: QuotaTier = 'developer';

  if (activeOrgId) {
    const activeOrg = orgMap.get(activeOrgId.toString());
    if (activeOrg) {
      activeOrgName = activeOrg.name;
      tier = (activeOrg.tier as QuotaTier) || 'developer';
    }
    const activeMembership = memberships.find(m => m.organizationId.toString() === activeOrgId.toString());
    activeOrgRole = activeMembership?.role || null;
  }

  // Which step-up factors this account actually has, so the step-up modal
  // offers only those (password, and/or "sign in again with <provider>").
  const factorUser = await loadFactorUser(userId);
  const authFactors = factorUser ? await resolveAuthFactors(factorUser) : undefined;

  // The PASSWORD-ONLY PROMPT's suppression state (helpers/mfa-nudge.ts), which
  // the shell reads to decide whether to invite this person to enrol a factor.
  // Reported only for an account that HOLDS no factor: the prompt has no
  // meaning otherwise, and refusing to report it there is what makes a stale
  // decline — one that somehow outlived the clear every enrolment path runs —
  // unable to suppress a future prompt. Absent is the common case.
  const mfaNudge = reportableMfaNudge(authFactors, (user as { mfaNudge?: StoredMfaNudge }).mfaNudge);

  // The active org's MFA requirement, so the shell can show the banner with
  // its deadline and route the person into enrolment BEFORE the grace ends —
  // rather than letting them discover the policy through a failed sign-in.
  // Resolved here (not read off the token) so it is current the moment an admin
  // turns it on, and carries the deadline, which the claim deliberately doesn't.
  const mfaPolicy = activeOrgId ? await resolveEffectiveMfaPolicy(activeOrgId.toString()) : undefined;

  const overrides = toOverridesRecord((user as { featureOverrides?: Map<string, boolean> }).featureOverrides);
  // Include the active org's account-level entitlements (e.g. add-on bundle
  // grants) so /profile reports the same feature set the JWT carries.
  const activeOrgFeatures = activeOrgId ? orgMap.get(activeOrgId.toString())?.featureEntitlements : undefined;
  const features = resolveUserFeatures(tier, { overrides, isSuperAdmin: (user as { isSuperAdmin?: boolean }).isSuperAdmin === true, accountFeatures: activeOrgFeatures });

  sendSuccess(res, 200, {
    user: {
      ...formatUserResponse(user as UserResponseInput, {
        activeOrgRole: activeOrgRole || undefined,
        activeOrgName,
        organizations,
        tier,
        features,
        // `req.user.permissions` is resolved per-request by populateRequestUser
        // (role bundle ∪ group grants; superadmin ⇒ all) — echo it for UI gating.
        permissions: req.user?.permissions,
      }),
      // Step-up factors ride on the user so the auth context (and the step-up
      // modal) sees them with the rest of the profile.
      ...(authFactors && { authFactors }),
      // "Not now" / "don't ask again" for the password-only prompt. Only ever
      // present for an account with no factor, and only when one of them is
      // actually in force — an expired snooze reports as nothing.
      ...(mfaNudge && { mfaNudge }),
      // Only when the org actually requires MFA — an absent field is the common
      // case and keeps the payload (and the banner logic) quiet by default.
      ...(mfaPolicy?.requireMfa ? {
        mfaPolicy: {
          requireMfa: true,
          enforced: mfaPolicy.enforced,
          ...(mfaPolicy.graceUntil ? { graceUntil: mfaPolicy.graceUntil.toISOString() } : {}),
          // An approved MFA reset's per-user enrolment grace: the policy does not
          // refuse THIS person until then, and the banner says by when to enrol.
          ...(activeResetGrace(user) ? { resetGraceUntil: activeResetGrace(user) } : {}),
          // The session's own level, so the banner can say "you're covered"
          // rather than nagging someone who already signed in with a factor.
          aal: req.user?.aal ?? 1,
        },
      } : {}),
    },
  });
}, userErrorMap);

/** The running MFA-reset enrolment grace (ISO), or undefined. */
function activeResetGrace(user: unknown): string | undefined {
  const until = (user as { mfaResetGraceUntil?: Date | string | null }).mfaResetGraceUntil;
  if (!until) return undefined;
  const at = new Date(until);
  return at.getTime() > Date.now() ? at.toISOString() : undefined;
}

/** GET /user/organizations — all org memberships for the current user. */
export const listUserOrganizations = withController('List user organizations', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  const organizations = await userProfileService.listOrganizations(userId);
  sendSuccess(res, 200, { organizations });
});

/**
 * GET /user/password-policy — the minimum a NEW password of this person's must
 * meet: the strictest effective policy across every org they belong to (the
 * same bar `changePassword` enforces). The org's own policy endpoint is gated on
 * `org:settings`, so a member's change-password form could not know the org's
 * minimum and advertised the platform floor instead.
 */
export const getOwnPasswordPolicy = withController('Get password policy', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  const policy = await passwordPolicyForPerson(userId);
  sendSuccess(res, 200, { minLength: policy.minLength, maxLength: PASSWORD_MAX_LENGTH });
});

/** PATCH /user/profile — update username and/or email. */
export const updateUser = withController('Update user profile', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const body = validateBody(updateProfileSchema, req.body, res);
  if (!body) return;

  const { user, organizationName, activeOrgRole } = await userProfileService.updateProfile(userId, body);
  logger.info('Update user success', { userId });
  // Capture WHICH fields changed (not the values) so the audit log shows
  // "username/email was updated" without leaking PII into the event details.
  audit(req, 'user.profile.update', {
    targetType: 'user',
    targetId: userId,
    details: { fields: Object.keys(body) },
  });
  sendSuccess(res, 200, { user: formatUserResponse(user as UserResponseInput, { activeOrgRole, activeOrgName: organizationName }) });
}, userErrorMap);

/** DELETE /user/account — refuses if user owns any orgs. */
export const deleteUser = withController('Delete user account', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  await userProfileService.deleteAccount(userId);
  logger.info('Account deleted', { userId });
  // The browser can't drop its own HttpOnly refresh cookie — this response must.
  clearRefreshCookie(res);
  audit(req, 'user.delete', { targetType: 'user', targetId: userId });
  sendSuccess(res, 200, undefined, 'Account successfully deleted');
}, userErrorMap);

/** POST /user/change-password — verify current pw + bump tokenVersion. */
export const changePassword = withController('Change password', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const body = validateBody(changePasswordSchema, req.body, res);
  if (!body) return;

  await userProfileService.changePassword(userId, body.currentPassword, body.newPassword);
  logger.info('Password change success', { userId });
  // Auth-factor change — a compromised session showing this event with an
  // unfamiliar IP is one of the first things a user / sysadmin looks for
  // during incident response.
  audit(req, 'user.password.change', { targetType: 'user', targetId: userId });
  sendSuccess(res, 200, undefined, 'Password changed successfully');
}, userErrorMap);


/** GET /user/preferences — the current user's per-org favorites, recents and notification preferences. */
export const getPreferences = withController('Get preferences', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const orgId = req.user?.organizationId;
  if (!orgId) return sendError(res, 400, 'No active organization', 'NO_ACTIVE_ORG');
  const preferences = await userProfileService.getPreferences(userId, orgId);
  sendSuccess(res, 200, { preferences });
}, userErrorMap);

/** PUT /user/preferences — update favorites, recents and/or notification preferences for the active org. */
export const updatePreferences = withController('Update preferences', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const orgId = req.user?.organizationId;
  if (!orgId) return sendError(res, 400, 'No active organization', 'NO_ACTIVE_ORG');

  const patch: PreferencesPatch = {};
  if (req.body?.favorites !== undefined) {
    if (!Array.isArray(req.body.favorites)) return sendError(res, 400, 'favorites must be an array of strings', 'INVALID_FAVORITES');
    patch.favorites = req.body.favorites.map(String);
  }
  if (req.body?.recents !== undefined) {
    if (!Array.isArray(req.body.recents)) return sendError(res, 400, 'recents must be an array of strings', 'INVALID_RECENTS');
    patch.recents = req.body.recents.map(String);
  }
  if (req.body?.notifications !== undefined) {
    const n = req.body.notifications as unknown;
    if (!n || typeof n !== 'object' || Array.isArray(n)) {
      return sendError(res, 400, 'notifications must be an object', 'INVALID_NOTIFICATIONS');
    }
    const { ecosystem, ...flat } = n as Record<string, unknown>;
    const entries = Object.entries(flat);
    const unknownKeys = entries.map(([k]) => k).filter((k) => !NOTIFICATION_PREFERENCE_KEYS.has(k));
    if (unknownKeys.length > 0) {
      return sendError(res, 400, `Unknown notification preference(s): ${unknownKeys.join(', ')}`, 'INVALID_NOTIFICATIONS');
    }
    if (entries.some(([, v]) => typeof v !== 'boolean')) {
      return sendError(res, 400, 'Notification preferences must be booleans', 'INVALID_NOTIFICATIONS');
    }
    // Plugin-ecosystem email opt-outs: a nested object of known booleans.
    if (ecosystem !== undefined) {
      if (!ecosystem || typeof ecosystem !== 'object' || Array.isArray(ecosystem)) {
        return sendError(res, 400, 'notifications.ecosystem must be an object', 'INVALID_NOTIFICATIONS');
      }
      const ecoEntries = Object.entries(ecosystem as Record<string, unknown>);
      const unknownEco = ecoEntries.map(([k]) => k).filter((k) => !(ECOSYSTEM_EMAIL_PREFERENCE_FIELD_NAMES as readonly string[]).includes(k));
      if (unknownEco.length > 0) {
        return sendError(res, 400, `Unknown ecosystem notification preference(s): ${unknownEco.join(', ')}`, 'INVALID_NOTIFICATIONS');
      }
      if (ecoEntries.some(([, v]) => typeof v !== 'boolean')) {
        return sendError(res, 400, 'Notification preferences must be booleans', 'INVALID_NOTIFICATIONS');
      }
    }
    patch.notifications = n as PreferencesPatch['notifications'];
  }

  const preferences = await userProfileService.updatePreferences(userId, orgId, patch);
  sendSuccess(res, 200, { preferences });
}, userErrorMap);
