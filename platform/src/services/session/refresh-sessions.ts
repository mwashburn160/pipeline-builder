// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Refresh-session slots and the access + refresh token pairs minted for them:
 * opening a slot at sign-in (or for a machine credential), renewing one on
 * refresh and generate-token renewal, and switching one's org (switch-org,
 * which mints an access token only).
 */

import crypto from 'crypto';
import { createLogger, type TokenScope } from '@pipeline-builder/api-core';
import type { Types } from 'mongoose';
import { accessTokenTtlSeconds, createAccessTokenPayload, enforceOrgAssurance, type SessionAuth } from './access-tokens.js';
import { resolveMembership, resolveOrgMembership, signInLandingOrg, type MembershipContext } from './membership-context.js';
import { config } from '../../config/index.js';
import type { RefreshSessionKind } from '../../constants/vocabulary.js';
import type { ClientInfo } from '../../helpers/client-info.js';
import { publishSessionSlotRevocation } from '../../helpers/session-revocation.js';
import { User } from '../../models/index.js';
import type { RefreshSession, UserDocument } from '../../models/user.js';
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

/** A signed access token plus what the caller persists for it. */
interface MintedAccessToken {
  accessToken: string;
  expiresIn: number;
  /** The org the token was actually scoped to (after any fallback); absent when none resolved. */
  organizationId?: string;
  /** `issuedTokens` history entry (ring-buffered to the 20 most recent). */
  historyEntry: { id: string; createdAt: Date; expiresAt: Date; tokenVersionAtIssue: number };
}

/** A signed token pair plus what the caller persists for it. */
interface MintedTokens extends MintedAccessToken {
  tokens: IssuedTokens;
  refreshHash: string;
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
 * The org is the first of `orgCandidates` the user still has authority in, then
 * `user.lastActiveOrgId`, then the user's earliest active membership — never an
 * org the user is no longer a member of.
 */
interface MintOptions {
  /** The refresh-session slot the pair is minted for. */
  sessionId: string;
  /**
   * Preferred active orgs, in order (the slot's own org, then the caller's
   * hint); falls back to `lastActiveOrgId`, then the earliest active membership.
   */
  orgCandidates: ReadonlyArray<string | undefined>;
  /**
   * Scope the token to `orgCandidates[0]` or to NO org — never fall back to
   * another one (switch-org: the caller asked for exactly that org).
   */
  exactOrg?: boolean;
  /** How the person authenticated (copied from the slot on renewal). */
  auth: SessionAuth;
  /** The slot's fixed end (machine credentials): nothing minted outlives it. */
  slotExpiresAt?: Date;
  scope?: TokenScope;
  mfaEnrollmentPending?: boolean;
  permissions?: readonly string[];
  /**
   * True when the pair opens a NEW slot (sign-in, a stored credential): the
   * requested org is then re-checked for inherited team entry
   * ({@link signInLandingOrg}). A renewal keeps the org its session entered.
   */
  opensSession?: boolean;
}

/** The membership context for the first candidate org that still resolves. */
async function resolveCandidateMembership(user: UserDocument, opts: MintOptions): Promise<MembershipContext | undefined> {
  const userId = user._id.toString();
  if (opts.exactOrg) {
    const [orgId] = opts.orgCandidates;
    return orgId ? resolveOrgMembership(userId, orgId) : undefined;
  }
  let candidates = [...opts.orgCandidates, user.lastActiveOrgId?.toString()].filter((c): c is string => !!c);
  if (opts.opensSession && candidates.length > 0) {
    try {
      candidates = [await signInLandingOrg(user, candidates[0])];
    } catch (error) {
      // Fail closed: an unanswerable check pins nothing, so the session opens
      // in the user's earliest direct membership rather than the team.
      logger.warn('Inherited team-entry check failed; not pinning the requested org', { error });
      candidates = [];
    }
  }
  const tried = new Set<string>();
  for (const orgId of candidates) {
    if (tried.has(orgId)) continue;
    tried.add(orgId);
    const pinned = await resolveOrgMembership(userId, orgId);
    if (pinned) return pinned;
  }
  return resolveMembership(userId);
}

/** Resolve the active membership and sign the ACCESS token for slot `sessionId`. Persists nothing. */
async function mintAccessToken(user: UserDocument, opts: MintOptions): Promise<MintedAccessToken> {
  const { sessionId, auth: sessionAuth, slotExpiresAt, scope, mfaEnrollmentPending, permissions } = opts;
  let membership: MembershipContext | undefined;
  try {
    membership = await resolveCandidateMembership(user, opts);
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
  const tokenExpiresIn = accessTokenLifetime(membership, slotExpiresAt, now);

  const accessToken = await signUserJwt(
    createAccessTokenPayload(user, membership, { auth, tokenUse: 'access', scope, permissions, sessionId, mfaEnrollmentPending }),
    { expiresIn: tokenExpiresIn },
  );

  return {
    accessToken,
    expiresIn: tokenExpiresIn,
    ...(membership ? { organizationId: membership.organizationId } : {}),
    historyEntry: {
      id: crypto.randomBytes(8).toString('hex'),
      createdAt: now,
      expiresAt: new Date(now.getTime() + tokenExpiresIn * 1000),
      tokenVersionAtIssue: user.tokenVersion,
    },
  };
}

/**
 * Seconds left on a slot with a fixed end. (`renewSessionTokens` refuses a slot
 * already past its end; the floor of 1s only covers the instant between that
 * check and this one.)
 */
function slotRemainingSeconds(slotExpiresAt: Date | undefined, now: Date): number | undefined {
  return slotExpiresAt ? Math.max(1, secondsUntil(slotExpiresAt, now)) : undefined;
}

function accessTokenLifetime(membership: MembershipContext | undefined, slotExpiresAt: Date | undefined, now: Date): number {
  const baseTtl = accessTokenTtlSeconds(membership?.tier);
  const slotRemaining = slotRemainingSeconds(slotExpiresAt, now);
  return slotRemaining !== undefined ? Math.min(baseTtl, slotRemaining) : baseTtl;
}

/** {@link mintAccessToken} plus the slot's next refresh token. */
async function mintTokens(user: UserDocument, opts: MintOptions): Promise<MintedTokens> {
  const minted = await mintAccessToken(user, opts);
  const refreshExpiresIn = slotRemainingSeconds(opts.slotExpiresAt, minted.historyEntry.createdAt)
    ?? config.auth.refreshToken.expiresIn;
  const refreshToken = await generateRefreshToken(user, opts.sessionId, refreshExpiresIn);
  return {
    ...minted,
    tokens: { accessToken: minted.accessToken, refreshToken, expiresIn: minted.expiresIn },
    refreshHash: hashRefreshToken(refreshToken),
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
  const { tokens, refreshHash, historyEntry, organizationId } = await mintTokens(user, {
    sessionId,
    orgCandidates: [activeOrgId],
    opensSession: true,
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
    ...(organizationId ? { activeOrgId: organizationId } : {}),
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

/** The slot a renewal / switch acts on, after the checks every re-issue shares. */
interface LiveSlot {
  current: RefreshSession;
  slotScope: TokenScope | undefined;
  slotPermissions: readonly string[] | undefined;
  auth: SessionAuth;
}

/**
 * Read slot `sessionId` and apply the rules every re-issue for it shares: it
 * must exist (of `kind`, when given) and be inside its fixed end, and a
 * requested scope / permission subset must equal the stored one. Returns the
 * slot's authoritative scope, permissions and auth context, or `null`.
 */
async function liveSlot(
  user: UserDocument,
  sessionId: string,
  kind: RefreshSessionKind | undefined,
  mint: { scope?: TokenScope; permissions?: readonly string[] },
): Promise<LiveSlot | null> {
  const current = await findRefreshSession(user._id, sessionId);
  if (!current || (kind && current.kind !== kind)) return null;
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
  return { current, slotScope, slotPermissions, auth: slotAuth(current) };
}

/** The slot's stored auth context — copied verbatim, never taken from a request. */
function slotAuth(current: RefreshSession): SessionAuth {
  return {
    amr: current.amr,
    aal: current.aal,
    authTime: new Date(current.authTime),
    ...(current.aaguid ? { aaguid: current.aaguid } : {}),
    ...(current.aalAssertedBy ? { aalAssertedBy: current.aalAssertedBy } : {}),
  };
}

/** `$elemMatch` for the slot as it was read, so a concurrent change can't be silently widened. */
function slotMatchOf(sessionId: string, { current, slotScope }: LiveSlot): Record<string, unknown> {
  return { id: sessionId, kind: current.kind, scope: slotScope ?? null };
}

/** `$set` fields recording a use of the slot (`refreshSessions.$` positional). */
function slotUseFields(at: Date, organizationId: string | undefined, client: ClientInfo | undefined): Record<string, unknown> {
  return {
    'refreshSessions.$.lastUsedAt': at,
    ...(organizationId ? { 'refreshSessions.$.activeOrgId': organizationId } : {}),
    ...(client?.userAgent ? { 'refreshSessions.$.userAgent': client.userAgent } : {}),
    ...(client?.ip ? { 'refreshSessions.$.lastIp': client.ip } : {}),
  };
}

/**
 * Re-issue the token pair for an EXISTING refresh-session slot, replacing the
 * slot's hash in one atomic `findOneAndUpdate`.
 *
 * - Refresh passes `presentedToken` and the slot's OWN `kind` (an interactive
 *   or a machine slot both refresh there): the write matches only while the
 *   slot still holds THAT token's hash, of that kind (and the user's
 *   tokenVersion is unchanged), so of two racing uses of one refresh token
 *   exactly one wins.
 * - Generate-token renewal passes `kind: 'machine'`, authenticated by an access
 *   token minted for this slot, so only the slot's existence is required.
 *   (Switch-org never mints a refresh token — see {@link switchSessionOrg}.)
 *
 * The org is the slot's OWN `activeOrgId` (what it was opened in or last
 * switched to) when it still resolves, then `activeOrgId`, then
 * `lastActiveOrgId`, then the earliest membership; the slot is re-pinned to the
 * org actually minted for.
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
  const live = await liveSlot(user, slot.sessionId, slot.kind, mint);
  if (!live) return null;
  const { current, slotScope, slotPermissions, auth } = live;

  const { tokens, refreshHash, historyEntry, organizationId } = await mintTokens(user, {
    sessionId: slot.sessionId,
    orgCandidates: [current.activeOrgId, activeOrgId],
    auth,
    slotExpiresAt: current.expiresAt ? new Date(current.expiresAt) : undefined,
    scope: slotScope,
    mfaEnrollmentPending: current.mfaEnrollmentPending,
    permissions: slotPermissions,
  });
  const slotMatch = {
    ...slotMatchOf(slot.sessionId, live),
    ...(slot.presentedToken === undefined ? {} : { hash: hashRefreshToken(slot.presentedToken) }),
  };
  const updated = await User.findOneAndUpdate(
    { _id: user._id, tokenVersion: user.tokenVersion, refreshSessions: { $elemMatch: slotMatch } },
    {
      $set: {
        'refreshSessions.$.hash': refreshHash,
        ...slotUseFields(historyEntry.createdAt, organizationId, mint.client),
      },
      $push: { issuedTokens: { $each: [historyEntry], $slice: -20 } },
    },
    { projection: { _id: 1 } },
  ).lean();
  return updated ? tokens : null;
}

/** An access token for a switched session — switch-org mints no refresh token. */
export interface SwitchedAccessToken {
  accessToken: string;
  expiresIn: number;
}

/**
 * Switch EXISTING slot `sessionId` to `organizationId`: record the org on the
 * slot and mint an ACCESS token for it. The slot's refresh token is neither
 * minted nor rotated — a switch is authenticated by an access token alone, and
 * a fresh refresh token from it would turn a 15-minute token into a long-lived
 * login (and rotate the legitimate holder's out). The slot's next refresh mints
 * for the org recorded here.
 *
 * Scope, permission subset and auth context come from the slot exactly as on
 * renewal (never widened; assurance inherited, MFA policy enforced). The token
 * is scoped to `organizationId` or nothing — no fallback to another org.
 *
 * Returns `'session-invalid'` when the slot is gone / expired or the
 * tokenVersion moved, `'org-unavailable'` when the org no longer resolves for
 * the user. Nothing is persisted on either.
 */
export async function switchSessionOrg(
  user: UserDocument,
  organizationId: string,
  sessionId: string,
  { client }: { client?: ClientInfo } = {},
): Promise<SwitchedAccessToken | 'session-invalid' | 'org-unavailable'> {
  const live = await liveSlot(user, sessionId, undefined, {});
  if (!live) return 'session-invalid';
  const { current, slotScope, slotPermissions, auth } = live;

  const minted = await mintAccessToken(user, {
    sessionId,
    orgCandidates: [organizationId],
    exactOrg: true,
    auth,
    slotExpiresAt: current.expiresAt ? new Date(current.expiresAt) : undefined,
    scope: slotScope,
    mfaEnrollmentPending: current.mfaEnrollmentPending,
    permissions: slotPermissions,
  });
  if (minted.organizationId !== organizationId) return 'org-unavailable';

  const updated = await User.findOneAndUpdate(
    { _id: user._id, tokenVersion: user.tokenVersion, refreshSessions: { $elemMatch: slotMatchOf(sessionId, live) } },
    {
      $set: slotUseFields(minted.historyEntry.createdAt, organizationId, client),
      $push: { issuedTokens: { $each: [minted.historyEntry], $slice: -20 } },
    },
    { projection: { _id: 1 } },
  ).lean();
  return updated ? { accessToken: minted.accessToken, expiresIn: minted.expiresIn } : 'session-invalid';
}
