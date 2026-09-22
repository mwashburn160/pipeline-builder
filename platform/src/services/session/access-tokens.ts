// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Access-token claims and the short-lived tokens that are not session pairs:
 * the assurance a sign-in earns, the org-assurance chokepoint every user
 * credential passes, and the access-key, service-account, impersonation and
 * step-up tokens.
 */

import crypto from 'crypto';
import { API_KEY_TOKEN_TTL_SECONDS, confinePermissionsToOrg, createLogger, intersectPermissions, isSystemOrgId, resolveUserFeatures, resolveUserPermissions } from '@pipeline-builder/api-core';
import type { AssuranceLevel, AuthMethod, TokenScope, TokenUse, QuotaTier } from '@pipeline-builder/api-core';
import { resolveOrgMembership, type MembershipContext } from './membership-context.js';
import { config } from '../../config/index.js';
import { IMPERSONATION_SESSION_TTL_MS } from '../../constants/impersonation.js';
import { accessTokenVersion } from '../../helpers/access-version.js';
import { applyAuthenticatorPolicy } from '../../helpers/authenticator-policy.js';
import { isAncestorOrg } from '../../helpers/org-hierarchy.js';
import type { OrgMemberRole } from '../../models/user-organization.js';
import type { UserDocument } from '../../models/user.js';
import type { AccessTokenPayload } from '../../types/index.js';
import { MFA_REQUIRED_FOR_ORG, SESSION_AUTH_MISSING } from '../auth-errors.js';
import { signUserJwt } from '../token-signing/index.js';

const logger = createLogger('token');

/**
 * How the person behind a session authenticated — the `amr` / `aal` /
 * `auth_time` claims. Fixed when a session (or PAT / impersonation token) is
 * opened and copied verbatim on every refresh, renewal and switch-org, so none
 * of those can raise the assurance level or reset the sign-in time.
 */
export interface SessionAuth {
  amr: AuthMethod[];
  aal: AssuranceLevel;
  authTime: Date;
  /**
   * The authenticator model (AAGUID) of the passkey that opened a `webauthn`
   * session. Kept on the session slot so an org's authenticator allowlist is
   * re-applied at EVERY issuance — sign-in, refresh and switch-org alike — and
   * a passkey the org does not trust can never carry `aal: 2` into it (see
   * {@link applyAuthenticatorPolicy}). Absent for every other method.
   */
  aaguid?: string;
  /**
   * The org whose OWN statement ("our IdP enforces MFA", `idpEnforcesMfa`)
   * earned this session its `aal: 2` — set only for such an SSO sign-in. That
   * statement is the org's about the provider IT administers, so it vouches for
   * nothing outside its lineage: every issuance scoped to an org that is
   * neither it nor one of its teams carries `aal: 1` (see
   * {@link enforceOrgAssurance}). Kept on the slot (and on a key minted from
   * it) so refresh, switch-org and key exchange all re-apply it.
   */
  aalAssertedBy?: string;
}

/**
 * The auth context of a sign-in happening NOW via `method`.
 *
 * `mfa: true` appends the `mfa` method — a password sign-in that also presented
 * an authenticator-app code (or a recovery code) reads as `['pwd', 'mfa']`.
 *
 * ASSURANCE is decided here, at the one place a sign-in is described, so
 * every caller gets the same answer and no controller can assert a level of its
 * own. `aal: 2` for exactly three cases:
 *   - `webauthn` — a passkey assertion, which the WebAuthn service verifies with
 *     user verification REQUIRED, so the credential and the person were both
 *     checked;
 *   - `mfa: true` — a password (or provider) sign-in plus an authenticator-app
 *     code or a recovery code;
 *   - `idpMfaOrgId` — SSO through an IdP that org has marked as enforcing MFA.
 *     Providers don't send `amr` reliably, so the org's statement about its own
 *     provider is the evidence (see `Organization.idpEnforcesMfa`) — and it is
 *     RECORDED as `aalAssertedBy`, because it holds only inside that org's
 *     lineage.
 * Everything else — a password alone, a social sign-in, SSO through an unmarked
 * IdP — is `aal: 1`.
 */
export function signInAuth(
  method: Exclude<AuthMethod, 'stepup' | 'mfa'>,
  opts: { mfa?: boolean; idpMfaOrgId?: string } = {},
): SessionAuth {
  const intrinsic = method === 'webauthn' || opts.mfa === true;
  const orgAsserted = !intrinsic && !!opts.idpMfaOrgId;
  const aal: AssuranceLevel = intrinsic || orgAsserted ? 2 : 1;
  return {
    amr: opts.mfa ? [method, 'mfa'] : [method],
    aal,
    authTime: new Date(),
    ...(orgAsserted ? { aalAssertedBy: opts.idpMfaOrgId } : {}),
  };
}

/**
 * The auth context carried by an already-verified user token, for a credential
 * derived from it (a machine session, PAT, impersonation token or re-issued
 * session). Inherits — never raises — the caller's assurance. Throws
 * `SESSION_AUTH_MISSING` when the claims are absent (fail closed; requireAuth
 * already refuses such tokens).
 */
export function authFromClaims(claims: { amr?: AuthMethod[]; aal?: AssuranceLevel; auth_time?: number } | undefined): SessionAuth {
  if (!claims || !Array.isArray(claims.amr) || (claims.aal !== 1 && claims.aal !== 2) || typeof claims.auth_time !== 'number') {
    throw new Error(SESSION_AUTH_MISSING);
  }
  return { amr: [...claims.amr], aal: claims.aal, authTime: new Date(claims.auth_time * 1000) };
}

/** What a user access token is minted for, beyond the user + membership. */
export interface AccessTokenOptions {
  auth: SessionAuth;
  tokenUse: TokenUse;
  scope?: TokenScope;
  /**
   * Permission SUBSET the credential was created with (a permission-scoped PAT
   * or machine token). The token carries the intersection of this list and the
   * holder's current permissions — see {@link createAccessTokenPayload}.
   */
  permissions?: readonly string[];
  sessionId?: string;
  /** Bootstrap-admin enrolment session — see `JwtPayload.mfaEnrollmentPending`. */
  mfaEnrollmentPending?: boolean;
}

/**
 * Build an access token JWT payload from a user document and optional membership.
 *
 * When `scope` is set the token is a narrow MACHINE identity (e.g. the
 * `reporting:ingest` credential stored in a client AWS account): it is forced to
 * least-privilege — `role: 'member'`, no `isSuperAdmin`, no feature flags — and
 * carries the `scope` claim so scoped endpoints can accept it while every other
 * gate treats it as a plain member. This is critical: a scoped token minted by a
 * super-admin operator must NOT inherit super-admin authority.
 */
export function createAccessTokenPayload(
  user: UserDocument,
  membership: MembershipContext | undefined,
  { auth, tokenUse, scope, permissions: subset, sessionId, mfaEnrollmentPending }: AccessTokenOptions,
): AccessTokenPayload {
  // A PERMISSION-SCOPED credential is narrowed exactly like a capability-scoped
  // one on the two claims that would otherwise bypass its subset: an admin
  // `role` (`isAdmin` gates) and `isSuperAdmin` (implicit-all). Its permissions
  // are then the INTERSECTION of the subset and what the holder holds TODAY —
  // re-derived at every issue, so a lost Role shrinks it and nothing grows it.
  const restricted = !scope && subset !== undefined;
  const role = scope || restricted ? 'member' : (membership?.role ?? 'member');
  const tier: QuotaTier = membership?.tier ?? 'developer';
  const holderIsSuperAdmin = user.isSuperAdmin === true;
  const isSuperAdmin = scope || restricted ? false : holderIsSuperAdmin;
  const overrides = user.featureOverrides
    ? Object.fromEntries(user.featureOverrides as Map<string, boolean>)
    : undefined;
  return {
    type: 'access',
    sub: user._id.toString(),
    principalType: 'user',
    token_use: tokenUse,
    amr: auth.amr,
    aal: auth.aal,
    auth_time: Math.floor(auth.authTime.getTime() / 1000),
    organizationId: membership?.organizationId,
    ...(membership?.organizationName && { organizationName: membership.organizationName }),
    // Org → team hierarchy claims — only present when the active org actually
    // has a parent, so flat-org tokens are byte-identical to before.
    ...(membership?.parentOrganizationId && { parentOrganizationId: membership.parentOrganizationId }),
    ...(membership?.rootOrganizationId && { rootOrganizationId: membership.rootOrganizationId }),
    username: user.username,
    email: user.email,
    role,
    isAdmin: role === 'admin' || role === 'owner',
    // Carry the global super-admin flag through the JWT so downstream auth
    // gates (`isSystemAdmin`) can honor it without re-reading the user
    // record on every request. Only set when true to keep the payload
    // small for non-sysadmin users (the vast majority). NEVER on a scoped token.
    ...(isSuperAdmin ? { isSuperAdmin: true } : {}),
    tier,
    // A scoped machine token needs no feature flags; interactive users get their
    // tier defaults plus per-user overrides.
    features: scope ? [] : resolveUserFeatures(tier, { overrides, isSuperAdmin, accountFeatures: membership?.featureEntitlements }),
    // Fine-grained RBAC (single-source): effective permissions = the union of
    // the permissions carried by every Role assigned to the user in the active
    // org (superadmin ⇒ all). `rolePermissions` is already that union — there
    // is no role-derived baseline. Enforced downstream via requirePermission().
    // Scoped machine tokens carry none (least privilege).
    // Permission-scoped credentials: subset ∩ current (see above). The holder's
    // superadmin flag still counts toward "current" — it is the SUBSET that
    // bounds the token, never the flag.
    // System-org-only ecosystem permissions (`plugins:moderate`,
    // `publishers:verify`) are confined to the SYSTEM org: a token minted in any
    // tenant org never claims them — not even a superadmin's implicit-all
    // (docs/permissions.md).
    permissions: scope
      ? []
      : confinePermissionsToOrg(
        restricted
          ? intersectPermissions(resolveUserPermissions(membership?.rolePermissions, holderIsSuperAdmin), subset!)
          : resolveUserPermissions(membership?.rolePermissions, isSuperAdmin),
        isSystemOrgId(membership?.organizationId),
      ),
    ...(scope ? { scope } : {}),
    ...(restricted ? { permissionsRestricted: true } : {}),
    tokenVersion: accessTokenVersion(user),
    isEmailVerified: user.isEmailVerified,
    // Org policy "require MFA", decided at issuance and carried so that no
    // service looks it up. Only ever `true`: an absent claim is the common case.
    ...(membership?.mfaRequired ? { mfaRequired: true } : {}),
    // Org policy "administrative actions require MFA", decided at issuance so
    // services that can't read the org enforce it (`requireOrgAdminAssurance`).
    // Carried on PATs too: each route decides whether a machine may pass.
    ...(membership?.adminActionsRequireMfa ? { org_admin_aal: 2 as const } : {}),
    // Bootstrap-admin enrolment session — the narrow, self-closing exception.
    ...(mfaEnrollmentPending ? { mfaEnrollmentPending: true } : {}),
    // The refresh-session slot this token was minted with — logout and
    // switch-org act on that slot. Absent on PATs and impersonation tokens.
    ...(sessionId ? { sid: sessionId } : {}),
  };
}

/**
 * The access-token lifetime for a session scoped to `tier`: the per-tier
 * override, else the global default. This is the CEILING for every session
 * access token — interactive and machine alike. A machine credential's long
 * life is its SLOT's (`RefreshSession.expiresAt`), renewed through its refresh
 * token; its access tokens are never longer-lived than a person's, so a
 * revocation entry sized to this lifetime can never lapse under a live token.
 */
export function accessTokenTtlSeconds(tier: QuotaTier | undefined): number {
  const tierExpiresIn = tier ? config.auth.jwt.tierExpiresIn[tier] : undefined;
  return tierExpiresIn ?? config.auth.jwt.expiresIn;
}

/** Whether the asserting org's statement reaches `activeOrgId` (it, or one of its teams). */
async function withinAssertingLineage(assertingOrgId: string, activeOrgId: string | undefined): Promise<boolean> {
  if (!activeOrgId) return false;
  if (activeOrgId === assertingOrgId) return true;
  try {
    return await isAncestorOrg(assertingOrgId, activeOrgId);
  } catch (error) {
    // Fail CLOSED on assurance: understating the level is always safe.
    logger.warn('Lineage read failed; counting org-asserted assurance as aal 1', { assertingOrgId, activeOrgId, error });
    return false;
  }
}

/**
 * The assurance a credential carries IN its active org — and the refusal when
 * that org requires more. The ONE enforcement point for every user credential:
 * session issuance (`mintTokens`: sign-in, refresh, renewal, switch-org) AND the
 * access-key exchange (`api-key-service.exchange`), so a key minted before an
 * org enabled "require MFA" can't outlive the policy it predates.
 *
 * ORG AUTHENTICATOR ALLOWLIST — applied first, so a passkey the active org does
 * not trust is `aal: 1` in that org on every issuance path. It still identifies
 * the person; it just can't satisfy the org's MFA requirement.
 *
 * ORG-ASSERTED ASSURANCE — an `aal: 2` earned only by an org's word about its
 * own IdP (`aalAssertedBy`) is `aal: 1` in any org outside that org's lineage
 * (it, or one of its teams): one org cannot vouch for a session elsewhere.
 *
 * ORG POLICY "REQUIRE MFA" — a credential scoped to an org past its grace
 * period either carries `aal: 2` or is not minted at all (`MFA_REQUIRED_FOR_ORG`).
 * Refusing here rather than per route is what makes the policy total: it covers
 * routes that don't exist yet, and services that never learn the policy exists.
 *
 * Three carve-outs, all deliberate:
 *   - a SCOPED machine credential (`reporting:ingest` and friends) is not a
 *     person's session; refusing it would take an org's automation down the
 *     moment an admin enabled the policy, and such a token is already
 *     least-privilege and refused by every `minAssurance` gate;
 *   - the BOOTSTRAP-ADMIN enrolment session, which exists precisely so the
 *     person can go and earn `aal: 2` (and cannot reach anything else);
 *   - a PER-USER RESET GRACE (`mfaResetGraceUntil`), set when an MFA reset
 *     was approved: the person has no factor left and must be able to sign in
 *     to enrol a new one. It exempts THIS person only, for a bounded window,
 *     from the org's policy — own or inherited — instead of weakening the org.
 */
export async function enforceOrgAssurance(
  user: Pick<UserDocument, 'mfaResetGraceUntil'>,
  membership: MembershipContext | undefined,
  sessionAuth: SessionAuth,
  opts: { scope?: TokenScope; mfaEnrollmentPending?: boolean } = {},
): Promise<SessionAuth> {
  let auth = membership
    ? await applyAuthenticatorPolicy(sessionAuth, membership.organizationId)
    : sessionAuth;
  // ORG-ASSERTED ASSURANCE holds only inside the asserting org's lineage.
  if (auth.aalAssertedBy && auth.aal === 2 && !(await withinAssertingLineage(auth.aalAssertedBy, membership?.organizationId))) {
    auth = { ...auth, aal: 1 };
  }
  if (membership?.mfaEnforced && !opts.scope && !opts.mfaEnrollmentPending && auth.aal < 2 && !inResetGrace(user)) {
    throw new Error(MFA_REQUIRED_FOR_ORG);
  }
  return auth;
}

/** Whether `user` is inside an approved MFA reset's enrolment grace. */
function inResetGrace(user: Pick<UserDocument, 'mfaResetGraceUntil'>, now: Date = new Date()): boolean {
  const until = user.mfaResetGraceUntil;
  return !!until && new Date(until).getTime() > now.getTime();
}

/**
 * Sign the SHORT-LIVED token an opaque access key is exchanged for
 * (`POST /auth/token/exchange`).
 *
 * Same claims as a session access token — so it carries the user's real org
 * permissions — but `token_use: 'api_key'`, `jti` = the key's id, and a
 * {@link API_KEY_TOKEN_TTL_SECONDS} lifetime. `auth` is the assurance recorded
 * when the key was created (inherited, never raised); when `scope` is set the
 * token is forced to least-privilege, and when `permissions` (the key's subset)
 * is set it carries only subset ∩ the user's current permissions (see
 * {@link createAccessTokenPayload}).
 *
 * Claims are re-derived from the user + membership on EVERY exchange, so a
 * privilege reduction reaches the key within one token lifetime — there is no
 * baked-in authority to re-validate per request, and no refresh token or
 * `issuedTokens` history entry (the key's record is its identity, not a session
 * slot).
 *
 * `membership` is resolved by the caller so it can refuse to issue at all when
 * the org the key was minted against is gone (fail closed rather than quietly
 * handing back an org-less token).
 */
export async function signApiKeyToken(
  user: UserDocument,
  membership: MembershipContext | undefined,
  keyId: string,
  auth: SessionAuth,
  scope?: TokenScope,
  permissions?: readonly string[],
  expiresInSeconds: number = API_KEY_TOKEN_TTL_SECONDS,
): Promise<string> {
  const payload: AccessTokenPayload = {
    ...createAccessTokenPayload(user, membership, { auth, tokenUse: 'api_key', scope, permissions }),
    jti: keyId,
  };
  return signUserJwt(payload, { expiresIn: expiresInSeconds });
}

/** What a SERVICE ACCOUNT's exchanged token speaks for (resolved per exchange). */
export interface ServiceAccountTokenContext {
  /** Service-account record id — the token's `sub`. */
  id: string;
  /** Machine name (the `username` claim; also how audit rows read). */
  name: string;
  /** Owning org id + name. A service account is ALWAYS org-scoped. */
  organizationId: string;
  organizationName?: string;
  /** Org → team hierarchy claims of the owning org (omitted for a flat org). */
  parentOrganizationId?: string;
  rootOrganizationId?: string;
  tier?: QuotaTier;
  /** Account-level purchased entitlements of the owning account. */
  featureEntitlements?: readonly string[];
  /** Union of the permissions carried by the Roles the account holds. */
  rolePermissions: readonly string[];
  /** Coarse label derived from those Roles (`admin` when one grants admin). */
  role: OrgMemberRole;
  /** True only when the account holds a `superadmin`-granting Role (system org,
   *  assignable by a platform superadmin alone). */
  isSuperAdmin: boolean;
}

/**
 * Sign the short-lived token a SERVICE-ACCOUNT key (`pb_sa_…`) is exchanged for.
 *
 * Deliberately NOT built through {@link createAccessTokenPayload}: that helper
 * speaks for a `UserDocument`, and a service account has none — no password, no
 * sessions, no `tokenVersion`. The claims here are re-derived from the account,
 * its Roles and its org on EVERY exchange, so a role change or a disabled
 * account takes effect within one token lifetime.
 *
 * Machine-identity properties baked in on purpose:
 *   - `principalType: 'service_account'` + `token_use: 'api_key'` — the two
 *     claims every human-only gate branches on;
 *   - `amr: []` and `aal: 1` — there is no human authentication to inherit, so
 *     the token can never satisfy a method-specific assurance requirement (and
 *     `requireStepUp` refuses it outright);
 *   - `jti` = the key's id, so "what did key X do" is answerable from audit;
 *   - no `tokenVersion` and no `sid` — the account + key records are the
 *     identity, and revoking either stops it.
 */
export async function signServiceAccountToken(
  account: ServiceAccountTokenContext,
  keyId: string,
  scope?: TokenScope,
  expiresInSeconds: number = API_KEY_TOKEN_TTL_SECONDS,
): Promise<string> {
  const tier: QuotaTier = account.tier ?? 'developer';
  const payload: AccessTokenPayload = {
    type: 'access',
    sub: account.id,
    principalType: 'service_account',
    token_use: 'api_key',
    amr: [],
    aal: 1,
    auth_time: Math.floor(Date.now() / 1000),
    username: account.name,
    // RFC 2606 reserved TLD: a service account has no mailbox, and this address
    // can never collide with (or be mistaken for) a person's.
    email: `${account.name}@service-account.invalid`,
    organizationId: account.organizationId,
    ...(account.organizationName ? { organizationName: account.organizationName } : {}),
    ...(account.parentOrganizationId ? { parentOrganizationId: account.parentOrganizationId } : {}),
    ...(account.rootOrganizationId ? { rootOrganizationId: account.rootOrganizationId } : {}),
    role: scope ? 'member' : account.role,
    isAdmin: !scope && (account.role === 'admin' || account.role === 'owner'),
    ...(!scope && account.isSuperAdmin ? { isSuperAdmin: true } : {}),
    tier,
    // A scoped key is least-privilege (no features, no permissions), exactly as
    // for a scoped user token; an unscoped one gets the org's resolved features.
    features: scope ? [] : resolveUserFeatures(tier, {
      isSuperAdmin: account.isSuperAdmin,
      accountFeatures: account.featureEntitlements,
    }),
    permissions: scope ? [] : confinePermissionsToOrg(
      resolveUserPermissions(account.rolePermissions, account.isSuperAdmin),
      isSystemOrgId(account.organizationId),
    ),
    ...(scope ? { scope } : {}),
    // Service accounts have no email identity to verify; every route that gates
    // on verification is a human-onboarding route.
    isEmailVerified: true,
    jti: keyId,
  };
  return signUserJwt(payload, { expiresIn: expiresInSeconds });
}

/**
 * Issue an access token that grants `impersonator` the identity of
 * `target`. The token carries `impersonatorId` (so audit events still
 * attribute the sysadmin) and `impersonationReadOnly: true` (so the
 * `requireWriteAccess` middleware blocks state-changing requests).
 *
 * No refresh token is issued — impersonation is intentionally
 * short-lived. The caller is responsible for storing the token client-
 * side and clearing it on "Stop impersonating".
 *
 * `orgId` PINS the session to one organization and is resolved STRICTLY: if the
 * target has no live membership there, the token is issued with no org context
 * rather than silently landing on some other org they happen to belong to. That
 * differs deliberately from the login path (`resolveMembership`), which falls
 * back so a user whose active org was soft-deleted still lands somewhere — the
 * right behaviour when a person is signing in, the wrong one when an operator
 * asked to view a specific organization. The pin is the org the request (and,
 * under a consent policy, its approval) was for.
 */
export async function issueImpersonationToken(
  target: UserDocument,
  impersonatorId: string,
  orgId: string | undefined,
  jti: string,
  auth: SessionAuth,
  ttlSeconds = IMPERSONATION_SESSION_TTL_MS / 1000,
): Promise<{ accessToken: string; expiresIn: number }> {
  let membership: MembershipContext | undefined;
  try {
    membership = orgId ? await resolveOrgMembership(target._id.toString(), orgId) : undefined;
  } catch (err) {
    logger.warn('Impersonation: failed to resolve target membership', { orgId, error: err });
  }

  // `jti` identifies THIS session so it can be revoked on its own. The
  // `impersonatorId` claim is what routes it to the impersonation record; a PAT
  // is recognised by `token_use: 'api_key'`, never by carrying a `jti`. `auth` is
  // the OPERATOR's sign-in (the one whose authority this session rides on).
  const payload = {
    ...createAccessTokenPayload(target, membership, { auth, tokenUse: 'access' }),
    impersonatorId,
    impersonationReadOnly: true,
    jti,
  };
  const accessToken = await signUserJwt(payload, { expiresIn: ttlSeconds });
  return { accessToken, expiresIn: ttlSeconds };
}

/** How a step-up token was earned: the account password, a passkey assertion
 *  with user verification, an authenticator-app code (or recovery code), or a
 *  fresh sign-in with the user's own linked OAuth/SSO provider. */
export type StepUpMethod = 'password' | 'webauthn' | 'totp' | 'reauth';

/**
 * Sign a short-lived step-up token bound to `userId` (default 60s TTL). Issued
 * by POST /api/auth/step-up (password), POST /api/auth/step-up/webauthn/verify
 * (passkey), POST /api/auth/step-up/totp (authenticator code) or the provider
 * re-auth callback (POST /api/auth/step-up/reauth/callback) once the caller
 * re-verifies, and replayed as `X-Step-Up-Token` on routes behind api-core's
 * `requireStepUp`, which verifies the `type: 'step-up'` + `jti` claims, binds
 * `sub` to the caller and consumes the `jti` once.
 *
 * A TOTP or PASSKEY step-up additionally carries `mfa` in `amr`: those are the
 * two methods that prove possession of a second factor, and that is
 * readable — `requireStepUp({ methods: STRONG_STEP_UP_METHODS })` admits exactly
 * these two on the most dangerous routes, where re-typing the password the
 * session was already opened with proves nothing new.
 */
export async function issueStepUpToken(
  userId: string,
  method: StepUpMethod,
  ttlSeconds = 60,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = {
    type: 'step-up' as const,
    sub: userId,
    amr: (method === 'totp' || method === 'webauthn' ? ['stepup', 'mfa'] : ['stepup']) as AuthMethod[],
    // How the step-up was earned — recorded for audit (and later assurance
    // decisions). requireStepUp ignores it: every method yields the same gate.
    method,
    jti: crypto.randomBytes(8).toString('hex'),
  };
  const token = await signUserJwt(payload, { expiresIn: ttlSeconds });
  return { token, expiresAt };
}
