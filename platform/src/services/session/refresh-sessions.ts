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
import { deleteSlot, findSlot, insertSlot, updateSlotIf, type RefreshSession } from './session-store.js';
import { config } from '../../config/index.js';
import type { RefreshSessionKind } from '../../constants/vocabulary.js';
import type { ClientInfo } from '../../helpers/client-info.js';
import { interactiveSessionExpired, interactiveSessionEnd, platformSessionLimits, sessionLimitsFor } from '../../helpers/session-policy.js';
import { publishSessionSlotRevocation } from '../../helpers/session-revocation.js';
import { User } from '../../models/index.js';
import type { UserDocument } from '../../models/user.js';
import type { RefreshTokenPayload } from '../../types/index.js';
import { SESSION_EXPIRED, TOKEN_SCOPE_ESCALATION } from '../auth-errors.js';
import { signUserJwt } from '../token-signing/index.js';

export type { RefreshSession } from './session-store.js';

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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the TTL index may drop a slot: the last moment it could still renew under
 * the PLATFORM ceiling (an org can only shorten it, and that is enforced at
 * renewal, not by deletion).
 *   - interactive: the earlier of `authTime` + the platform maximum age and
 *     the end of its current refresh token (`lastUsedAt` + the refresh TTL).
 *     The idle timeout is NOT folded in, so an idle-expired slot still answers
 *     `SESSION_EXPIRED` (rather than "no such session") until its absolute end.
 *   - machine: its fixed `expiresAt`, else the end of its current refresh token.
 */
function purgeAtFor(slot: { kind: RefreshSessionKind; authTime: Date; lastUsedAt: Date; expiresAt?: Date }): Date {
  const refreshEnd = new Date(slot.lastUsedAt).getTime() + config.auth.refreshToken.expiresIn * 1000;
  if (slot.kind === 'machine') {
    return new Date(slot.expiresAt ? new Date(slot.expiresAt).getTime() : refreshEnd);
  }
  const absoluteEnd = new Date(slot.authTime).getTime() + platformSessionLimits().maxAgeDays * DAY_MS;
  return new Date(Math.min(absoluteEnd, refreshEnd));
}

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
  /** INTERACTIVE slots: the session's absolute end under the policy of the org
   *  minted for (nothing minted outlives it). */
  sessionEndsAt?: Date;
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
  /**
   * INTERACTIVE slots: when the session was signed into and last used. Once the
   * org is resolved, the session-lifetime policy of THAT org (strictest with the
   * platform ceiling, helpers/session-policy.ts) is applied: a session past its
   * maximum age or idle timeout mints nothing (`SESSION_EXPIRED`), and nothing
   * minted outlives its maximum age.
   */
  lifetime?: { authTime: Date; lastUsedAt: Date };
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

  // Session lifetime, judged by the policy of the org this token is FOR — known
  // only now that the membership is resolved (a fallback org's policy counts
  // exactly like the slot's own).
  const now = new Date();
  let sessionEndsAt: Date | undefined;
  if (opts.lifetime) {
    const limits = await sessionLimitsFor([membership?.organizationId]);
    if (interactiveSessionExpired(opts.lifetime, limits, now)) throw new Error(SESSION_EXPIRED);
    sessionEndsAt = interactiveSessionEnd(opts.lifetime, limits).absoluteEnd;
  }

  // Per-tier override → global default. The per-tier path lets
  // compliance-driven customers (enterprise tiers) narrow the stolen-token
  // blast window without forcing every user to re-auth more often. A slot with
  // a fixed end (a machine credential) never mints past it: neither its access
  // token nor its refresh token outlives the slot; nor does anything minted
  // for an interactive session outlive its maximum age.
  const tokenExpiresIn = accessTokenLifetime(membership, slotExpiresAt ?? sessionEndsAt, now);

  const accessToken = await signUserJwt(
    createAccessTokenPayload(user, membership, { auth, tokenUse: 'access', scope, permissions, sessionId, mfaEnrollmentPending }),
    { expiresIn: tokenExpiresIn },
  );

  return {
    accessToken,
    expiresIn: tokenExpiresIn,
    ...(sessionEndsAt ? { sessionEndsAt } : {}),
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
  // A machine slot's refresh token runs to the slot's fixed end; an interactive
  // one's for the refresh TTL, never past the session's maximum age.
  const refreshExpiresIn = slotRemainingSeconds(opts.slotExpiresAt, minted.historyEntry.createdAt)
    ?? Math.min(
      config.auth.refreshToken.expiresIn,
      slotRemainingSeconds(minted.sessionEndsAt, minted.historyEntry.createdAt) ?? Number.POSITIVE_INFINITY,
    );
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
 * Open a NEW refresh-session slot and mint its token pair.
 *
 * `interactive` — sign-in (password, OAuth, SSO) on a device. `machine` — a
 * stored credential from generate-token. Each kind has its own cap (see
 * {@link MAX_REFRESH_SESSIONS} / {@link MAX_MACHINE_SESSIONS}); opening one
 * never evicts a slot of the other kind. The slot stores the scope and the
 * auth context, so later renewals can neither widen the one nor raise the other.
 *
 * @param user - User document to generate tokens for (the full account, loaded with `+isSuperAdmin`)
 * @param activeOrgId - Optional org ID to use as active (falls back to lastActiveOrgId, then first membership)
 */
export async function issueTokens(user: UserDocument, activeOrgId: string | undefined, session: NewSession): Promise<IssuedTokens> {
  const sessionId = crypto.randomBytes(12).toString('hex');
  const openedAt = new Date();
  const slotExpiresAt = session.lifetimeSeconds !== undefined
    ? new Date(openedAt.getTime() + session.lifetimeSeconds * 1000)
    : undefined;
  const { tokens, refreshHash, historyEntry, organizationId } = await mintTokens(user, {
    sessionId,
    orgCandidates: [activeOrgId],
    opensSession: true,
    auth: session.auth,
    slotExpiresAt,
    // An interactive slot that INHERITS an older sign-in (a device approval,
    // the survivor of "sign out everywhere") is bounded by that sign-in's age.
    ...(session.kind === 'interactive' ? { lifetime: { authTime: session.auth.authTime, lastUsedAt: openedAt } } : {}),
    scope: session.scope,
    mfaEnrollmentPending: session.mfaEnrollmentPending,
    permissions: session.permissions,
  });
  const slot: RefreshSession = {
    id: sessionId,
    kind: session.kind,
    tokenVersion: user.tokenVersion,
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
    purgeAt: historyEntry.createdAt,
  };
  slot.purgeAt = purgeAtFor(slot);
  const evicted = await insertSlot(
    user._id,
    slot,
    session.kind === 'interactive' ? MAX_REFRESH_SESSIONS : MAX_MACHINE_SESSIONS,
  );
  await recordIssuedToken(user._id, historyEntry);
  // A slot pushed out by the per-kind cap is signed out like any other: its
  // live access token must stop working on every service, not just here.
  if (evicted.length > 0) await publishSessionSlotRevocation(evicted);
  return tokens;
}

/** Append to the user's `issuedTokens` history (ring-buffered to the 20 most recent). */
async function recordIssuedToken(userId: Types.ObjectId | string, entry: MintedAccessToken['historyEntry']): Promise<void> {
  await User.updateOne({ _id: userId }, { $push: { issuedTokens: { $each: [entry], $slice: -20 } } });
}

/** One slot of `user`, or `undefined` when it no longer exists. */
export async function findRefreshSession(userId: Types.ObjectId | string, sessionId: string): Promise<RefreshSession | undefined> {
  return findSlot(userId, sessionId);
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
 * must exist at the user's current `tokenVersion` (of `kind`, when given) and be
 * inside its fixed end, and a requested scope / permission subset must equal the
 * stored one. Returns the slot's authoritative scope, permissions and auth
 * context, or `null`. A machine slot past its fixed end is dropped and refused
 * with `SESSION_EXPIRED` (an interactive slot's lifetime is judged at mint, by
 * the policy of the org minted for — see {@link mintAccessToken}).
 */
async function liveSlot(
  user: UserDocument,
  sessionId: string,
  kind: RefreshSessionKind | undefined,
  mint: { scope?: TokenScope; permissions?: readonly string[] },
): Promise<LiveSlot | null> {
  const current = await findSlot(user._id, sessionId);
  if (!current || (kind && current.kind !== kind)) return null;
  // A slot opened before the user's last hard revocation is dead, whether or
  // not the bump site got round to deleting it.
  if (current.tokenVersion !== user.tokenVersion) return null;
  // A slot past its fixed end (a machine credential's lifetime) renews nothing.
  if (current.expiresAt && new Date(current.expiresAt).getTime() <= Date.now()) {
    await endExpiredSlot(user._id, sessionId);
    throw new Error(SESSION_EXPIRED);
  }
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

/** Drop a slot whose life is over and end its live access token everywhere. */
async function endExpiredSlot(userId: Types.ObjectId | string, sessionId: string): Promise<void> {
  await deleteSlot(userId, sessionId);
  await publishSessionSlotRevocation(sessionId);
}

/**
 * Run a mint for a live slot; a `SESSION_EXPIRED` refusal (the session-lifetime
 * policy) also drops the slot, so its live access token dies with it.
 */
async function mintForSlot<T>(user: UserDocument, sessionId: string, mint: () => Promise<T>): Promise<T> {
  try {
    return await mint();
  } catch (error) {
    if (error instanceof Error && error.message === SESSION_EXPIRED) await endExpiredSlot(user._id, sessionId);
    throw error;
  }
}

/** The lifetime inputs of an INTERACTIVE slot (machine slots have a fixed end instead). */
function lifetimeOf(current: RefreshSession): MintOptions['lifetime'] {
  return current.kind === 'interactive'
    ? { authTime: new Date(current.authTime), lastUsedAt: new Date(current.lastUsedAt) }
    : undefined;
}

/** The compare-and-set match for the slot as it was read, so a concurrent change can't be silently widened. */
function slotMatchOf(user: UserDocument, sessionId: string, { current, slotScope }: LiveSlot) {
  return { id: sessionId, tokenVersion: user.tokenVersion, kind: current.kind, scope: slotScope ?? null };
}

/** `$set` fields recording a use of the slot. */
function slotUseFields(
  current: RefreshSession,
  at: Date,
  organizationId: string | undefined,
  client: ClientInfo | undefined,
): Record<string, unknown> {
  return {
    lastUsedAt: at,
    purgeAt: purgeAtFor({ ...current, lastUsedAt: at }),
    ...(organizationId ? { activeOrgId: organizationId } : {}),
    ...(client?.userAgent ? { userAgent: client.userAgent } : {}),
    ...(client?.ip ? { lastIp: client.ip } : {}),
  };
}

/**
 * Re-issue the token pair for an EXISTING refresh-session slot, replacing the
 * slot's hash in one atomic compare-and-set (`updateSlotIf`).
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
 *
 * Throws `SESSION_EXPIRED` (and drops the slot) when the session's life is over:
 * an interactive slot past its maximum age or idle timeout under the policy of
 * the org it is minted for, or a machine slot past its fixed end.
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

  const { tokens, refreshHash, historyEntry, organizationId } = await mintForSlot(user, slot.sessionId, () => mintTokens(user, {
    sessionId: slot.sessionId,
    orgCandidates: [current.activeOrgId, activeOrgId],
    auth,
    slotExpiresAt: current.expiresAt ? new Date(current.expiresAt) : undefined,
    lifetime: lifetimeOf(current),
    scope: slotScope,
    mfaEnrollmentPending: current.mfaEnrollmentPending,
    permissions: slotPermissions,
  }));
  const updated = await updateSlotIf(
    user._id,
    {
      ...slotMatchOf(user, slot.sessionId, live),
      ...(slot.presentedToken === undefined ? {} : { hash: hashRefreshToken(slot.presentedToken) }),
    },
    { hash: refreshHash, ...slotUseFields(current, historyEntry.createdAt, organizationId, mint.client) },
  );
  if (!updated) return null;
  await recordIssuedToken(user._id, historyEntry);
  return tokens;
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
 * Returns `'session-invalid'` when the slot is gone or the tokenVersion moved,
 * `'session-expired'` when the session is older (or idler) than the
 * destination org's session policy allows (the slot itself is kept — it is
 * still valid in its current org), and `'org-unavailable'` when the org no
 * longer resolves for the user. Nothing is persisted on any of them. A machine
 * slot past its fixed end throws `SESSION_EXPIRED` (and is dropped).
 */
export async function switchSessionOrg(
  user: UserDocument,
  organizationId: string,
  sessionId: string,
  { client }: { client?: ClientInfo } = {},
): Promise<SwitchedAccessToken | 'session-invalid' | 'session-expired' | 'org-unavailable'> {
  const live = await liveSlot(user, sessionId, undefined, {});
  if (!live) return 'session-invalid';
  const { current, slotScope, slotPermissions, auth } = live;

  let minted: MintedAccessToken;
  try {
    minted = await mintAccessToken(user, {
      sessionId,
      orgCandidates: [organizationId],
      exactOrg: true,
      auth,
      slotExpiresAt: current.expiresAt ? new Date(current.expiresAt) : undefined,
      lifetime: lifetimeOf(current),
      scope: slotScope,
      mfaEnrollmentPending: current.mfaEnrollmentPending,
      permissions: slotPermissions,
    });
  } catch (error) {
    // Too old (or idle) for the DESTINATION org's session policy. The session
    // stays valid where it is — only entering that org needs a fresh sign-in.
    if (error instanceof Error && error.message === SESSION_EXPIRED) return 'session-expired';
    throw error;
  }
  if (minted.organizationId !== organizationId) return 'org-unavailable';

  const updated = await updateSlotIf(
    user._id,
    slotMatchOf(user, sessionId, live),
    slotUseFields(current, minted.historyEntry.createdAt, organizationId, client),
  );
  if (!updated) return 'session-invalid';
  await recordIssuedToken(user._id, minted.historyEntry);
  return { accessToken: minted.accessToken, expiresIn: minted.expiresIn };
}
