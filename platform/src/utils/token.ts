// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import { API_KEY_TOKEN_TTL_SECONDS, createLogger, resolveUserFeatures, resolveUserPermissions } from '@pipeline-builder/api-core';
import type { AssuranceLevel, AuthMethod, TokenScope, TokenUse, QuotaTier } from '@pipeline-builder/api-core';
import jwt from 'jsonwebtoken';
import type { Types } from 'mongoose';
import { verifyPlatformJwt, verifyRefreshJwt } from './jwt-options.js';
import { config } from '../config/index.js';
import { IMPERSONATION_SESSION_TTL_MS } from '../constants/impersonation.js';
import type { ClientInfo } from '../helpers/client-info.js';
import { resolveOrgLineage } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
import { User, Organization, UserOrganization, Role, RoleAssignment } from '../models/index.js';
import type { OrgMemberRole } from '../models/user-organization.js';
import type { RefreshSession, RefreshSessionKind, UserDocument } from '../models/user.js';
import { SESSION_AUTH_MISSING, TOKEN_SCOPE_ESCALATION } from '../services/auth-errors.js';
import { signUserJwt } from '../services/token-signing/index.js';
import type { AccessTokenPayload, RefreshTokenPayload } from '../types/index.js';

const logger = createLogger('token');

/** Membership context for token payload. */
export interface MembershipContext {
  organizationId: string;
  organizationName?: string;
  role: OrgMemberRole;
  tier?: QuotaTier;
  /** Org → team hierarchy: direct parent of the active org (omitted for root orgs). */
  parentOrganizationId?: string;
  /** Org → team hierarchy: root of the active org's ancestry chain (omitted for root orgs). */
  rootOrganizationId?: string;
  /** Account-level purchased feature entitlements (bundles), propagated onto the
   *  active org; unioned into the resolved feature set. */
  featureEntitlements?: readonly string[];
  /** Fine-grained permissions granted by the Roles the user holds in the active
   *  org — the union of those Roles' `permissions[]`. This IS the JWT
   *  `permissions` claim (single-source; superadmin ⇒ all). */
  rolePermissions?: readonly string[];
}

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
}

/**
 * The auth context of a sign-in happening NOW via `method`.
 *
 * `mfa: true` appends the `mfa` method — a password sign-in that also presented
 * an authenticator-app code (or a recovery code) reads as `['pwd', 'mfa']`. The
 * assurance LEVEL stays 1 for now: raising it is #8's job (it defines what aal 2
 * means and which routes may demand it), and a token claiming aal 2 before any
 * gate understands it would be a claim nothing verifies.
 */
export function signInAuth(method: Exclude<AuthMethod, 'stepup' | 'mfa'>, opts: { mfa?: boolean } = {}): SessionAuth {
  return { amr: opts.mfa ? [method, 'mfa'] : [method], aal: 1, authTime: new Date() };
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
interface AccessTokenOptions {
  auth: SessionAuth;
  tokenUse: TokenUse;
  scope?: TokenScope;
  sessionId?: string;
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
function createAccessTokenPayload(
  user: UserDocument,
  membership: MembershipContext | undefined,
  { auth, tokenUse, scope, sessionId }: AccessTokenOptions,
): AccessTokenPayload {
  const role = scope ? 'member' : (membership?.role ?? 'member');
  const tier: QuotaTier = membership?.tier ?? 'developer';
  const isSuperAdmin = scope ? false : user.isSuperAdmin === true;
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
    permissions: scope ? [] : resolveUserPermissions(membership?.rolePermissions, isSuperAdmin),
    ...(scope ? { scope } : {}),
    tokenVersion: user.tokenVersion,
    isEmailVerified: user.isEmailVerified,
    // The refresh-session slot this token was minted with — logout and
    // switch-org act on that slot. Absent on PATs and impersonation tokens.
    ...(sessionId ? { sid: sessionId } : {}),
  };
}

/**
 * Most INTERACTIVE refresh-session slots (signed-in devices) a user keeps.
 * Opening a new one beyond this evicts the OLDEST interactive slot (push order).
 * Machine slots are counted separately and are never evicted by a sign-in.
 */
export const MAX_REFRESH_SESSIONS = 10;

/**
 * Most MACHINE slots (stored credentials from generate-token) a user keeps.
 * Opening a new one beyond this evicts the LEAST RECENTLY USED machine slot, so
 * a credential renewed daily is never dropped while abandoned ones are.
 */
export const MAX_MACHINE_SESSIONS = 10;

/**
 * Sign a refresh token for one session slot. The random `jti` makes every
 * rotation produce a distinct token (and hash), even within the same second.
 *
 * Signed with platform's ES256 key like every other user token — a refresh
 * token is a person's credential, so it gets no secret of its own.
 */
async function generateRefreshToken(user: UserDocument, sessionId: string): Promise<string> {
  const payload: RefreshTokenPayload = {
    type: 'refresh',
    sub: user._id.toString(),
    tokenVersion: user.tokenVersion,
    sid: sessionId,
    jti: crypto.randomBytes(8).toString('hex'),
  };
  return signUserJwt(payload as unknown as Record<string, unknown>, { expiresIn: config.auth.refreshToken.expiresIn });
}

/**
 * Hash a refresh token using SHA-256 for secure storage.
 */
export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Shape returned by {@link issueTokens}. */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Raw permission strings granted by a user's Roles in an org (deduped).
 * Kept inline (rather than importing roles-service) so token issuance has a
 * minimal dependency graph. api-core's `resolveUserPermissions` filters out any
 * unknown strings downstream, so no validation is needed here.
 */
async function rolePermissionsFor(userId: string, organizationId: Types.ObjectId | string): Promise<string[]> {
  const assignments = await RoleAssignment.find({ userId, organizationId }).session(null).select('roleId').lean();
  const roleIds = assignments.map((m) => m.roleId);
  if (roleIds.length === 0) return [];
  const roles = await Role.find({ _id: { $in: roleIds } }).session(null).select('permissions').lean();
  const perms = new Set<string>();
  for (const g of roles) for (const p of ((g.permissions as string[]) ?? [])) perms.add(p);
  return [...perms];
}

/**
 * Membership context for ONE specific org, or `undefined` when the user has no
 * live membership there. No fallback to any other org — see
 * {@link resolveMembership} for the login path that does fall back, and
 * {@link issueImpersonationToken} for the caller that must NOT.
 */
async function resolveOrgMembership(userId: string, orgId: string): Promise<MembershipContext | undefined> {
  const membership = await UserOrganization.findOne({ userId, organizationId: toOrgId(orgId), isActive: true }).lean();
  if (!membership) return undefined;
  const org = await Organization.findById(toOrgId(orgId)).select('name tier parentOrgId featureEntitlements deletedAt').lean();
  // CHOKEPOINT: refuse to scope a token to a SOFT-DELETED org. The org is
  // being torn down (retention window) — treat it as gone. Combined with the
  // tokenVersion bump on soft-delete, this cuts off ALL access to the org
  // without any per-read `deletedAt` filtering elsewhere.
  if (!org || org.deletedAt) return undefined;
  return {
    organizationId: orgId,
    organizationName: org.name,
    role: membership.role as OrgMemberRole,
    tier: org.tier,
    rolePermissions: await rolePermissionsFor(userId, toOrgId(orgId)),
    ...(await accountContext(orgId, org)),
  };
}

/**
 * Resolve the membership context for a user's active organization: the pinned
 * `activeOrgId` when it is still a live membership, else the earliest active
 * membership whose org is live. A user whose active org was just soft-deleted
 * lands on another live org (or nothing), never back on the dying one.
 */
async function resolveMembership(userId: string, activeOrgId?: string): Promise<MembershipContext | undefined> {
  if (activeOrgId) {
    const pinned = await resolveOrgMembership(userId, activeOrgId);
    if (pinned) return pinned;
  }
  const memberships = await UserOrganization.find({ userId, isActive: true }).sort({ joinedAt: 1 }).lean();
  for (const m of memberships) {
    const orgId = m.organizationId.toString();
    if (orgId === activeOrgId) continue; // already tried above
    const context = await resolveOrgMembership(userId, orgId);
    if (context) return context;
  }
  return undefined;
}

/**
 * Resolve the account-level context a token bakes in for its active org: the
 * authoritative `featureEntitlements` set PLUS the org → team hierarchy claims.
 *
 * `featureEntitlements` and the tier POOL AT THE ACCOUNT ROOT; billing writes
 * them there and the platform propagates them onto descendant teams. A team's
 * own doc therefore carries only a DENORMALIZED copy that can lag propagation
 * (concurrent team-create, a partially-applied propagation write). To keep the
 * JWT structurally drift-proof we read the entitlements from the ROOT for a
 * parented org — mirroring `pooledFeatureEntitlements` — rather than trusting
 * the active team doc's copy.
 *
 * When the active org is flat (no `parentOrgId`, the case for every org today)
 * the active doc IS the root: its own `featureEntitlements` are authoritative,
 * no hierarchy claims apply, and this costs NO extra DB round-trip. Only a
 * parented org pays a single lineage walk ({@link resolveOrgLineage}) — reused
 * for both the hierarchy claims and the root entitlement read.
 */
async function accountContext(
  orgId: string,
  org: { parentOrgId?: string | null; featureEntitlements?: string[] },
): Promise<{
    featureEntitlements?: readonly string[];
    parentOrganizationId?: string;
    rootOrganizationId?: string;
  }> {
  // Flat/root org: the active doc is the root — trust its own copy, no read.
  if (!org.parentOrgId) return { featureEntitlements: org.featureEntitlements };

  // Parented org (team): resolve lineage ONCE, then read the ROOT's authoritative
  // entitlements (drift-proof) and derive the hierarchy claims from the same walk.
  const lineage = await resolveOrgLineage(orgId);
  // The ROOT read is a NEWLY-INTRODUCED failure surface for a team login (before
  // drift-proofing a team never read the root). A transient root-read blip must
  // NOT propagate out — resolveMembership's caller (`issueTokens`) would then
  // swallow it and strand the member with NO org context (default developer /
  // no-perms), a far worse outcome than slightly-stale entitlements. So GRACEFULLY
  // DEGRADE to the team doc's own denormalized `featureEntitlements` (already in
  // hand) — the JWT carries the possibly-stale team-doc set rather than collapsing
  // the whole membership. The hierarchy claims still ride the same lineage walk.
  let featureEntitlements: readonly string[] = org.featureEntitlements ?? [];
  try {
    const root = await Organization.findById(toOrgId(lineage.rootOrgId))
      .select('featureEntitlements').lean();
    featureEntitlements = (root as { featureEntitlements?: string[] })?.featureEntitlements ?? [];
  } catch (error) {
    logger.warn('accountContext: root featureEntitlements read failed; degrading to team-doc copy', {
      orgId,
      rootOrgId: lineage.rootOrgId,
      error,
    });
  }
  return {
    featureEntitlements,
    ...(lineage.parentOrgId && { parentOrganizationId: lineage.parentOrgId }),
    ...(lineage.rootOrgId !== orgId && { rootOrganizationId: lineage.rootOrgId }),
  };
}

/** A signed token pair plus what the caller persists for it. */
interface MintedTokens {
  tokens: IssuedTokens;
  refreshHash: string;
  /** `issuedTokens` history entry (ring-buffered to the 20 most recent). */
  historyEntry: { id: string; createdAt: Date; expiresAt: Date; tokenVersionAtIssue: number };
}

/**
 * Resolve the active membership and sign an access + refresh token pair for
 * refresh-session slot `sessionId`. Persists nothing.
 *
 * The access token carries:
 * - `role`: the user's per-org role ('owner' | 'admin' | 'member')
 * - `isAdmin`: derived as `role === 'admin' || role === 'owner'`
 * - `organizationId` / `organizationName`: the active org context
 * - `sid`: the session slot
 *
 * Falls back to `user.lastActiveOrgId`, then the user's earliest active membership.
 */
async function mintTokens(
  user: UserDocument,
  sessionId: string,
  activeOrgId: string | undefined,
  auth: SessionAuth,
  expiresIn?: number,
  scope?: TokenScope,
): Promise<MintedTokens> {
  let membership: MembershipContext | undefined;
  try {
    membership = await resolveMembership(
      user._id.toString(),
      activeOrgId || user.lastActiveOrgId?.toString(),
    );
  } catch (error) {
    logger.warn('Failed to resolve membership for token', { error });
  }

  // Resolution order: caller override → per-tier override → global default.
  // The per-tier path lets compliance-driven customers (enterprise tiers)
  // narrow the stolen-token blast window without forcing every user to
  // re-auth more often.
  const tier = membership?.tier;
  const tierExpiresIn = tier ? config.auth.jwt.tierExpiresIn[tier] : undefined;
  const tokenExpiresIn = expiresIn ?? tierExpiresIn ?? config.auth.jwt.expiresIn;

  const accessToken = await signUserJwt(
    createAccessTokenPayload(user, membership, { auth, tokenUse: 'access', scope, sessionId }) as unknown as Record<string, unknown>,
    { expiresIn: tokenExpiresIn },
  );
  const refreshToken = await generateRefreshToken(user, sessionId);

  const now = new Date();
  return {
    tokens: { accessToken, refreshToken, expiresIn: tokenExpiresIn },
    refreshHash: hashRefreshToken(refreshToken),
    historyEntry: {
      id: crypto.randomBytes(8).toString('hex'),
      createdAt: now,
      expiresAt: new Date(now.getTime() + tokenExpiresIn * 1000),
      tokenVersionAtIssue: user.tokenVersion,
    },
  };
}

/** A new refresh-session slot to open. */
export interface NewSession {
  kind: RefreshSessionKind;
  /** How the person authenticated (see {@link signInAuth} / {@link authFromClaims}). */
  auth: SessionAuth;
  /** Device details of the opening request. */
  client?: ClientInfo;
  /** Access-token lifetime in seconds (default: per-tier, then config.auth.jwt.expiresIn). */
  expiresIn?: number;
  /** Narrow capability scope (least-privilege machine token), fixed for the slot's life. */
  scope?: TokenScope;
}

/**
 * The aggregation-pipeline expression for `refreshSessions` after adding
 * `slot`, applying the cap for its kind to that kind only:
 * - interactive: keep the newest `MAX_REFRESH_SESSIONS` in push order;
 * - machine: keep the `MAX_MACHINE_SESSIONS - 1` most recently used, plus `slot`.
 * Slots of the other kind pass through untouched. `$literal` keeps any value
 * that happens to start with `$` from being read as a field path.
 */
function refreshSessionsWith(slot: RefreshSession): Record<string, unknown> {
  const existing = { $ifNull: ['$refreshSessions', []] };
  const ofKind = (eq: boolean) => ({
    $filter: { input: existing, cond: { [eq ? '$eq' : '$ne']: ['$$this.kind', slot.kind] } },
  });
  const kept = slot.kind === 'interactive'
    ? { $slice: [{ $concatArrays: [ofKind(true), [{ $literal: slot }]] }, -MAX_REFRESH_SESSIONS] }
    : {
      $concatArrays: [
        { $slice: [{ $sortArray: { input: ofKind(true), sortBy: { lastUsedAt: -1 } } }, MAX_MACHINE_SESSIONS - 1] },
        [{ $literal: slot }],
      ],
    };
  return { $concatArrays: [ofKind(false), kept] };
}

/**
 * Open a NEW refresh-session slot and mint its token pair.
 *
 * `interactive` — sign-in (password, OAuth, SSO) on a device. `machine` — a
 * stored credential from generate-token. Each kind has its own cap (see
 * {@link MAX_REFRESH_SESSIONS} / {@link MAX_MACHINE_SESSIONS}); opening one
 * never evicts a slot of the other kind. The slot stores the scope and the
 * auth context, so later renewals can neither widen the one nor raise the other.
 *
 * @param user - User document to generate tokens for (`+tokenVersion +isSuperAdmin`)
 * @param activeOrgId - Optional org ID to use as active (falls back to lastActiveOrgId, then first membership)
 */
export async function issueTokens(user: UserDocument, activeOrgId: string | undefined, session: NewSession): Promise<IssuedTokens> {
  const sessionId = crypto.randomBytes(12).toString('hex');
  const { tokens, refreshHash, historyEntry } = await mintTokens(
    user, sessionId, activeOrgId, session.auth, session.expiresIn, session.scope,
  );
  const slot: RefreshSession = {
    id: sessionId,
    kind: session.kind,
    hash: refreshHash,
    createdAt: historyEntry.createdAt,
    lastUsedAt: historyEntry.createdAt,
    ...(session.scope ? { scope: session.scope } : {}),
    amr: session.auth.amr,
    aal: session.auth.aal,
    authTime: session.auth.authTime,
    ...(session.client?.userAgent ? { userAgent: session.client.userAgent } : {}),
    ...(session.client?.ip ? { lastIp: session.client.ip } : {}),
  };
  await User.updateOne(
    { _id: user._id },
    [{
      $set: {
        refreshSessions: refreshSessionsWith(slot),
        issuedTokens: { $slice: [{ $concatArrays: [{ $ifNull: ['$issuedTokens', []] }, [{ $literal: historyEntry }]] }, -20] },
      },
    }],
    { updatePipeline: true },
  );
  return tokens;
}

/** One slot of `user`, or `undefined` when it no longer exists. */
export async function findRefreshSession(userId: Types.ObjectId | string, sessionId: string): Promise<RefreshSession | undefined> {
  const doc = await User.findOne(
    { '_id': userId, 'refreshSessions.id': sessionId },
    { 'refreshSessions.$': 1 },
  ).lean();
  return (doc?.refreshSessions?.[0] as RefreshSession | undefined) ?? undefined;
}

/**
 * Re-issue the token pair for an EXISTING refresh-session slot, replacing the
 * slot's hash in one atomic `findOneAndUpdate`.
 *
 * - Refresh passes `presentedToken` and `kind: 'interactive'`: the write matches
 *   only while the slot still holds THAT token's hash (and the user's
 *   tokenVersion is unchanged), so of two racing uses of one refresh token
 *   exactly one wins — and a machine slot never matches.
 * - Generate-token renewal passes `kind: 'machine'`; switch-org passes no kind.
 *   Both are authenticated by an access token minted for this slot, so only the
 *   slot's existence is required.
 *
 * The slot's stored scope and auth context are authoritative: a requested scope
 * must equal the stored one (`TOKEN_SCOPE_ESCALATION` otherwise — no widening,
 * swapping or in-place narrowing), and `amr` / `aal` / `auth_time` are copied
 * from the slot, never from the request.
 *
 * Returns `null` when nothing matched — the slot is gone or of another kind, the
 * tokenVersion moved, or `presentedToken` was already rotated away (reuse). The
 * caller decides what that means; nothing is persisted.
 */
export async function renewSessionTokens(
  user: UserDocument,
  activeOrgId: string | undefined,
  slot: { sessionId: string; presentedToken?: string; kind?: RefreshSessionKind },
  mint: { expiresIn?: number; scope?: TokenScope; client?: ClientInfo } = {},
): Promise<IssuedTokens | null> {
  const current = await findRefreshSession(user._id, slot.sessionId);
  if (!current || (slot.kind && current.kind !== slot.kind)) return null;
  const slotScope = current.scope as TokenScope | undefined;
  if (mint.scope !== undefined && mint.scope !== slotScope) {
    throw new Error(TOKEN_SCOPE_ESCALATION);
  }
  const auth: SessionAuth = { amr: current.amr, aal: current.aal, authTime: new Date(current.authTime) };

  const { tokens, refreshHash, historyEntry } = await mintTokens(user, slot.sessionId, activeOrgId, auth, mint.expiresIn, slotScope);
  const slotMatch = {
    id: slot.sessionId,
    kind: current.kind,
    // Match the scope we read, so a concurrent change can't be silently widened.
    scope: slotScope ?? null,
    ...(slot.presentedToken === undefined ? {} : { hash: hashRefreshToken(slot.presentedToken) }),
  };
  const updated = await User.findOneAndUpdate(
    { _id: user._id, tokenVersion: user.tokenVersion, refreshSessions: { $elemMatch: slotMatch } },
    {
      $set: {
        'refreshSessions.$.hash': refreshHash,
        'refreshSessions.$.lastUsedAt': historyEntry.createdAt,
        ...(mint.client?.userAgent ? { 'refreshSessions.$.userAgent': mint.client.userAgent } : {}),
        ...(mint.client?.ip ? { 'refreshSessions.$.lastIp': mint.client.ip } : {}),
      },
      $push: { issuedTokens: { $each: [historyEntry], $slice: -20 } },
    },
    { projection: { _id: 1 } },
  ).lean();
  return updated ? tokens : null;
}

/**
 * Sign the SHORT-LIVED token an opaque access key is exchanged for
 * (`POST /auth/token/exchange`).
 *
 * Same claims as a session access token — so it carries the user's real org
 * permissions — but `token_use: 'api_key'`, `jti` = the key's id, and a
 * {@link API_KEY_TOKEN_TTL_SECONDS} lifetime. `auth` is the assurance recorded
 * when the key was created (inherited, never raised); when `scope` is set the
 * token is forced to least-privilege (see {@link createAccessTokenPayload}).
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
  expiresInSeconds: number = API_KEY_TOKEN_TTL_SECONDS,
): Promise<string> {
  const payload: AccessTokenPayload = {
    ...createAccessTokenPayload(user, membership, { auth, tokenUse: 'api_key', scope }),
    jti: keyId,
  };
  return signUserJwt(payload as unknown as Record<string, unknown>, { expiresIn: expiresInSeconds });
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
    permissions: scope ? [] : resolveUserPermissions(account.rolePermissions, account.isSuperAdmin),
    ...(scope ? { scope } : {}),
    // Service accounts have no email identity to verify; every route that gates
    // on verification is a human-onboarding route.
    isEmailVerified: true,
    jti: keyId,
  };
  return signUserJwt(payload as unknown as Record<string, unknown>, { expiresIn: expiresInSeconds });
}

/**
 * The membership context an access key's exchanged token is minted against —
 * exported so the key service can fail closed when it resolves to `undefined`
 * for a key that names an org.
 */
export async function membershipForOrg(userId: string, orgId: string): Promise<MembershipContext | undefined> {
  return resolveOrgMembership(userId, orgId);
}

/** Verify and decode a JWT access token. */
export function verifyAccessToken(token: string): AccessTokenPayload {
  return verifyPlatformJwt<AccessTokenPayload>(token);
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
  const accessToken = await signUserJwt(payload as unknown as Record<string, unknown>, { expiresIn: ttlSeconds });
  return { accessToken, expiresIn: ttlSeconds };
}

/** Verify and decode a JWT refresh token. */
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = verifyRefreshJwt<RefreshTokenPayload>(token);
  // Assert token type (mirrors requireAuth's `access` check and api-core's
  // step-up check): reject an access/step-up token presented on the refresh path.
  // Load-bearing now that all four classes share ONE signing key — the `type`
  // claim is the only thing separating them.
  if ((payload as { type?: unknown }).type !== 'refresh') {
    throw new jwt.JsonWebTokenError('Invalid token type for refresh');
  }
  return payload;
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
 * A TOTP step-up additionally carries `mfa` in `amr`: it is the one method here
 * that proves possession of a second factor. (Whether a user-verified passkey
 * counts the same way is an assurance question #8 answers; until it does, the
 * claim stays narrow rather than asserting something no gate reads.)
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
    amr: (method === 'totp' ? ['stepup', 'mfa'] : ['stepup']) as AuthMethod[],
    // How the step-up was earned — recorded for audit (and later assurance
    // decisions). requireStepUp ignores it: every method yields the same gate.
    method,
    jti: crypto.randomBytes(8).toString('hex'),
  };
  const token = await signUserJwt(payload, { expiresIn: ttlSeconds });
  return { token, expiresAt };
}
