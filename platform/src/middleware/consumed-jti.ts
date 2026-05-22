// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Single-use enforcement for step-up tokens.
 *
 * Tracks `jti → expirySeconds` for the brief window between issue and
 * expiry. A jti seen for the second time is rejected as replay.
 *
 * Storage: process-local Map. This means:
 *   - Single-instance deployments get true single-use.
 *   - Multi-instance deployments get best-effort single-use within each
 *     process; a token replayed against a DIFFERENT instance succeeds.
 *     Acceptable given the 60s TTL (load balancers sticky-route most
 *     bursts to the same backend) — when the trade-off becomes too thin,
 *     swap this module for a Redis-backed implementation.
 *
 * Lazy cleanup: each `consumeJti` call also evicts any entries that have
 * expired. Token TTL is 60s by default so the map stays small (one entry
 * per active step-up flow across the fleet).
 */

const consumed = new Map<string, number>();

/** Evict entries whose expiry has passed. Called on every consume; cheap. */
function evictExpired(nowSeconds: number): void {
  for (const [jti, exp] of consumed) {
    if (exp <= nowSeconds) consumed.delete(jti);
  }
}

/**
 * Mark a jti as consumed.
 * @returns true if newly consumed (caller may proceed); false if it was
 *   already consumed or already expired (caller must reject the request).
 */
export function consumeJti(jti: string, expirySeconds: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  evictExpired(now);

  if (expirySeconds <= now) return false; // expired token
  if (consumed.has(jti)) return false; // replay

  consumed.set(jti, expirySeconds);
  return true;
}

/** Test-only: clear the consumed set. Don't call from production code. */
export function _resetConsumedJtiForTests(): void {
  consumed.clear();
}
