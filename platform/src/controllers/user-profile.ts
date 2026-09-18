// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess, resolveUserFeatures, TOKEN_SCOPES } from '@pipeline-builder/api-core';
import type { TokenScope, FeatureFlag, QuotaTier } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { audit } from '../helpers/audit.js';
import { loadFactorUser, resolveAuthFactors } from '../helpers/auth-factors.js';
import { clientInfoOf } from '../helpers/client-info.js';
import { requireAuthUserId, withController } from '../helpers/controller-helper.js';
import { clearRefreshCookie, deliverSessionTokens } from '../helpers/session-cookie.js';
import { SESSION_AUTH_MISSING, TOKEN_SCOPE_ESCALATION } from '../services/auth-errors.js';
import { apiKeyService, userProfileService, type PreferencesPatch } from '../services/index.js';
import { RL_LAST_PRIVILEGED_MEMBER } from '../services/roles-errors.js';
import { PROFILE_USER_NOT_FOUND, PROFILE_EMAIL_TAKEN, PROFILE_INVALID_CREDENTIALS, PROFILE_PAT_LIMIT, USER_OWNER_HAS_ORGS } from '../services/user-errors.js';
import type { AccessTokenPayload } from '../types/index.js';
import { authFromClaims, findRefreshSession, issueTokens, renewSessionTokens } from '../utils/token.js';
import { validateBody, updateProfileSchema, changePasswordSchema } from '../utils/validation.js';

const logger = createLogger('user-profile-controller');

/** Notification preferences a client may set; anything else is rejected. */
const NOTIFICATION_PREFERENCE_KEYS: ReadonlySet<string> = new Set(['muteQuotaWarnings']);

/**
 * The scope a new credential may carry, given the caller's own token.
 *
 * A scoped token is a narrow machine credential. Anything it mints must carry
 * the SAME scope — otherwise a `reporting:ingest` token could trade itself for a
 * full-privilege one. An unscoped caller may request any allowed scope.
 * Returns the effective scope, or `undefined` for "no scope", or `false` when
 * the request would widen or swap the caller's scope.
 */
function scopeForCaller(req: Parameters<Parameters<typeof withController>[1]>[0], requested: TokenScope | undefined): TokenScope | undefined | false {
  const callerScope = (req.user as { scope?: TokenScope } | undefined)?.scope;
  if (!callerScope) return requested;
  if (requested !== undefined && requested !== callerScope) return false;
  return callerScope;
}

const profileErrorMap = {
  [TOKEN_SCOPE_ESCALATION]: { status: 403, message: 'A scoped token can only mint credentials with the same scope' },
  // Fail closed: a caller whose token carries no assurance claims can't have
  // them inherited by anything it mints.
  [SESSION_AUTH_MISSING]: { status: 401, message: 'Session cannot mint credentials — please sign in again' },
  [PROFILE_USER_NOT_FOUND]: { status: 404, message: 'User not found' },
  [PROFILE_EMAIL_TAKEN]: { status: 409, message: 'Email already in use' },
  [PROFILE_INVALID_CREDENTIALS]: { status: 401, message: 'Current password incorrect' },
  [USER_OWNER_HAS_ORGS]: { status: 400, message: 'Cannot delete account while you own an organization. Transfer ownership first.' },
  [RL_LAST_PRIVILEGED_MEMBER]: { status: 409, message: 'Cannot delete your account while you are the last member of an admin or super-admin role.' },
  [PROFILE_PAT_LIMIT]: { status: 409, message: 'You have reached the maximum number of active access keys. Revoke one first.' },
};

/** Compact organization summary included in user responses. */
export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
}

/** Membership info returned alongside user responses. */
export interface OrgMembership {
  id: string;
  name: string;
  role: string;
}

/** Fields required to build a user API response. */
export interface UserResponseInput {
  _id: Types.ObjectId;
  username: string;
  email: string;
  isEmailVerified: boolean;
  needsOnboarding?: boolean;
  isSuperAdmin?: boolean;
  lastActiveOrgId?: string;
  featureOverrides?: Map<string, boolean> | Record<string, boolean>;
  createdAt?: Date;
  updatedAt?: Date;
  tokenVersion?: number;
}

/**
 * Adapt a lean/projected user document to `formatUserResponse`'s input. Lean
 * Mongoose projections don't structurally line up with `UserResponseInput`
 * (looser field types), so this centralizes the single unavoidable cast in one
 * auditable place instead of scattering `as unknown as UserResponseInput`.
 */
export function toUserResponseInput(doc: unknown): UserResponseInput {
  return doc as UserResponseInput;
}

/** Convert Mongoose Map or plain object to Record<string, boolean>. */
export function toOverridesRecord(overrides?: Map<string, boolean> | Record<string, boolean>): Record<string, boolean> | undefined {
  if (!overrides) return undefined;
  if (overrides instanceof Map) return Object.fromEntries(overrides);
  return overrides;
}

/** Build a standardized user response object for API output. */
export function formatUserResponse(
  user: UserResponseInput,
  opts?: {
    activeOrgRole?: string;
    activeOrgName?: string | null;
    organization?: OrgSummary;
    organizations?: OrgMembership[];
    tier?: QuotaTier;
    features?: FeatureFlag[];
    /** Effective fine-grained permissions for the active org (RBAC UI gating). */
    permissions?: string[];
  },
) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: opts?.activeOrgRole || null,
    // Echo the sysadmin flag from mongo so the frontend can gate
    // sysadmin-only sidebar entries (Registry, Build Queue, All Users,
    // All Organizations) via isSystemAdmin(user). Was previously dropped
    // here, making the sidebar filter always see false.
    isSuperAdmin: user.isSuperAdmin === true,
    isEmailVerified: user.isEmailVerified,
    needsOnboarding: user.needsOnboarding === true,
    organizationId: user.lastActiveOrgId?.toString() || null,
    organizationName: opts?.activeOrgName || null,
    ...(opts?.organization && { organization: opts.organization }),
    ...(opts?.organizations && { organizations: opts.organizations }),
    ...(opts?.tier && { tier: opts.tier }),
    ...(opts?.features && { features: opts.features }),
    ...(opts?.permissions && { permissions: opts.permissions }),
    ...(user.featureOverrides && { featureOverrides: toOverridesRecord(user.featureOverrides) }),
    ...(user.createdAt && { createdAt: user.createdAt }),
    ...(user.updatedAt && { updatedAt: user.updatedAt }),
    ...(user.tokenVersion !== undefined && { tokenVersion: user.tokenVersion }),
  };
}

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
    },
  });
}, profileErrorMap);

/** GET /user/organizations — all org memberships for the current user. */
export const listUserOrganizations = withController('List user organizations', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  const organizations = await userProfileService.listOrganizations(userId);
  sendSuccess(res, 200, { organizations });
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
}, profileErrorMap);

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
}, profileErrorMap);

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
}, profileErrorMap);

/**
 * Capability scopes a caller may request on a generated token. A scoped token is
 * minted at least-privilege (member role, no sysadmin, no features) and is only
 * honored by endpoints that opt into that scope.
 *
 * The allowlist is api-core's `TOKEN_SCOPES` catalog — the SAME list the
 * service-account key routes validate against — so a new scoped surface is
 * declared once instead of in every mint path.
 */
const ALLOWED_TOKEN_SCOPES = new Set<string>(TOKEN_SCOPES);

/**
 * POST /user/generate-token
 * Body: { expiresIn?: number, scope?: string } — token lifetime in seconds
 * (max 365 days); optional narrow capability scope (e.g. 'reporting:ingest' for
 * the AWS event-ingestion machine credential).
 *
 * Mints a STORED MACHINE credential, never touching the caller's own login:
 *
 * - From a person (an interactive session, or no slot at all — a PAT): opens a
 *   NEW machine session holding the requested scope. The operator's login keeps
 *   its own slot, so `store-token` can't be evicted by later sign-ins, can't be
 *   killed by the operator's own refresh, and two runs from one login yield two
 *   independent credentials (no scope leak between them).
 * - From a machine session (the renewal Lambda's path): renews in place under
 *   that slot's stored scope. A machine session can never open another session,
 *   so a leaked machine token can't multiply itself.
 *
 * The result is NOT a browser session: machine sessions are refused by
 * POST /auth/refresh and are renewed only through this endpoint.
 */
export const generateToken = withController('Generate token', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  // Custom expiry cap matches pipeline-manager CLI's --days 365 ceiling.
  const MAX_EXPIRES_IN = 365 * 24 * 60 * 60;
  let expiresIn: number | undefined;
  if (req.body?.expiresIn !== undefined) {
    expiresIn = parseInt(req.body.expiresIn, 10);
    if (isNaN(expiresIn) || expiresIn < 1) {
      return sendError(res, 400, 'expiresIn must be a positive integer (seconds)', 'INVALID_EXPIRES_IN');
    }
    if (expiresIn > MAX_EXPIRES_IN) {
      return sendError(res, 400, `expiresIn must not exceed ${MAX_EXPIRES_IN} seconds (365 days)`, 'EXPIRES_IN_TOO_LARGE');
    }
  }

  let scope: TokenScope | undefined;
  if (req.body?.scope !== undefined) {
    if (typeof req.body.scope !== 'string' || !ALLOWED_TOKEN_SCOPES.has(req.body.scope)) {
      return sendError(res, 400, `scope must be one of: ${[...ALLOWED_TOKEN_SCOPES].join(', ')}`, 'INVALID_TOKEN_SCOPE');
    }
    // Validated against ALLOWED_TOKEN_SCOPES (⊆ TokenScope), so the cast is sound.
    scope = req.body.scope as TokenScope;
  }
  const effectiveScope = scopeForCaller(req, scope);
  if (effectiveScope === false) {
    return sendError(res, 403, 'A scoped token can only mint credentials with the same scope', TOKEN_SCOPE_ESCALATION);
  }
  scope = effectiveScope;

  const user = await userProfileService.findForTokenIssue(userId);
  const sessionId = (req.user as AccessTokenPayload).sid;
  const activeOrgId = user.lastActiveOrgId?.toString();
  const client = clientInfoOf(req);
  // A slot named by the token must still exist — a revoked or evicted session
  // must not be able to mint a long-lived credential.
  const callerSlot = sessionId ? await findRefreshSession(userId, sessionId) : undefined;
  if (sessionId && !callerSlot) return sendError(res, 401, 'Session invalid');
  const issued = callerSlot?.kind === 'machine'
    ? await renewSessionTokens(user, activeOrgId, { sessionId: sessionId!, kind: 'machine' }, { expiresIn, scope, client })
    : await issueTokens(user, activeOrgId, {
      kind: 'machine',
      auth: authFromClaims(req.user),
      client,
      expiresIn,
      scope,
    });
  if (!issued) return sendError(res, 401, 'Session invalid');
  const { accessToken, expiresIn: actual } = issued;
  // Bearer-token issuance is sensitive: long-lived tokens (up to 365 days)
  // become a credential. Recording the requested lifetime + whether a machine
  // session was opened or renewed lets reviewers spot anomalous issuance.
  audit(req, 'user.token.create', {
    targetType: 'user',
    targetId: userId,
    details: {
      expiresIn: actual,
      session: callerSlot?.kind === 'machine' ? 'renewed' : 'opened',
      ...(scope ? { scope } : {}),
    },
  });
  // No refresh token: a machine session renews through THIS endpoint, never
  // through POST /auth/refresh, so handing one out would only be a second
  // long-lived secret to store.
  sendSuccess(res, 200, { accessToken, expiresIn: actual });
}, profileErrorMap);

/** GET /user/sessions — the caller's signed-in devices and stored machine credentials. */
export const listSessions = withController('List sessions', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const currentSessionId = (req.user as AccessTokenPayload).sid;
  const { sessions, machineSessions } = await userProfileService.listSessions(userId);
  // `current` marks the session making THIS request so the UI can label it and
  // refuse to revoke it.
  sendSuccess(res, 200, {
    sessions: sessions.map((s) => ({ ...s, current: s.id === currentSessionId })),
    machineSessions: machineSessions.map((s) => ({ ...s, current: s.id === currentSessionId })),
  });
}, profileErrorMap);

/**
 * DELETE /user/sessions/:id — revoke one of the caller's own sessions.
 *
 * An interactive session is signed out; a machine session stops renewing. The
 * CURRENT session can't revoke itself (that's POST /auth/logout, which also
 * clears the client's tokens) — otherwise a mis-click would strand the tab with
 * a token it can no longer refresh. Step-up gated (see routes/user.ts).
 */
export const revokeSession = withController('Revoke session', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const sessionId = typeof req.params.id === 'string' ? req.params.id : '';
  if (!sessionId) return sendError(res, 400, 'id is required', 'INVALID_SESSION_ID');
  if (sessionId === (req.user as AccessTokenPayload).sid) {
    return sendError(res, 400, 'This session cannot revoke itself — sign out instead', 'SESSION_SELF_REVOKE');
  }
  const revoked = await userProfileService.revokeSession(userId, sessionId);
  if (!revoked) return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
  audit(req, 'user.session.revoke', {
    targetType: 'user',
    targetId: userId,
    details: { sessionId, kind: revoked.kind },
  });
  sendSuccess(res, 200, { revoked: true });
}, profileErrorMap);

/** GET /user/tokens — recent access-token history with computed status. */
export const listTokenHistory = withController('List token history', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const tokens = await userProfileService.listTokenHistory(userId);
  sendSuccess(res, 200, { tokens });
}, profileErrorMap);

/**
 * POST /user/keys — create a named opaque access key.
 * Body: { name, expiresIn?: seconds (default 90d, max 365d), scope? }.
 *
 * The raw key (`pb_pat_…`) is returned ONCE and is never stored — only its
 * SHA-256 hash, prefix and last four characters are kept, which is all the
 * listing can ever show.
 */
export const createAccessKey = withController('Create access key', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return sendError(res, 400, 'name is required', 'INVALID_NAME');
  if (name.length > 100) return sendError(res, 400, 'name must be at most 100 characters', 'INVALID_NAME');

  const MAX_EXPIRES_IN = 365 * 24 * 60 * 60;
  const DEFAULT_EXPIRES_IN = 90 * 24 * 60 * 60;
  let expiresIn = DEFAULT_EXPIRES_IN;
  if (req.body?.expiresIn !== undefined) {
    expiresIn = parseInt(req.body.expiresIn, 10);
    if (isNaN(expiresIn) || expiresIn < 1) {
      return sendError(res, 400, 'expiresIn must be a positive integer (seconds)', 'INVALID_EXPIRES_IN');
    }
    if (expiresIn > MAX_EXPIRES_IN) {
      return sendError(res, 400, `expiresIn must not exceed ${MAX_EXPIRES_IN} seconds (365 days)`, 'EXPIRES_IN_TOO_LARGE');
    }
  }

  let scope: TokenScope | undefined;
  if (req.body?.scope !== undefined && req.body.scope !== null && req.body.scope !== '') {
    if (typeof req.body.scope !== 'string' || !ALLOWED_TOKEN_SCOPES.has(req.body.scope)) {
      return sendError(res, 400, `scope must be one of: ${[...ALLOWED_TOKEN_SCOPES].join(', ')}`, 'INVALID_TOKEN_SCOPE');
    }
    scope = req.body.scope as TokenScope;
  }
  const effectiveScope = scopeForCaller(req, scope);
  if (effectiveScope === false) {
    return sendError(res, 403, 'A scoped token can only mint credentials with the same scope', TOKEN_SCOPE_ESCALATION);
  }
  scope = effectiveScope;

  // The key records the creating session's assurance (`amr`/`aal`/`auth_time`)
  // so every token exchanged from it inherits — and never raises — it.
  const { key, view } = await apiKeyService.create(
    userId,
    { name, expiresInSeconds: expiresIn, scope, client: clientInfoOf(req) },
    authFromClaims(req.user),
  );
  audit(req, 'user.key.create', {
    targetType: 'user',
    targetId: userId,
    details: { keyId: view.id, name, expiresIn, prefix: view.prefix, ...(scope ? { scope } : {}) },
  });
  sendSuccess(res, 201, { key, accessKey: view });
}, profileErrorMap);

/** GET /user/keys — list the user's access keys (metadata only, never the secret). */
export const listAccessKeys = withController('List access keys', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const keys = await apiKeyService.list(userId);
  sendSuccess(res, 200, { keys });
}, profileErrorMap);

/** DELETE /user/keys/:id — revoke a single access key immediately. */
export const revokeAccessKey = withController('Revoke access key', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const id = typeof req.params.id === 'string' ? req.params.id : '';
  if (!id) return sendError(res, 400, 'id is required', 'INVALID_KEY_ID');
  const revoked = await apiKeyService.revoke(userId, id);
  if (!revoked) return sendError(res, 404, 'Key not found or already revoked', 'ACCESS_KEY_NOT_FOUND');
  audit(req, 'user.key.revoke', {
    targetType: 'user',
    targetId: userId,
    details: { keyId: revoked.id, name: revoked.name },
  });
  sendSuccess(res, 200, { revoked: true });
}, profileErrorMap);

/** GET /user/preferences — the current user's per-org favorites, recents and notification preferences. */
export const getPreferences = withController('Get preferences', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const orgId = req.user?.organizationId;
  if (!orgId) return sendError(res, 400, 'No active organization', 'NO_ACTIVE_ORG');
  const preferences = await userProfileService.getPreferences(userId, orgId);
  sendSuccess(res, 200, { preferences });
}, profileErrorMap);

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
    const entries = Object.entries(n as Record<string, unknown>);
    const unknownKeys = entries.map(([k]) => k).filter((k) => !NOTIFICATION_PREFERENCE_KEYS.has(k));
    if (unknownKeys.length > 0) {
      return sendError(res, 400, `Unknown notification preference(s): ${unknownKeys.join(', ')}`, 'INVALID_NOTIFICATIONS');
    }
    if (entries.some(([, v]) => typeof v !== 'boolean')) {
      return sendError(res, 400, 'Notification preferences must be booleans', 'INVALID_NOTIFICATIONS');
    }
    patch.notifications = n as PreferencesPatch['notifications'];
  }

  const preferences = await userProfileService.updatePreferences(userId, orgId, patch);
  sendSuccess(res, 200, { preferences });
}, profileErrorMap);

/** POST /user/tokens/revoke-all — sign out everywhere + issue a fresh token. */
export const revokeAllTokens = withController('Revoke all tokens', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  const user = await userProfileService.revokeAllSessions(userId);
  audit(req, 'user.tokens.revoke-all', { targetType: 'user', targetId: userId });

  // Issue a fresh token at the new tokenVersion so the active session survives —
  // a new interactive slot (every old slot was just cleared), carrying the
  // caller's own assurance and scope.
  const tokens = await issueTokens(user, user.lastActiveOrgId?.toString(), {
    kind: 'interactive',
    auth: authFromClaims(req.user),
    client: clientInfoOf(req),
    scope: (req.user as { scope?: TokenScope }).scope,
  });
  // The surviving session's cookie is replaced here, so "sign out everywhere"
  // leaves THIS browser signed in exactly as it did before.
  sendSuccess(res, 200, { revoked: true, ...deliverSessionTokens(req, res, tokens) });
}, profileErrorMap);
