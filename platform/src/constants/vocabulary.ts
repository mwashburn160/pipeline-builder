// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform's closed string vocabularies: each is an `as const` tuple with the
 * union type derived from it, and the Mongoose enum, the Zod request schema and
 * every filter/guard build from that one tuple. Each used to be spelled out
 * separately in its model, its request schema and its list filter.
 *
 * Deliberately a module with NO imports, for the reason
 * `constants/impersonation.ts` gives: request schemas, models and helpers all
 * read these, and a constant reached through the (often partially mocked)
 * models barrel breaks every suite that mocks it.
 *
 * Vocabularies that cross to other services or the browser live in api-core's
 * `types/wire-vocabulary.ts` instead (IdP providers/protocols, role grants,
 * membership roles, alert channels and severities). Code that must not reach
 * api-core's (often partially mocked) root imports them through the
 * dependency-free `@pipeline-builder/api-core/wire-vocabulary` subpath.
 */

// -----------------------------------------------------------------------------
// Invitations
// -----------------------------------------------------------------------------

/** An invitation's lifecycle state. Only `pending` is acceptable. */
export const INVITATION_STATUSES = ['pending', 'accepted', 'expired', 'revoked'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** How an invitation may be accepted. */
export const INVITATION_TYPES = ['email', 'oauth', 'any'] as const;
export type InvitationType = (typeof INVITATION_TYPES)[number];

// -----------------------------------------------------------------------------
// Org policy
// -----------------------------------------------------------------------------

/**
 * An org's impersonation policy, ordered LOOSEST → STRICTEST: a policy's index
 * IS its strictness rank, read by both the hierarchy combiner (strictest wins)
 * and the loosening check that demands assurance. They kept two orderings — a
 * rank table and this list's `indexOf` — that agreed only by coincidence.
 */
export const IMPERSONATION_POLICIES = ['open', 'consent', 'denied'] as const;
export type ImpersonationPolicy = (typeof IMPERSONATION_POLICIES)[number];

/**
 * A registered domain's discovery mode:
 *   - `off`     — registered but not offered for discovery (default until an
 *                 admin opts in).
 *   - `request` — matching signups may REQUEST to join; an admin approves.
 *   - `auto`    — matching signups join immediately as a member (use only for
 *                 domains you fully control).
 */
export const DOMAIN_JOIN_MODES = ['off', 'request', 'auto'] as const;
export type DomainJoinMode = (typeof DOMAIN_JOIN_MODES)[number];

// -----------------------------------------------------------------------------
// Sessions
// -----------------------------------------------------------------------------

/**
 * A refresh-session slot's kind:
 * - `interactive` — a person signed in (password, OAuth, SSO). Renewed by
 *   POST /auth/refresh; capped at `MAX_REFRESH_SESSIONS`, oldest pushed out.
 * - `machine` — a stored credential opened by POST /user/generate-token. Has a
 *   fixed end (`expiresAt` = the requested lifetime); renewed by POST
 *   /auth/refresh with the slot's OWN refresh token (its access tokens have the
 *   normal short lifetime); capped separately, least recently used evicted.
 */
export const REFRESH_SESSION_KINDS = ['interactive', 'machine'] as const;
export type RefreshSessionKind = (typeof REFRESH_SESSION_KINDS)[number];

// -----------------------------------------------------------------------------
// Audit
// -----------------------------------------------------------------------------

/** Whether an audited action succeeded. Absent reads as `success`. */
export const AUDIT_OUTCOMES = ['success', 'failure'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** Whether `value` is an audit outcome, narrowing it. */
export function isAuditOutcome(value: unknown): value is AuditOutcome {
  return (AUDIT_OUTCOMES as readonly unknown[]).includes(value);
}
