// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Session invalidation: the token-version revocation store and the
 * impersonation-session liveness check `requireAuth` consults after verifying a token.
 */

import { type JwtPayload } from '../types/common.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('auth-middleware');
/**
 * A source of the CURRENT `tokenVersion` for a user, backed by a store the
 * stateless services can read (in practice a Redis key the platform publishes
 * to on every privilege change). Registered via {@link setTokenRevocationStore}.
 *
 * `getCurrentVersion` returns the user's current version, or `null` when the
 * store has no entry — a miss is treated as "no known revocation" (fail-open):
 * revocation entries are published with a TTL matching the access-token
 * lifetime, so a missing entry means any token old enough to predate it has
 * already expired on its own.
 */
export interface TokenRevocationStore {
  getCurrentVersion(userId: string): Promise<number | null>;
  /**
   * Whether one IMPERSONATION session (by token `jti`) has been ended early.
   *
   * Optional so a store that predates it still links — but a store WITHOUT it
   * cannot answer, and an impersonation token is then REJECTED. Unlike
   * `getCurrentVersion`, this is deliberately not fail-open: the platform ends a
   * session when someone withdraws consent, and a withdrawn consent that keeps
   * working in every other service is not withdrawn.
   */
  getSessionRevocation?(jti: string): Promise<SessionRevocationState>;
  /**
   * Whether ONE credential the token rides on has been revoked — its session
   * slot (`sid`) or the access key it was exchanged from / derived from (see
   * {@link credentialRevocationRefs}). Fail-open like `getCurrentVersion`: a
   * store that can't answer returns `false`.
   */
  isCredentialRevoked?(refs: CredentialRevocationRefs): Promise<boolean>;
}

/** The single-credential ids a token can be revoked by (`revoke:sid:` / `revoke:key:`). */
export interface CredentialRevocationRefs {
  /** The refresh-session slot the token was minted with. */
  sid?: string;
  /** Access-key ids: the exchanged key's own `jti`, and any `parentKeyId`. */
  keyIds: string[];
}

/**
 * The credential ids a verified token can be revoked by. An exchanged key token
 * (`token_use: 'api_key'`) is named by its `jti`; a token derived from one
 * carries `parentKeyId`; a session-minted token carries `sid`. Returns `null`
 * when the token names none of them.
 */
export function credentialRevocationRefs(
  claims: Pick<JwtPayload, 'sid' | 'parentKeyId' | 'jti' | 'token_use'>,
): CredentialRevocationRefs | null {
  const keyIds = new Set<string>();
  if (claims.token_use === 'api_key' && typeof claims.jti === 'string' && claims.jti) keyIds.add(claims.jti);
  if (typeof claims.parentKeyId === 'string' && claims.parentKeyId) keyIds.add(claims.parentKeyId);
  const sid = typeof claims.sid === 'string' && claims.sid ? claims.sid : undefined;
  if (!sid && keyIds.size === 0) return null;
  return { ...(sid ? { sid } : {}), keyIds: [...keyIds] };
}

/**
 * `revoked`     — the session was ended; reject.
 * `live`        — no revocation recorded; allow.
 * `unavailable` — the store couldn't be read or can't answer; REJECT. Distinct
 *                 from `live` precisely so an outage can't read as "not revoked".
 */
export type SessionRevocationState = 'revoked' | 'live' | 'unavailable';

let tokenRevocationStore: TokenRevocationStore | undefined;

/**
 * Register (or clear, with `undefined`) the process-wide token-revocation store.
 * When unset (the default), `requireAuth` performs NO revocation check (it relies
 * on the short access-token TTL); services opt in at boot by wiring their Redis
 * client. Platform keeps its own Mongo-backed check and need not register one.
 */
export function setTokenRevocationStore(store: TokenRevocationStore | undefined): void {
  tokenRevocationStore = store;
  if (store) revocationStoreMissingWarned = false; // re-arm if a store is (re)registered
}

/** One-shot guard so the "revocation inactive" warning doesn't flood the logs. */
let revocationStoreMissingWarned = false;

/**
 * Returns true when `decoded` has been revoked per the registered store: its
 * embedded `tokenVersion` is strictly behind the store's current version.
 * Fail-open — any store error, a missing entry, or a token/store without a
 * usable version yields `false` (allow). Never throws.
 */
async function isTokenRevoked(decoded: JwtPayload): Promise<boolean> {
  const store = tokenRevocationStore;
  if (!store) {
    // Make the "revocation is OFF" state OBSERVABLE: a service that verifies user
    // tokens but forgot `setTokenRevocationStore()` silently disables the session
    // kill-switch. Warn ONCE (only for a revocable user token) so a misconfigured
    // boot surfaces in the logs instead of failing open invisibly.
    if (!revocationStoreMissingWarned && decoded.sub && typeof decoded.tokenVersion === 'number') {
      revocationStoreMissingWarned = true;
      logger.warn('Token revocation store NOT registered — revocation checks are INACTIVE (setTokenRevocationStore was never called); revoked/compromised sessions stay valid until natural TTL');
    }
    return false;
  }
  if (store.isCredentialRevoked) {
    const refs = credentialRevocationRefs(decoded);
    if (refs) {
      try {
        if (await store.isCredentialRevoked(refs)) return true;
      } catch {
        // Fail-open, as below.
      }
    }
  }
  if (!decoded.sub || typeof decoded.tokenVersion !== 'number') return false;
  try {
    const current = await store.getCurrentVersion(decoded.sub);
    return current !== null && decoded.tokenVersion < current;
  } catch {
    // Fail-open: a revocation-store outage must not lock every user out.
    return false;
  }
}

/** Whether the registered store has anything to say about this token. */
function hasRevocationCheck(decoded: JwtPayload): boolean {
  const store = tokenRevocationStore;
  if (!store) return false;
  if (decoded.sub && typeof decoded.tokenVersion === 'number') return true;
  return !!store.isCredentialRevoked && credentialRevocationRefs(decoded) !== null;
}

/** Methods a read-only impersonation token may use. */
const IMPERSONATION_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a request is a WRITE under a read-only impersonation token. Fail-closed
 * on a missing method: only a request positively known to be a read passes.
 */
export function isImpersonationWriteBlocked(
  method: string | undefined,
  claims: Pick<JwtPayload, 'impersonationReadOnly'>,
): boolean {
  return claims.impersonationReadOnly === true && !IMPERSONATION_READ_METHODS.has((method ?? '').toUpperCase());
}

/**
 * Resolve an impersonation session's revocation state. Never throws: any failure
 * — no store, a store that can't answer, a read error — is `unavailable`, which
 * callers treat as revoked.
 */
async function sessionRevocationState(jti: string): Promise<SessionRevocationState> {
  const store = tokenRevocationStore;
  if (!store?.getSessionRevocation) return 'unavailable';
  try {
    return await store.getSessionRevocation(jti);
  } catch {
    return 'unavailable';
  }
}

/** An impersonation session token: it names the operator AND carries its own session id. */
function isImpersonationSession(decoded: { impersonatorId?: unknown; jti?: unknown }): decoded is { impersonatorId: string; jti: string } {
  return typeof decoded.impersonatorId === 'string' && typeof decoded.jti === 'string' && decoded.jti.length > 0;
}

/**
 * Public revocation check for routes that verify a platform JWT OUTSIDE
 * `requireAuth` (e.g. the image-registry `/token` mint path, which resolves
 * identity itself). Returns true when the token's `tokenVersion` is strictly
 * behind the store's current version. Fail-open (never throws) — a store outage
 * or a token/store without a usable version yields false (allow), matching
 * `requireAuth`. Pass the verified JWT claims (`sub`, `tokenVersion`).
 */
export async function isAccessTokenRevoked(
  claims: {
    sub?: string;
    tokenVersion?: number;
    jti?: string;
    impersonatorId?: string;
    sid?: string;
    parentKeyId?: string;
    token_use?: JwtPayload['token_use'];
  },
): Promise<boolean> {
  // An impersonation session is revoked unless the store positively says live —
  // including on this out-of-band path, or a revoked session could still mint
  // registry tokens.
  if (isImpersonationSession(claims) && await sessionRevocationState(claims.jti) !== 'live') return true;
  return isTokenRevoked(claims as unknown as JwtPayload);
}


/** Whether `requireAuth` must consult the revocation stores for this token. */
export function needsRevocationCheck(decoded: JwtPayload): boolean {
  return isImpersonationSession(decoded) || hasRevocationCheck(decoded);
}

/**
 * The post-verification session-invalidation check. Returns the refusal
 * message, or `null` when the session is live. An impersonation session is
 * checked even when NO store is registered: there, no store ⇒ unavailable ⇒
 * refused (see `TokenRevocationStore.getSessionRevocation`); the tokenVersion
 * check is a no-op without a store and fails open on a store error. Never rejects.
 */
export async function checkRevocation(decoded: JwtPayload): Promise<string | null> {
  if (isImpersonationSession(decoded)) {
    const state = await sessionRevocationState(decoded.jti);
    if (state !== 'live') {
      return state === 'revoked'
        ? 'This impersonation session has been ended'
        : 'This impersonation session could not be verified';
    }
  }
  if (hasRevocationCheck(decoded) && await isTokenRevoked(decoded)) {
    return 'Session has been revoked; please sign in again';
  }
  return null;
}
