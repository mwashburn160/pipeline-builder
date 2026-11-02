// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { audited, dynamicAuthz, requireAssurance, requireStepUp, STRONG_STEP_UP_METHODS } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  breakglassImpersonation,
  decideImpersonationRequest,
  impersonateUser,
  listImpersonationRequests,
  redeemImpersonationRequest,
  revokeImpersonationSession,
} from '../controllers/impersonate.js';
import { requireAuth } from '../middleware/index.js';

const router: Router = Router({ mergeParams: true });

/**
 * ASSURANCE. Every route below that MINTS an impersonation session demands
 * two things that a stolen browser session cannot supply on its own:
 *
 *   - `requireAssurance({ minAssurance: 2 })` — the operator's whole SESSION must
 *     be MFA-grade. A weaker one gets 401 `MFA_REQUIRED`; it can never be raised
 *     by refreshing, so the operator signs in again with a passkey or an
 *     authenticator code.
 *   - `requireStepUp({ methods: STRONG_STEP_UP_METHODS })` — and the action must
 *     be confirmed by a SECOND factor specifically. Re-typing the password the
 *     session was already opened with proves nothing an attacker holding that
 *     session doesn't already have.
 *
 * Deciding and revoking stay as they were: they only ever remove access, and the
 * decider is answering a question about their own account.
 */

/**
 * Decide a pending challenge, and end a live session early.
 *
 * Declared BEFORE `/:userId` — Express matches in order, so `/requests/...`
 * would otherwise be swallowed by the `:userId` parameter and treated as an
 * impersonation of a user literally named "requests".
 *
 * No step-up on either: the decider is answering a question about their OWN
 * account, and revoking only ever REMOVES access — gating the off-switch behind
 * a password prompt would make it harder to stop a session than to allow one.
 */
/** What the caller can act on. No step-up: listing grants nothing, and the
 *  impersonated user — usually not an admin — must be able to find a request to
 *  view their own account. Filtered server-side by the decide/revoke rules. */
router.get(
  '/requests',
  requireAuth,
  dynamicAuthz(
    'ANY authenticated caller; the result set is filtered to what they may act on — their own '
      + 'requests as subject or requester, their org subtree as a tenant admin holding '
      + '`impersonation:approve` (the to-decide view only; revocable sessions do not need it), '
      + 'and the break-glass queue for the superadmin FLAG. The old declaration named an '
      + 'authority gate this route does not have. Not `system-org`: holding '
      + '`impersonation:open` adds nothing to this list beyond your own requests.',
    {
      reachableBy: ['superadmin', 'tenant-admin', 'tenant-member', 'subject'],
      permissions: ['impersonation:approve'],
    },
  ),
  listImpersonationRequests,
);
router.post(
  '/requests/:id/decide',
  requireAuth,
  dynamicAuthz(
    'never the requester; then ORDINARY requests are decided by the named approver, or by an '
      + 'admin/owner of the target org (or an ancestor of it) holding `impersonation:approve` — '
      + 'a superadmin is REFUSED here on purpose, because consent belongs to the tenant. '
      + 'BREAK-GLASS requests are the opposite: a second superadmin and nobody else (four-eyes).',
    { reachableBy: ['superadmin', 'tenant-admin', 'subject'], permissions: ['impersonation:approve'] },
  ),
  audited('admin.impersonate.approve', 'admin.impersonate.deny'),
  decideImpersonationRequest,
);
router.post(
  '/requests/:id/revoke',
  requireAuth,
  dynamicAuthz(
    'the subject, the requester, the decider, or an admin of the pinned org (`canAdministerOrg`, '
      + 'which a superadmin satisfies). Revoking only ever REMOVES access, so the set is wide '
      + 'deliberately — the previous declaration named only two of the four.',
    { reachableBy: ['superadmin', 'tenant-admin', 'tenant-member', 'subject'] },
  ),
  audited('admin.impersonate.revoke'),
  revokeImpersonationSession,
);
/** Redeem IS step-up gated: it mints the session token — the sensitive act. The
 *  step-up done when the request was opened is single-use and long gone after an
 *  approval that may take up to the request TTL. */
router.post(
  '/requests/:id/redeem',
  requireAuth,
  dynamicAuthz(
    'the REQUESTER only, with their authority re-resolved now rather than trusted from request '
      + 'time — so a lost permission, admin role or org relationship refuses the redemption. '
      + 'That means a parent-org admin too, not only the vendor: the previous declaration said '
      + '"sysadmin", which was never the whole set. Break-glass redemption stays flag-only.',
    { reachableBy: ['superadmin', 'system-org', 'tenant-admin'], permissions: ['impersonation:open', 'team_access:open'] },
  ),
  requireAssurance({ minAssurance: 2 }),
  requireStepUp({ methods: STRONG_STEP_UP_METHODS }),
  audited('admin.impersonate.start'),
  redeemImpersonationRequest,
);

/**
 * Emergency access. Step-up gated like every token-minting path.
 *
 * The superadmin FLAG and nothing else (`isSystemAdmin` in the controller) — not
 * `impersonation:open`, and not a parent-org admin. Break-glass walks past the
 * tenant's consent policy, so it must not be reachable by a permission that can
 * be delegated through a Role; a second superadmin approves it. The previous
 * declaration claimed an ancestor-admin clause this route has never had.
 */
router.post(
  '/:userId/breakglass',
  requireAuth,
  dynamicAuthz(
    'the superadmin FLAG only — no permission grants emergency access, because it bypasses the '
      + "target organisation's consent policy. Approved by a SECOND superadmin (four-eyes).",
    { reachableBy: ['superadmin'] },
  ),
  requireAssurance({ minAssurance: 2 }),
  requireStepUp({ methods: STRONG_STEP_UP_METHODS }),
  audited('admin.impersonate.breakglass', 'admin.impersonate.start'),
  breakglassImpersonation,
);

/**
 * POST /admin/impersonate/:userId — start a read-only impersonation session of
 * the target user.
 *
 * Two callers qualify, each on its own permission: a member of the SYSTEM org
 * holding `impersonation:open` (any target, cross-tenant, still consent-gated),
 * or an admin/owner of an org that is a strict ancestor of the target's org
 * holding `team_access:open` (their own subtree only). That depends on BOTH
 * parties — specifically on the org the session pins to — so it cannot be a
 * route-level middleware and is resolved in the controller by
 * `resolveImpersonationAuthority`.
 *
 * Step-up applies to EVERY caller. A parent admin's session is no less
 * sensitive than a sysadmin's, and an admin session is the likelier of the two
 * to be stolen.
 */
router.post(
  '/:userId',
  requireAuth,
  dynamicAuthz(
    'a SYSTEM-org member holding `impersonation:open` for any target (cross-tenant, and still '
      + "subject to the target organisation's consent policy), or an admin/owner of a strict "
      + "ancestor of the target's org holding `team_access:open` for its own subtree. Resolved "
      + 'per request against the org the session would pin to.',
    { reachableBy: ['superadmin', 'system-org', 'tenant-admin'], permissions: ['impersonation:open', 'team_access:open'] },
  ),
  requireAssurance({ minAssurance: 2 }),
  requireStepUp({ methods: STRONG_STEP_UP_METHODS }),
  audited('admin.impersonate.request', 'admin.impersonate.start'),
  impersonateUser,
);

export default router;
