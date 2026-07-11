// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import { createLogger, resolveUserFeatures, resolveUserPermissions } from '@pipeline-builder/api-core';
import type { QuotaTier } from '@pipeline-builder/api-core';
import jwt from 'jsonwebtoken';
import type { Types } from 'mongoose';
import { config } from '../config/index.js';
import { resolveOrgLineage } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
import { User, Organization, UserOrganization, Group, GroupMembership } from '../models/index.js';
import type { OrgMemberRole } from '../models/user-organization.js';
import type { UserDocument } from '../models/user.js';
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
  /** Fine-grained permissions granted by the user's groups in the active org.
   *  Unioned with the role's base bundle to form the JWT `permissions` claim. */
  groupPermissions?: readonly string[];
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
function createAccessTokenPayload(user: UserDocument, membership?: MembershipContext, scope?: string): AccessTokenPayload {
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
    features: scope ? [] : resolveUserFeatures(tier, overrides, isSuperAdmin, membership?.featureEntitlements),
    // Fine-grained RBAC: effective permissions = role's base bundle ∪ group
    // grants (superadmin ⇒ all). Enforced downstream via requirePermission().
    // Scoped machine tokens carry none (least privilege).
    permissions: scope ? [] : resolveUserPermissions(role, membership?.groupPermissions, isSuperAdmin),
    ...(scope ? { scope } : {}),
    tokenVersion: user.tokenVersion,
    isEmailVerified: user.isEmailVerified,
  };
}

/** Sign and return a JWT refresh token for the given user. */
function generateRefreshToken(user: UserDocument): string {
  const payload: RefreshTokenPayload = {
    type: 'refresh',
    sub: user._id.toString(),
    tokenVersion: user.tokenVersion,
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
 * Raw permission strings granted by a user's groups in an org (deduped).
 * Kept inline (rather than importing groups-service) so token issuance has a
 * minimal dependency graph. api-core's `resolveUserPermissions` filters out any
 * unknown strings downstream, so no validation is needed here.
 */
async function groupPermissionsFor(userId: string, organizationId: Types.ObjectId | string): Promise<string[]> {
  const memberships = await GroupMembership.find({ userId, organizationId }).session(null).select('groupId').lean();
  const groupIds = memberships.map((m) => m.groupId);
  if (groupIds.length === 0) return [];
  const groups = await Group.find({ _id: { $in: groupIds } }).session(null).select('permissions').lean();
  const perms = new Set<string>();
  for (const g of groups) for (const p of ((g.permissions as string[]) ?? [])) perms.add(p);
  return [...perms];
}

/**
 * Resolve the membership context for a user's active organization.
 * Looks up UserOrganization + Organization name for the given orgId.
 * Falls back to user.lastActiveOrgId, then first membership.
 */
async function resolveMembership(userId: string, activeOrgId?: string): Promise<MembershipContext | undefined> {
  // Try explicit activeOrgId first
  if (activeOrgId) {
    const membership = await UserOrganization.findOne({ userId, organizationId: toOrgId(activeOrgId), isActive: true }).lean();
    if (membership) {
      const org = await Organization.findById(toOrgId(activeOrgId)).select('name tier parentOrgId featureEntitlements').lean();
      return {
        organizationId: activeOrgId,
        organizationName: org?.name,
        role: membership.role as OrgMemberRole,
        tier: org?.tier,
        featureEntitlements: (org as { featureEntitlements?: string[] })?.featureEntitlements,
        groupPermissions: await groupPermissionsFor(userId, toOrgId(activeOrgId)),
        ...(await hierarchyContext(activeOrgId, org?.parentOrgId)),
      };
    }
  }

  // Fall back to first membership
  const first = await UserOrganization.findOne({ userId, isActive: true }).sort({ joinedAt: 1 }).lean();
  if (!first) return undefined;

  const orgId = first.organizationId.toString();
  const org = await Organization.findById(toOrgId(orgId)).select('name tier parentOrgId featureEntitlements').lean();
  return {
    organizationId: orgId,
    organizationName: org?.name,
    role: first.role as OrgMemberRole,
    tier: org?.tier,
    featureEntitlements: (org as { featureEntitlements?: string[] })?.featureEntitlements,
    groupPermissions: await groupPermissionsFor(userId, toOrgId(orgId)),
    ...(await hierarchyContext(orgId, org?.parentOrgId)),
  };
}

/**
 * Resolve the org → team hierarchy claims for a token. When the active org is
 * flat (no `parentOrgId`, the case for every org today) this returns `{}` and
 * costs nothing — the parent we already fetched is the only signal needed. Only
 * a parented org pays the upward walk via {@link resolveOrgLineage}.
 */
async function hierarchyContext(
  orgId: string,
  parentOrgId: string | null | undefined,
): Promise<{ parentOrganizationId?: string; rootOrganizationId?: string }> {
  if (!parentOrgId) return {};
  const lineage = await resolveOrgLineage(orgId);
  return {
    ...(lineage.parentOrgId && { parentOrganizationId: lineage.parentOrgId }),
    ...(lineage.rootOrgId !== orgId && { rootOrganizationId: lineage.rootOrgId }),
  };
}

/**
 * Generate a new token pair and persist the hashed refresh token in the database.
 *
 * Resolves the user's membership context by looking up {@link UserOrganization}
 * for the active org. The resulting access token JWT contains:
 * - `role`: the user's per-org role ('owner' | 'admin' | 'member')
 * - `isAdmin`: derived as `role === 'admin' || role === 'owner'`
 * - `organizationId` / `organizationName`: the active org context
 *
 * Falls back to `user.lastActiveOrgId`, then the user's earliest active membership.
 *
 * @param user - User document to generate tokens for
 * @param activeOrgId - Optional org ID to use as active (falls back to lastActiveOrgId, then first membership)
 * @param expiresIn - Optional access token lifetime in seconds (default: config.auth.jwt.expiresIn)
 */
export async function issueTokens(user: UserDocument, activeOrgId?: string, expiresIn?: number, scope?: string): Promise<IssuedTokens> {
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
    createAccessTokenPayload(user, membership, scope),
    config.auth.jwt.secret,
    { algorithm: config.auth.jwt.algorithm, expiresIn: tokenExpiresIn },
  );

  const refreshToken = generateRefreshToken(user);
  const hashedRefresh = hashRefreshToken(refreshToken);

  // Append to the user's issued-tokens history (ring-buffered to 20 most recent).
  const now = new Date();
  const tokenRecord = {
    id: crypto.randomBytes(8).toString('hex'),
    createdAt: now,
    expiresAt: new Date(now.getTime() + tokenExpiresIn * 1000),
    tokenVersionAtIssue: user.tokenVersion,
  };
  await User.updateOne(
    { _id: user._id },
    {
      $set: { refreshToken: hashedRefresh },
      $push: { issuedTokens: { $each: [tokenRecord], $slice: -20 } },
    },
  );

  return { accessToken, refreshToken, expiresIn: tokenExpiresIn };
}

/** Verify and decode a JWT access token. */
export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.auth.jwt.secret, {
    algorithms: [config.auth.jwt.algorithm],
  }) as AccessTokenPayload;
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
 */
export async function issueImpersonationToken(
  target: UserDocument,
  impersonatorId: string,
  ttlSeconds = 15 * 60,
): Promise<{ accessToken: string; expiresIn: number }> {
  let membership: MembershipContext | undefined;
  try {
    membership = await resolveMembership(
      target._id.toString(),
      target.lastActiveOrgId?.toString(),
    );
  } catch (err) {
    logger.warn('Impersonation: failed to resolve target membership', { error: err });
  }

  const payload = {
    ...createAccessTokenPayload(target, membership),
    impersonatorId,
    impersonationReadOnly: true,
  };
  const accessToken = jwt.sign(payload, config.auth.jwt.secret, {
    algorithm: config.auth.jwt.algorithm,
    expiresIn: ttlSeconds,
  });
  return { accessToken, expiresIn: ttlSeconds };
}

/** Verify and decode a JWT refresh token. */
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, config.auth.refreshToken.secret, {
    algorithms: [config.auth.jwt.algorithm],
  }) as RefreshTokenPayload;
}

/**
 * Payload of a short-lived step-up token. Issued by POST /api/auth/step-up
 * once the caller re-verifies their password; required (as
 * `X-Step-Up-Token`) on destructive endpoints behind `requireStepUp`.
 *
 * Single-use enforcement is NOT done today — the token is short-lived
 * (60s default) and bound to the user's sub, so the realistic replay
 * window is tiny. If we ever need true single-use, swap in a Redis-backed
 * jti consumption set.
 */
export interface StepUpTokenPayload {
  type: 'step-up';
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

/** Sign a short-lived step-up token bound to `userId`. Defaults to 60s TTL. */
export function issueStepUpToken(userId: string, ttlSeconds = 60): { token: string; expiresAt: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = {
    type: 'step-up' as const,
    sub: userId,
    jti: crypto.randomBytes(8).toString('hex'),
  };
  const token = jwt.sign(payload, config.auth.jwt.secret, {
    algorithm: config.auth.jwt.algorithm,
    expiresIn: ttlSeconds,
  });
  return { token, expiresAt };
}

/** Verify a step-up token; throws on invalid signature/expiry. Caller must
 *  additionally check that `payload.sub === req.user.sub` — `requireStepUp`
 *  middleware does this. */
export function verifyStepUpToken(token: string): StepUpTokenPayload {
  const payload = jwt.verify(token, config.auth.jwt.secret, {
    algorithms: [config.auth.jwt.algorithm],
  }) as StepUpTokenPayload;
  // A normal access token shares the same JWT secret + `sub`, so without
  // asserting the step-up type (and a jti) it would satisfy requireStepUp and
  // bypass the password re-verification gate on destructive endpoints.
  if (payload.type !== 'step-up' || !payload.jti) {
    throw new Error('INVALID_STEP_UP_TOKEN');
  }
  return payload;
}
