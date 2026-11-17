// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether an impersonation session has OUTLIVED its operator — the one rule
 * shared by platform's auth middleware (which refuses the token per request) and
 * the revocation publisher (which ends the session everywhere the moment the
 * operator is revoked, so stateless services stop accepting it too).
 *
 * Pure and dependency-free so both can import it without dragging in models.
 *
 * The session is stale when:
 *   - the record carries no operator stamp (`requesterTokenVersion`) — redeemed
 *     before the stamp existed; fail closed;
 *   - the operator no longer exists;
 *   - their hard `tokenVersion` moved (sign-out everywhere, password reset, …);
 *   - it was opened as a SUPERADMIN and they no longer hold the flag;
 *   - it was opened under TENANT authority (an ancestor-org admin, not the
 *     superadmin flag) and their `claimsVersion` moved — a role, membership or
 *     org change is exactly what can take that authority away, so the session
 *     does not survive it. A record without the stamp fails closed.
 *
 * Superadmin sessions deliberately ignore `claimsVersion`: their authority is the
 * flag, which is checked directly.
 */
export interface ImpersonationOperatorStamp {
  requesterTokenVersion?: number;
  requesterClaimsVersion?: number;
  requesterSuperAdmin?: boolean;
}

export interface ImpersonationOperatorState {
  tokenVersion?: number;
  claimsVersion?: number;
  isSuperAdmin?: boolean;
}

export function isImpersonationOperatorStale(
  session: ImpersonationOperatorStamp,
  operator: ImpersonationOperatorState | null | undefined,
): boolean {
  if (typeof session.requesterTokenVersion !== 'number') return true;
  if (!operator) return true;
  if ((operator.tokenVersion ?? 0) !== session.requesterTokenVersion) return true;
  if (session.requesterSuperAdmin === true) return operator.isSuperAdmin !== true;
  if (typeof session.requesterClaimsVersion !== 'number') return true;
  return (operator.claimsVersion ?? 0) !== session.requesterClaimsVersion;
}
