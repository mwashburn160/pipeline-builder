// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import { createLogger, resolveUserFeatures, resolveUserPermissions } from '@pipeline-builder/api-core';
import type { TokenScope, QuotaTier } from '@pipeline-builder/api-core';
import jwt from 'jsonwebtoken';
import type { Types } from 'mongoose';
import { jwtSignOptions, verifyPlatformJwt } from './jwt-options.js';
import { config } from '../config/index.js';
import { IMPERSONATION_SESSION_TTL_MS } from '../constants/impersonation.js';
import { resolveOrgLineage } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
import { User, Organization, UserOrganization, Role, RoleAssignment } from '../models/index.js';
import type { OrgMemberRole } from '../models/user-organization.js';
import type { UserDocument } from '../models/user.js';
import { TOKEN_SCOPE_ESCALATION } from '../services/auth-errors.js';
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
  membership?: MembershipContext,
  scope?: TokenScope,
  sessionId?: string,
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
 * Most refresh-session slots (signed-in devices) a user keeps. Opening a new
 * session beyond this evicts the OLDEST slot.
 */
export const MAX_REFRESH_SESSIONS = 10;

/**
 * Sign a refresh token for one session slot. The random `jti` makes every
 * rotation produce a distinct token (and hash), even within the same second.
 */
function generateRefreshToken(user: UserDocument, sessionId: string): string {
  const payload: RefreshTokenPayload = {
    type: 'refresh',
    sub: user._id.toString(),
    tokenVersion: user.tokenVersion,
    sid: sessionId,
    jti: crypto.randomBytes(8).toString('hex'),
  };
  return jwt.sign(payload, config.auth.refreshToken.secret, {
    algorithm: config.auth.jwt.algorithm,
    expiresIn: config.auth.refreshToken.expiresIn,
  });
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
  activeOrgId?: string,
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

  const accessToken = jwt.sign(
    createAccessTokenPayload(user, membership, scope, sessionId),
    config.auth.jwt.secret,
    jwtSignOptions(tokenExpiresIn),
  );
  const refreshToken = generateRefreshToken(user, sessionId);

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

/**
 * Sign in on a NEW device: mint a token pair in a fresh refresh-session slot.
 * The user keeps at most {@link MAX_REFRESH_SESSIONS} slots; the oldest is
 * evicted when a new one would exceed the cap.
 *
 * @param user - User document to generate tokens for (`+tokenVersion +isSuperAdmin`)
 * @param activeOrgId - Optional org ID to use as active (falls back to lastActiveOrgId, then first membership)
 * @param expiresIn - Optional access token lifetime in seconds (default: per-tier, then config.auth.jwt.expiresIn)
 * @param scope - Optional narrow capability scope (least-privilege machine token)
 */
export async function issueTokens(user: UserDocument, activeOrgId?: string, expiresIn?: number, scope?: TokenScope): Promise<IssuedTokens> {
  const sessionId = crypto.randomBytes(12).toString('hex');
  const { tokens, refreshHash, historyEntry } = await mintTokens(user, sessionId, activeOrgId, expiresIn, scope);
  await User.updateOne(
    { _id: user._id },
    {
      $push: {
        refreshSessions: {
          $each: [{
            id: sessionId,
            hash: refreshHash,
            createdAt: historyEntry.createdAt,
            lastUsedAt: historyEntry.createdAt,
            ...(scope ? { scope } : {}),
          }],
          $slice: -MAX_REFRESH_SESSIONS,
        },
        issuedTokens: { $each: [historyEntry], $slice: -20 },
      },
    },
  );
  return tokens;
}


/**
 * Re-issue the token pair for an EXISTING refresh-session slot, replacing the
 * slot's hash in one atomic `findOneAndUpdate`.
 *
 * - Refresh passes `presentedToken`: the write matches only while the slot still
 *   holds THAT token's hash (and the user's tokenVersion is unchanged), so of two
 *   racing uses of one refresh token exactly one wins.
 * - Switch-org and generate-token omit it: the caller is authenticated by an
 *   access token minted for this slot, so only the slot's existence is required.
 *   `mint` carries generate-token's lifetime / scope overrides.
 *
 * Returns `null` when nothing matched — the slot is gone, the tokenVersion moved,
 * or `presentedToken` was already rotated away (reuse). The caller decides what
 * that means; nothing is persisted.
 */
export async function renewSessionTokens(
  user: UserDocument,
  activeOrgId: string | undefined,
  slot: { sessionId: string; presentedToken?: string },
  mint: { expiresIn?: number; scope?: TokenScope } = {},
): Promise<IssuedTokens | null> {
  // The slot's stored scope is authoritative. Renewal keeps it; a scoped slot can
  // never be re-minted unscoped or under another scope (that would turn a narrow
  // machine credential into a full-privilege one). An unscoped slot may narrow.
  const current = await User.findOne(
    { '_id': user._id, 'refreshSessions.id': slot.sessionId },
    { 'refreshSessions.$': 1 },
  ).lean();
  const slotScope = (current?.refreshSessions?.[0] as { scope?: TokenScope } | undefined)?.scope;
  if (slotScope && mint.scope !== undefined && mint.scope !== slotScope) {
    throw new Error(TOKEN_SCOPE_ESCALATION);
  }
  const scope = mint.scope ?? slotScope;

  const { tokens, refreshHash, historyEntry } = await mintTokens(user, slot.sessionId, activeOrgId, mint.expiresIn, scope);
  const slotMatch = {
    id: slot.sessionId,
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
        ...(scope ? { 'refreshSessions.$.scope': scope } : {}),
      },
      $push: { issuedTokens: { $each: [historyEntry], $slice: -20 } },
    },
    { projection: { _id: 1 } },
  ).lean();
  return updated ? tokens : null;
}

/**
 * Sign a Personal Access Token (PAT) for a user. Same claims as a session access
 * token (so it carries the user's real org permissions) but stamped with a
 * caller-supplied `jti` for individual revocation and a long, explicit lifetime.
 * When `scope` is set the token is forced to least-privilege (see
 * {@link createAccessTokenPayload}). No refresh token and no `issuedTokens`
 * history entry — a PAT is tracked by the `PersonalAccessToken` record keyed on
 * its `jti`, not the session ring buffer.
 */
export async function signPersonalAccessToken(
  user: UserDocument,
  activeOrgId: string | undefined,
  jti: string,
  expiresInSeconds: number,
  scope?: TokenScope,
): Promise<string> {
  let membership: MembershipContext | undefined;
  try {
    membership = await resolveMembership(user._id.toString(), activeOrgId || user.lastActiveOrgId?.toString());
  } catch (error) {
    logger.warn('Failed to resolve membership for PAT', { error });
  }
  const payload: AccessTokenPayload = { ...createAccessTokenPayload(user, membership, scope), jti };
  return jwt.sign(payload, config.auth.jwt.secret, jwtSignOptions(expiresInSeconds));
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
  ttlSeconds = IMPERSONATION_SESSION_TTL_MS / 1000,
): Promise<{ accessToken: string; expiresIn: number }> {
  let membership: MembershipContext | undefined;
  try {
    membership = orgId ? await resolveOrgMembership(target._id.toString(), orgId) : undefined;
  } catch (err) {
    logger.warn('Impersonation: failed to resolve target membership', { orgId, error: err });
  }

  // `jti` identifies THIS session so it can be revoked on its own. Paired with
  // `impersonatorId`, which is what tells the auth middleware this is an
  // impersonation session rather than a Personal Access Token — both carry a
  // `jti`, and they are validated against completely different records.
  const payload = {
    ...createAccessTokenPayload(target, membership),
    impersonatorId,
    impersonationReadOnly: true,
    jti,
  };
  const accessToken = jwt.sign(payload, config.auth.jwt.secret, jwtSignOptions(ttlSeconds));
  return { accessToken, expiresIn: ttlSeconds };
}

/** Verify and decode a JWT refresh token. */
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = jwt.verify(token, config.auth.refreshToken.secret, {
    algorithms: [config.auth.jwt.algorithm],
  }) as RefreshTokenPayload;
  // Assert token type (mirrors requireAuth's `access` check and api-core's
  // step-up check): reject an access/step-up token presented on the refresh path,
  // which matters if REFRESH_TOKEN_SECRET is ever misconfigured to equal JWT_SECRET.
  if ((payload as { type?: unknown }).type !== 'refresh') {
    throw new jwt.JsonWebTokenError('Invalid token type for refresh');
  }
  return payload;
}

/**
 * Sign a short-lived step-up token bound to `userId` (default 60s TTL). Issued
 * by POST /api/auth/step-up once the caller re-verifies their password, and
 * replayed as `X-Step-Up-Token` on routes behind api-core's `requireStepUp`,
 * which verifies the `type: 'step-up'` + `jti` claims, binds `sub` to the caller
 * and consumes the `jti` once.
 */
export function issueStepUpToken(userId: string, ttlSeconds = 60): { token: string; expiresAt: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = {
    type: 'step-up' as const,
    sub: userId,
    jti: crypto.randomBytes(8).toString('hex'),
  };
  const token = jwt.sign(payload, config.auth.jwt.secret, jwtSignOptions(ttlSeconds));
  return { token, expiresAt };
}
