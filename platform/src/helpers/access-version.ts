// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The version an ACCESS token carries in its `tokenVersion` claim — and the
 * value published to the services' revocation store (`authrev:tv:<userId>`):
 * `tokenVersion` (hard revocation) + `claimsVersion` (stale claims).
 *
 * Both counters only ever grow, so the sum does too. A bump of EITHER makes
 * every outstanding access token stale everywhere; only a `tokenVersion` bump
 * also kills the refresh tokens (which carry the bare `tokenVersion`), so a
 * claims change (Role, tier, feature, ownership, hierarchy) costs the person a
 * silent refresh — never a sign-in.
 *
 * Pure, dependency-free: the auth middleware, the token signer and the
 * revocation publisher all share it.
 */
export function accessTokenVersion(user: { tokenVersion?: number; claimsVersion?: number }): number {
  return (user.tokenVersion ?? 0) + (user.claimsVersion ?? 0);
}
