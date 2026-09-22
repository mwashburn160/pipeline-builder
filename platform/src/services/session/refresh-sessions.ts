// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Refresh-session slots and the access + refresh token pairs minted for them:
 * opening a slot at sign-in (or for a machine credential), and renewing one on
 * refresh, generate-token renewal and switch-org.
 */

import crypto from 'crypto';
import { createLogger, type TokenScope } from '@pipeline-builder/api-core';
import type { Types } from 'mongoose';
import { accessTokenTtlSeconds, createAccessTokenPayload, enforceOrgAssurance, type SessionAuth } from './access-tokens.js';
import { resolveMembership, type MembershipContext } from './membership-context.js';
import { config } from '../../config/index.js';
import type { ClientInfo } from '../../helpers/client-info.js';
import { publishSessionSlotRevocation } from '../../helpers/session-revocation.js';
import { User } from '../../models/index.js';
import type { RefreshSession, RefreshSessionKind, UserDocument } from '../../models/user.js';
import type { RefreshTokenPayload } from '../../types/index.js';
import { TOKEN_SCOPE_ESCALATION } from '../auth-errors.js';
import { signUserJwt } from '../token-signing/index.js';

const logger = createLogger('token');

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
async function generateRefreshToken(user: UserDocument, sessionId: string, expiresInSeconds: number): Promise<string> {
  const payload: RefreshTokenPayload = {
    type: 'refresh',
    sub: user._id.toString(),
    tokenVersion: user.tokenVersion,
    sid: sessionId,
    jti: crypto.randomBytes(8).toString('hex'),
  };
  return signUserJwt(payload, { expiresIn: expiresInSeconds });
}

/** Whole seconds until `at` (never below 0). */
function secondsUntil(at: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((new Date(at).getTime() - now.getTime()) / 1000));
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
interface MintOptions {
  /** The refresh-session slot the pair is minted for. */
  sessionId: string;
  /** Preferred active org; falls back to `lastActiveOrgId`, then the earliest active membership. */
  activeOrgId: string | undefined;
  /** How the person authenticated (copied from the slot on renewal). */
  auth: SessionAuth;
  /** The slot's fixed end (machine credentials): nothing minted outlives it. */
  slotExpiresAt?: Date;
  scope?: TokenScope;
  mfaEnrollmentPending?: boolean;
  permissions?: readonly string[];
}

async function mintTokens(
  user: UserDocument,
  { sessionId, activeOrgId, auth: sessionAuth, slotExpiresAt, scope, mfaEnrollmentPending, permissions }: MintOptions,
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

  const auth = await enforceOrgAssurance(user, membership, sessionAuth, { scope, mfaEnrollmentPending });

  // Per-tier override → global default. The per-tier path lets
  // compliance-driven customers (enterprise tiers) narrow the stolen-token
  // blast window without forcing every user to re-auth more often. A slot with
  // a fixed end (a machine credential) never mints past it: neither its access
  // token nor its refresh token outlives the slot.
  const now = new Date();
  // (`renewSessionTokens` refuses a slot already past its end; the floor of 1s
  // only covers the instant between that check and this one.)
  const slotRemaining = slotExpiresAt ? Math.max(1, secondsUntil(slotExpiresAt, now)) : undefined;
  const baseTtl = accessTokenTtlSeconds(membership?.tier);
  const tokenExpiresIn = slotRemaining !== undefined ? Math.min(baseTtl, slotRemaining) : baseTtl;
  const refreshExpiresIn = slotRemaining ?? config.auth.refreshToken.expiresIn;

  const accessToken = await signUserJwt(
    createAccessTokenPayload(user, membership, { auth, tokenUse: 'access', scope, permissions, sessionId, mfaEnrollmentPending }),
    { expiresIn: tokenExpiresIn },
  );
  const refreshToken = await generateRefreshToken(user, sessionId, refreshExpiresIn);

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
  /**
   * MACHINE slots only: the slot's lifetime in seconds (generate-token's
   * `expiresIn`). The slot — and so every refresh token it rotates through —
   * ends at `now + lifetimeSeconds`; its access tokens keep the normal
   * per-tier lifetime (never longer than a person's) and are renewed through
   * the slot's refresh token. Interactive slots end with their refresh token.
   */
  lifetimeSeconds?: number;
  /** Narrow capability scope (least-privilege machine token), fixed for the slot's life. */
  scope?: TokenScope;
  /**
   * Permission SUBSET (catalog ids) a permission-scoped machine token was opened
   * with, fixed for the slot's life. Every renewal re-intersects it with the
   * holder's CURRENT permissions, so it can only ever shrink.
   */
  permissions?: readonly string[];
  /**
   * Open this slot as a BOOTSTRAP-ADMIN ENROLMENT session: `aal: 1`, flagged
   * `mfaEnrollmentPending`, reaching only enrolment, sign-out and the setup
   * routes. Stored on the slot so a refresh of it stays just as limited — the
   * flag is part of what the session IS, not a property of one token.
   */
  mfaEnrollmentPending?: boolean;
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
  const slotExpiresAt = session.lifetimeSeconds !== undefined
    ? new Date(Date.now() + session.lifetimeSeconds * 1000)
    : undefined;
  const { tokens, refreshHash, historyEntry } = await mintTokens(user, {
    sessionId,
    activeOrgId,
    auth: session.auth,
    slotExpiresAt,
    scope: session.scope,
    mfaEnrollmentPending: session.mfaEnrollmentPending,
    permissions: session.permissions,
  });
  const slot: RefreshSession = {
    id: sessionId,
    kind: session.kind,
    hash: refreshHash,
    createdAt: historyEntry.createdAt,
    lastUsedAt: historyEntry.createdAt,
    ...(slotExpiresAt ? { expiresAt: slotExpiresAt } : {}),
    ...(session.scope ? { scope: session.scope } : {}),
    ...(session.permissions ? { permissions: [...session.permissions] } : {}),
    ...(session.mfaEnrollmentPending ? { mfaEnrollmentPending: true } : {}),
    amr: session.auth.amr,
    aal: session.auth.aal,
    authTime: session.auth.authTime,
    ...(session.auth.aaguid ? { aaguid: session.auth.aaguid } : {}),
    ...(session.auth.aalAssertedBy ? { aalAssertedBy: session.auth.aalAssertedBy } : {}),
    ...(session.client?.userAgent ? { userAgent: session.client.userAgent } : {}),
    ...(session.client?.ip ? { lastIp: session.client.ip } : {}),
  };
  const before = await slotIdsOf(user._id);
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
  // A slot pushed out by the per-kind cap is signed out like any other: its
  // live access token must stop working on every service, not just here.
  await publishEvictedSlots(user._id, before);
  return tokens;
}

/** The user's current slot ids, or null when they can't be read. */
async function slotIdsOf(userId: Types.ObjectId | string): Promise<string[] | null> {
  try {
    const doc = await User.findById(userId).select('+refreshSessions').lean();
    return doc ? (doc.refreshSessions ?? []).map((s) => s.id) : null;
  } catch {
    return null;
  }
}

/**
 * Publish `revoke:sid` for the slots in `before` that the write evicted.
 * Best-effort, and conservative: if either read failed nothing is published —
 * a missing "after" must never read as "every slot was evicted".
 */
async function publishEvictedSlots(userId: Types.ObjectId | string, before: readonly string[] | null): Promise<void> {
  if (!before || before.length === 0) return;
  const after = await slotIdsOf(userId);
  if (!after) return;
  const kept = new Set(after);
  const evicted = before.filter((id) => !kept.has(id));
  if (evicted.length > 0) await publishSessionSlotRevocation(evicted);
}

/** One slot of `user`, or `undefined` when it no longer exists. */
export async function findRefreshSession(userId: Types.ObjectId | string, sessionId: string): Promise<RefreshSession | undefined> {
  const doc = await User.findOne(
    { '_id': userId, 'refreshSessions.id': sessionId },
    { 'refreshSessions.$': 1 },
  ).lean();
  return (doc?.refreshSessions?.[0] as RefreshSession | undefined) ?? undefined;
}

/** Whether two permission subsets name the same set (`undefined` = no subset). */
function samePermissionSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((p) => right.has(p));
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
  mint: { scope?: TokenScope; permissions?: readonly string[]; client?: ClientInfo } = {},
): Promise<IssuedTokens | null> {
  const current = await findRefreshSession(user._id, slot.sessionId);
  if (!current || (slot.kind && current.kind !== slot.kind)) return null;
  // A slot past its fixed end (a machine credential's lifetime) renews nothing.
  if (current.expiresAt && new Date(current.expiresAt).getTime() <= Date.now()) return null;
  const slotScope = current.scope as TokenScope | undefined;
  if (mint.scope !== undefined && mint.scope !== slotScope) {
    throw new Error(TOKEN_SCOPE_ESCALATION);
  }
  // The permission subset is fixed for the slot's life exactly like the scope:
  // a requested one must name the SAME set (no widening, swapping or in-place
  // narrowing — narrowing is a new credential, not a renewal).
  const slotPermissions = current.permissions ?? undefined;
  if (mint.permissions !== undefined && !samePermissionSet(mint.permissions, slotPermissions)) {
    throw new Error(TOKEN_SCOPE_ESCALATION);
  }
  const auth: SessionAuth = {
    amr: current.amr,
    aal: current.aal,
    authTime: new Date(current.authTime),
    ...(current.aaguid ? { aaguid: current.aaguid } : {}),
    ...(current.aalAssertedBy ? { aalAssertedBy: current.aalAssertedBy } : {}),
  };

  const { tokens, refreshHash, historyEntry } = await mintTokens(user, {
    sessionId: slot.sessionId,
    activeOrgId,
    auth,
    slotExpiresAt: current.expiresAt ? new Date(current.expiresAt) : undefined,
    scope: slotScope,
    mfaEnrollmentPending: current.mfaEnrollmentPending,
    permissions: slotPermissions,
  });
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
