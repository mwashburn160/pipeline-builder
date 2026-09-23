// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The caller's OWN credential surface: sessions, generated machine tokens,
 * access keys and "sign out everywhere".
 *
 * Split out of `user-profile.ts`, which now keeps only profile and preferences.
 * These handlers share one concern the profile half has none of — minting and
 * revoking credentials derived from the caller's own token, which must never
 * widen the caller's scope, permissions or assurance. Route paths are unchanged
 * (`routes/user.ts` imports through the `controllers/index.ts` barrel).
 */

import { refuseForOrgAdminAssurance, sendError, sendSuccess, TOKEN_SCOPES } from '@pipeline-builder/api-core';
import type { TokenScope } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { clientInfoOf } from '../helpers/client-info.js';
import { requireAuthUserId, withController } from '../helpers/controller-helper.js';
import { deliverSessionTokens } from '../helpers/session-cookie.js';
import {
  SESSION_SLOT_REQUIRED,
  assertScopeMintable,
  callerHasSessionSlot,
  callerRestriction,
  resolveRequestedPermissions,
} from '../helpers/token-permissions.js';
import { userErrorMap } from '../helpers/user-error-map.js';
import { TOKEN_SCOPE_ESCALATION } from '../services/auth-errors.js';
import { apiKeyService, userProfileService } from '../services/index.js';
import { authFromClaims } from '../services/session/access-tokens.js';
import { findRefreshSession, issueTokens, renewSessionTokens } from '../services/session/refresh-sessions.js';
import type { AccessTokenPayload } from '../types/index.js';

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

/** The parts of a slot's auth context the JWT does not carry, for a credential
 *  derived from it: the passkey model and the org that asserted its `aal`. */
function slotAuthContext(slot: { aaguid?: string; aalAssertedBy?: string }): { aaguid?: string; aalAssertedBy?: string } {
  return {
    ...(slot.aaguid ? { aaguid: slot.aaguid } : {}),
    ...(slot.aalAssertedBy ? { aalAssertedBy: slot.aalAssertedBy } : {}),
  };
}
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
 * Body: { expiresIn?: number, scope?: string, permissions?: string[] } — the
 * CREDENTIAL's lifetime in seconds (max 365 days): the machine slot ends then,
 * while its access tokens keep the normal short lifetime and are renewed with
 * the returned refresh token (POST /auth/refresh). Optional narrow capability scope (e.g.
 * 'reporting:ingest' for the AWS event-ingestion machine credential); or an
 * optional permission SUBSET (catalog ids ⊆ the caller's current permissions,
 * see helpers/token-permissions.ts). Omitting both means full access.
 *
 * Mints a STORED MACHINE credential, never touching the caller's own login:
 *
 * - From a person (an interactive session, or no slot at all — a PAT): opens a
 *   NEW machine session holding the requested scope. The operator's login keeps
 *   its own slot, so `store-token` can't be evicted by later sign-ins, can't be
 *   killed by the operator's own refresh, and two runs from one login yield two
 *   independent credentials (no scope leak between them).
 * - From a machine session: renews in place under that slot's stored scope
 *   (rotating its refresh token) — never past the slot's fixed end, which a
 *   renewal cannot move. A machine session can never open another session, so
 *   a leaked machine token can't multiply itself.
 *
 * The result is NOT a browser session: it has its own slot, listed under
 * machine sessions, and revoking that slot kills its access token everywhere.
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

  // A machine credential is derived only from a person's own session slot —
  // never from an exchanged key token, an impersonation token or a service
  // account (see `callerHasSessionSlot`): revoking the key / ending the
  // impersonation must not leave a long-lived credential behind.
  if (!callerHasSessionSlot(req)) {
    return sendError(res, 403, 'Sign in to mint a machine token — access keys and impersonated sessions cannot', SESSION_SLOT_REQUIRED);
  }

  const user = await userProfileService.findForTokenIssue(userId);
  const sessionId = (req.user as AccessTokenPayload).sid;
  const activeOrgId = user.lastActiveOrgId?.toString();
  const client = clientInfoOf(req);
  // A slot named by the token must still exist — a revoked or evicted session
  // must not be able to mint a long-lived credential.
  const callerSlot = sessionId ? await findRefreshSession(userId, sessionId) : undefined;
  if (sessionId && !callerSlot) return sendError(res, 401, 'Session invalid');

  // Optional permission SUBSET (catalog ids). OPENING a machine session
  // validates it against the creator's current permissions (and inherits a
  // restricted caller's own set); RENEWING one keeps the slot's stored subset,
  // so a subset sent on renewal must name that same set (else 403).
  let permissions: string[] | undefined;
  if (callerSlot?.kind === 'machine') {
    if (req.body?.permissions !== undefined && req.body.permissions !== null) {
      if (!Array.isArray(req.body.permissions)) {
        return sendError(res, 400, 'permissions must be an array of permission ids', 'INVALID_PERMISSIONS');
      }
      permissions = req.body.permissions.map(String);
    }
  } else {
    const subset = await resolveRequestedPermissions(req, userId, req.body?.permissions, scope);
    if (!subset.ok) return sendError(res, subset.status, subset.message, subset.code, subset.missing ? { missing: subset.missing } : undefined);
    permissions = subset.permissions;
    const mintable = await assertScopeMintable(req, userId, scope);
    if (!mintable.ok) return sendError(res, mintable.status, mintable.message, mintable.code, mintable.missing ? { missing: mintable.missing } : undefined);
  }
  // The org's "administrative actions require MFA" policy governs OPENING a new
  // machine credential (a person with `aal: 2`, never another credential) —
  // not renewing one, which the unattended renewal must keep doing.
  if (callerSlot?.kind !== 'machine' && refuseForOrgAdminAssurance(req, res, { machines: 'refuse' })) return;
  const issued = callerSlot?.kind === 'machine'
    ? await renewSessionTokens(user, activeOrgId, { sessionId: sessionId!, kind: 'machine' }, { scope, permissions, client })
    : await issueTokens(user, activeOrgId, {
      kind: 'machine',
      // Inherits the opening slot's assurance context, including the passkey
      // model and any org-asserted `aal` (re-checked at every renewal).
      auth: { ...authFromClaims(req.user), ...(callerSlot ? slotAuthContext(callerSlot) : {}) },
      client,
      ...(expiresIn !== undefined ? { lifetimeSeconds: expiresIn } : {}),
      scope,
      ...(permissions ? { permissions } : {}),
    });
  if (!issued) return sendError(res, 401, 'Session invalid');
  const { accessToken, refreshToken, expiresIn: actual } = issued;
  // Bearer-token issuance is sensitive: long-lived tokens (up to 365 days)
  // become a credential. Recording the requested lifetime + whether a machine
  // session was opened or renewed lets reviewers spot anomalous issuance.
  audit(req, 'user.token.create', {
    targetType: 'user',
    targetId: userId,
    details: {
      expiresIn: actual,
      // The credential's own lifetime (the slot's), when one was opened with it.
      ...(callerSlot?.kind !== 'machine' && expiresIn !== undefined ? { lifetimeSeconds: expiresIn } : {}),
      session: callerSlot?.kind === 'machine' ? 'renewed' : 'opened',
      ...(scope ? { scope } : {}),
      // The subset the credential was OPENED with (a renewal keeps the slot's);
      // absent = full permissions.
      ...(callerSlot?.kind !== 'machine' && permissions ? { permissions } : {}),
    },
  });
  // The refresh token IS the stored credential: the access token is
  // short-lived (a person's lifetime), renewed through POST /auth/refresh with
  // this refresh token until the slot's fixed end.
  sendSuccess(res, 200, { accessToken, refreshToken, expiresIn: actual });
}, userErrorMap);

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
}, userErrorMap);

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
}, userErrorMap);

/** GET /user/tokens — recent access-token history with computed status. */
export const listTokenHistory = withController('List token history', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const tokens = await userProfileService.listTokenHistory(userId);
  sendSuccess(res, 200, { tokens });
}, userErrorMap);

/**
 * POST /user/keys — create a named opaque access key.
 * Body: { name, expiresIn?: seconds (default 90d, max 365d), scope?, permissions? }.
 * `permissions` narrows the key to a catalog subset ("Selected permissions");
 * omitted, the key has "Full access" — the owner's current permissions.
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

  // Like a machine token, a key is derived only from a person's own session:
  // a key minted from another key would outlive that key's revocation.
  if (!callerHasSessionSlot(req)) {
    return sendError(res, 403, 'Sign in to create an access key — access keys and impersonated sessions cannot', SESSION_SLOT_REQUIRED);
  }
  // "Selected permissions" (a catalog subset ⊆ what the creator holds now) or
  // "Full access" (omitted). Either way every exchange re-intersects with the
  // owner's live permissions, so the key can only ever shrink.
  const subset = await resolveRequestedPermissions(req, userId, req.body?.permissions, scope);
  if (!subset.ok) return sendError(res, subset.status, subset.message, subset.code, subset.missing ? { missing: subset.missing } : undefined);
  const permissions = subset.permissions;
  const mintable = await assertScopeMintable(req, userId, scope);
  if (!mintable.ok) return sendError(res, mintable.status, mintable.message, mintable.code, mintable.missing ? { missing: mintable.missing } : undefined);

  // The key records the creating session's assurance (`amr`/`aal`/`auth_time`,
  // plus the slot's passkey model) so every token exchanged from it inherits —
  // and never raises — it, and the org's authenticator allowlist can be
  // re-applied at every exchange. The slot must still exist.
  const creatingSlot = await findRefreshSession(userId, (req.user as AccessTokenPayload).sid!);
  if (!creatingSlot) return sendError(res, 401, 'Session invalid');
  const { key, view } = await apiKeyService.create(
    userId,
    { name, expiresInSeconds: expiresIn, scope, ...(permissions ? { permissions } : {}), client: clientInfoOf(req) },
    { ...authFromClaims(req.user), ...slotAuthContext(creatingSlot) },
  );
  audit(req, 'user.key.create', {
    targetType: 'user',
    targetId: userId,
    details: {
      keyId: view.id,
      name,
      expiresIn,
      prefix: view.prefix,
      // A permission-scoped key records its subset; absent = full access.
      ...(scope ? { scope } : {}),
      ...(permissions ? { permissions } : {}),
    },
  });
  sendSuccess(res, 201, { key, accessKey: view });
}, userErrorMap);

/** GET /user/keys — list the user's access keys (metadata only, never the secret). */
export const listAccessKeys = withController('List access keys', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const keys = await apiKeyService.list(userId);
  sendSuccess(res, 200, { keys });
}, userErrorMap);

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
}, userErrorMap);

/** POST /user/tokens/revoke-all — sign out everywhere + issue a fresh token. */
export const revokeAllTokens = withController('Revoke all tokens', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  // Read BEFORE the sign-out clears it: the surviving session inherits the
  // calling slot's full auth context (passkey model, org-asserted `aal`).
  const callerSlot = callerHasSessionSlot(req)
    ? await findRefreshSession(userId, (req.user as AccessTokenPayload).sid!)
    : undefined;
  const user = await userProfileService.revokeAllSessions(userId);
  audit(req, 'user.tokens.revoke-all', { targetType: 'user', targetId: userId });

  // Only a person's own session survives the sign-out with a fresh slot; a key
  // token (just revoked with every other key) or an impersonation token gets
  // no replacement — deriving one would mint a session from a dead credential.
  if (!callerHasSessionSlot(req)) {
    return sendSuccess(res, 200, { revoked: true });
  }

  // Issue a fresh token at the new tokenVersion so the active session survives —
  // a new interactive slot (every old slot was just cleared), carrying the
  // caller's own assurance, scope and permission restriction (never widened).
  const tokens = await issueTokens(user, user.lastActiveOrgId?.toString(), {
    kind: 'interactive',
    auth: { ...authFromClaims(req.user), ...(callerSlot ? slotAuthContext(callerSlot) : {}) },
    client: clientInfoOf(req),
    ...callerRestriction(req),
  });
  // The surviving session's cookie is replaced here, so "sign out everywhere"
  // leaves THIS browser signed in exactly as it did before.
  sendSuccess(res, 200, { revoked: true, ...deliverSessionTokens(req, res, tokens) });
}, userErrorMap);
