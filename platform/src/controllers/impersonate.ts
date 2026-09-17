// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Impersonation — read-only "view as user X".
 *
 *   POST /api/admin/impersonate/:userId
 *
 * Open to a platform SYSADMIN (any user) or to an admin of an org that is a
 * strict ANCESTOR of the target's org (their own subtree only) — see
 * `helpers/impersonation-authority.ts`. Step-up gated for both: a parent admin's
 * session is no less sensitive than a sysadmin's.
 *
 * Returns an access token that grants the
 * caller the target user's identity for the next 15 minutes. The token
 * carries `impersonationReadOnly: true` so the `requireWriteAccess`
 * middleware rejects any state-changing request — operators can
 * reproduce a tenant's view for support work without risk of acting
 * destructively under that identity.
 *
 * No refresh token is issued. The frontend stores the token, swaps it
 * into the api client, and clears it on "Stop impersonating".
 *
 * Every session is recorded as an `ImpersonationRequest` and the token is
 * REDEEMED against it, even though nothing is asked to approve one today. There
 * is deliberately no path that issues a token without a record — a future
 * consent policy changes only why a request reaches `approved`, never whether
 * one exists. See `services/impersonation-service.ts`.
 */

import crypto from 'crypto';
import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import type { Request } from 'express';
import { audit } from '../helpers/audit.js';
import { canAdministerOrg, isOrgAdmin, isSystemAdmin, withController } from '../helpers/controller-helper.js';
import { isTenantAdminOf, resolveImpersonationAuthority } from '../helpers/impersonation-authority.js';
import { resolveChallengeRoute, sendImpersonationChallenge } from '../helpers/impersonation-challenge.js';
import { notifyOrgOfBreakglass, notifyRequesterOfDecision, notifyTeamOfAncestorImpersonation } from '../helpers/impersonation-notify.js';
import { resolveEffectiveImpersonationPolicy } from '../helpers/impersonation-policy.js';
import { expandOrgScope } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
import { publishImpersonationSessionRevocation } from '../helpers/session-revocation.js';
import { ImpersonationRequest, User, UserOrganization, type ImpersonationApproverMode } from '../models/index.js';
import { decideInitialApproval, impersonationService } from '../services/impersonation-service.js';
import { issueImpersonationToken } from '../utils/token.js';

const logger = createLogger('impersonate');

export const impersonateUser = withController('Impersonate user', async (req, res) => {
  // NOT gated on sysadmin here: an ancestor-org admin may also impersonate
  // within their own subtree. Authority is resolved below, once the target's
  // pinned org is known — it depends on BOTH parties, so it cannot be a
  // route-level middleware the way the old sysadmin-only check was.
  if (!req.user) return sendError(res, 401, 'Authentication required');
  // Disallow impersonating from within an impersonation session — keeps
  // the audit trail straightforward (always requester → user, never chained).
  if (req.user?.impersonatorId) {
    return sendError(res, 400, 'Cannot impersonate from within an impersonation session');
  }

  const impersonatorId = req.user!.sub;
  const targetUserId = String(req.params.userId);
  if (targetUserId === impersonatorId) {
    return sendError(res, 400, 'Cannot impersonate yourself');
  }

  // `+isSuperAdmin` opts in to a schema field with `select: false`. Without
  // this, the check below would silently see `undefined` and let an
  // attacker (or a careless admin) impersonate a fellow sysadmin —
  // exactly the laundering-of-authority case the check is meant to
  // prevent.
  const target = await User.findById(targetUserId).select('+isSuperAdmin');
  if (!target) return sendError(res, 404, 'User not found');

  // Refuse to impersonate another sysadmin — defense against a compromised
  // sysadmin laundering authority by impersonating peers. Two sysadmins
  // should not be able to mask their action trails under each other.
  if ((target as { isSuperAdmin?: boolean }).isSuperAdmin === true) {
    return sendError(res, 400, 'Cannot impersonate another sysadmin');
  }

  // The org this session is pinned to. Today that's the target's own active org
  // — the same value the token used to derive internally. It is now passed
  // explicitly because the org is a property of the REQUEST, not of the target's
  // browsing history: a consent flow scopes the session to the org that approved
  // it, which is not necessarily wherever the user happened to be last.
  // Which organization the session is for. The caller may NAME it — a parent
  // admin picks a member from one of their teams, and that team is the org the
  // session must be about. Otherwise it's the target's active org.
  //
  // Without an explicit org, a team member who was last active in the PARENT
  // org would pin the session to the parent — the parent admin's own org — and
  // the request would be refused, even though they chose that member from the
  // team's roster. The org is a property of the request, not of the target's
  // browsing history.
  const requestedOrgId = typeof req.body?.orgId === 'string' && req.body.orgId ? req.body.orgId : undefined;
  let sessionOrgIdStr: string | undefined;
  if (requestedOrgId) {
    // A named org must actually be one the target belongs to — otherwise the
    // session would be scoped to an org the user has nothing to do with.
    const membership = await UserOrganization.findOne({
      userId: targetUserId, organizationId: toOrgId(requestedOrgId), isActive: true,
    }).select('_id').lean();
    if (!membership) {
      return sendError(res, 400, 'That user is not an active member of that organization', 'IMPERSONATION_NOT_A_MEMBER');
    }
    sessionOrgIdStr = requestedOrgId;
  } else {
    const lastActive = (target as { lastActiveOrgId?: unknown }).lastActiveOrgId;
    sessionOrgIdStr = lastActive != null ? String(lastActive) : undefined;
  }

  // Authority is resolved against the PINNED org, so the check and the token's
  // scope describe the same organization. A sysadmin may reach anyone; an
  // ancestor-org admin only into their own subtree.
  const authority = await resolveImpersonationAuthority(req, sessionOrgIdStr);
  if (authority.kind === 'none') {
    return sendError(res, 403, 'Forbidden: sysadmin or parent-organization admin only');
  }

  // A user with no organization cannot be impersonated: there is no policy to
  // consult and nobody to ask or notify.
  if (!sessionOrgIdStr) {
    return sendError(res, 400, 'Cannot impersonate a user with no organization', 'IMPERSONATION_NO_ORG');
  }

  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;

  // The org's EFFECTIVE policy (strictest across parent and team). An ancestor
  // admin isn't subject to it — a parent already administers its teams.
  const policy = authority.kind === 'ancestor' ? undefined : await resolveEffectiveImpersonationPolicy(sessionOrgIdStr);
  const decision = decideInitialApproval({ ancestorAuthority: authority.kind === 'ancestor', policy });

  if (decision.kind === 'refused') {
    return sendError(
      res, 403,
      'This organization only allows emergency access. Use emergency access if this is an incident.',
      'IMPERSONATION_POLICY_DENIED',
    );
  }

  // Where a challenge goes. An EXPLICIT choice is honoured or refused — never
  // silently rerouted. With no choice, the default follows the policy: the user
  // when they may approve their own account, the org's admins otherwise. A
  // default isn't a reroute, and without it an org that forbids self-approval
  // could never be asked from a UI that doesn't offer the choice.
  let route: ImpersonationApproverMode | undefined;
  if (decision.kind === 'pending' && policy) {
    const requested = req.body?.approverMode;
    if (requested !== undefined && requested !== 'user' && requested !== 'org_admin') {
      return sendError(res, 400, 'approverMode must be "user" or "org_admin"');
    }
    const resolvedRoute = resolveChallengeRoute(
      requested ?? (policy.allowSelfApproval ? 'user' : 'org_admin'),
      policy.allowSelfApproval,
    );
    if (!resolvedRoute.ok) {
      return sendError(
        res, 400,
        'This organization does not let members approve access to their own account. Ask its admins instead.',
        resolvedRoute.code,
      );
    }
    route = resolvedRoute.mode;
  }

  const request = await impersonationService.createRequest({
    requesterId: impersonatorId,
    targetUserId,
    orgId: sessionOrgIdStr,
    reason,
    decision,
    approverMode: route,
    approverUserId: route === 'user' ? targetUserId : undefined,
  });

  if (decision.kind === 'pending' && route) {
    const delivery = await sendImpersonationChallenge({
      mode: route, orgId: sessionOrgIdStr, targetUserId, requesterId: impersonatorId, reason,
    });
    if (delivery.delivered === 0) {
      // Nobody can see it. Say so now rather than leaving it pending for an hour
      // and letting the silence read as a refusal.
      await impersonationService.markUndeliverable(request.id);
      return sendError(
        res, 409,
        delivery.attempted === 0
          ? 'Nobody in this organization can approve the request.'
          : 'The approval request could not be delivered. Try again, or use emergency access for an incident.',
        'IMPERSONATION_UNDELIVERABLE',
      );
    }
    audit(req, 'admin.impersonate.request', {
      targetType: 'user',
      targetId: targetUserId,
      affectedOrgId: sessionOrgIdStr,
      details: { requestId: request.id, approverMode: route, delivered: delivery.delivered },
    });
    // No token: the requester opens the session from Access requests once it's approved.
    return sendSuccess(res, 202, { requestId: request.id, status: 'pending', approverMode: route });
  }

  const issued = await redeemAndIssue(req, request, target, sessionOrgIdStr);
  if (!issued.ok) return sendError(res, 409, 'Impersonation request is no longer redeemable', issued.code);

  // Informed, not asked: the team learns its parent viewed one of its members.
  // Deliberately not awaited — the notice describes the session, it does not
  // gate it, and a messaging hiccup must not fail an authorized request.
  if (authority.kind === 'ancestor' && sessionOrgIdStr) {
    void notifyTeamOfAncestorImpersonation({
      orgId: sessionOrgIdStr, requesterId: impersonatorId, targetUserId,
    });
  }

  // `requestId`/`status` are additive — existing clients read `accessToken` and
  // ignore the rest. They become load-bearing when a request can be pending.
  sendSuccess(res, 200, {
    accessToken: issued.accessToken,
    expiresIn: issued.expiresIn,
    targetUserId,
    requestId: request.id,
    status: 'consumed',
  });
});

/**
 * Redeem an approved request for its session token, and record the session.
 *
 * Shared by the two ways a session starts: inline on request (while a request is
 * approved on creation) and via the explicit redeem endpoint (once a consent
 * challenge makes a request wait). Keeping ONE implementation is what guarantees
 * both paths mint the same token, stamp the same `jti`, and write the same audit
 * event — two copies would drift.
 */
async function redeemAndIssue(
  req: Request,
  request: { id: string; approvalReason?: string },
  target: Parameters<typeof issueImpersonationToken>[0],
  orgId: string | undefined,
): Promise<{ ok: true; accessToken: string; expiresIn: number } | { ok: false; code: string }> {
  const requesterId = req.user!.sub;
  const targetUserId = String(target._id);

  // The session's own token id. Recorded on the request at redemption so the
  // session can later be revoked INDIVIDUALLY — revoking via the target's
  // `tokenVersion` would end their own sessions at the same time.
  const jti = crypto.randomBytes(16).toString('hex');

  // `consume` is the single-use gate: it only matches while the row is still
  // `approved`, so an approval can never be spent twice.
  const redeemed = await impersonationService.consume(request.id, jti);
  if (!redeemed.ok) {
    logger.warn('Impersonation request could not be redeemed', { requestId: request.id, code: redeemed.code });
    return redeemed;
  }

  const { accessToken, expiresIn } = await issueImpersonationToken(target, requesterId, orgId, jti);

  // Filed under the org the session is PINNED to — not the requester's org — so
  // that org's admins see it in their own audit view, and the trail and the
  // token's scope describe the same organization. `approvalReason` is what tells
  // a reviewer "nobody was asked" from "someone said yes".
  audit(req, 'admin.impersonate.start', {
    targetType: 'user',
    targetId: targetUserId,
    affectedOrgId: orgId,
    details: { expiresIn, requestId: request.id, approvalReason: request.approvalReason },
  });
  logger.info('Impersonation started', {
    requesterId, targetUserId, expiresIn, requestId: request.id, approvalReason: request.approvalReason,
  });
  return { ok: true, accessToken, expiresIn };
}

/**
 * POST /admin/impersonate/requests/:id/decide — approve or deny a pending
 * challenge.
 *
 * Unreachable in practice until a consent policy can make a request `pending`;
 * built and tested now so the policy switch is the only thing phase 5 adds.
 *
 * Authorization is intentionally NOT the impersonation authority check: the
 * decider is the person being asked, not someone asking. Two callers qualify —
 * the user the challenge names (approving access to their own account needs no
 * admin permission), or an admin of the org the session is pinned to.
 */
export const decideImpersonationRequest = withController('Decide impersonation request', async (req, res) => {
  if (!req.user) return sendError(res, 401, 'Authentication required');
  const requestId = String(req.params.id);
  const approve = req.body?.approve === true;

  const request = await ImpersonationRequest.findById(requestId).lean();
  if (!request) return sendError(res, 404, 'Request not found');

  const actorId = req.user.sub;

  // Nobody decides their own request. Without this a requester could open a
  // request and approve it themselves — a consent gate that gates nothing.
  if (String(request.requesterId) === actorId) {
    return sendError(res, 403, 'Forbidden: you cannot decide your own request');
  }

  if (request.breakglass) {
    // FOUR-EYES: emergency access is approved by a SECOND sysadmin, never by the
    // tenant — break-glass exists for when the tenant cannot or should not be asked.
    if (!isSystemAdmin(req)) {
      return sendError(res, 403, 'Forbidden: emergency access must be approved by a second sysadmin');
    }
  } else {
    // CONSENT belongs to the tenant: the named approver, or a genuine admin of the
    // org. NOT `canAdministerOrg` — it short-circuits true for any sysadmin, which
    // would let a platform operator consent on the tenant's behalf.
    const isNamedApprover = request.approverUserId != null && String(request.approverUserId) === actorId;
    const isTenantAdmin = request.orgId != null && await isTenantAdminOf(req, String(request.orgId));
    if (!isNamedApprover && !isTenantAdmin) {
      return sendError(res, 403, 'Forbidden: you were not asked to decide this request');
    }
  }

  const decided = await impersonationService.decide(requestId, actorId, approve, request.breakglass === true);
  if (!decided.ok) {
    // A stale prompt — someone else already answered, or the window closed.
    // Reported rather than silently overwriting the first decision.
    return sendError(res, 409, 'Request is no longer pending', decided.code);
  }

  audit(req, approve ? 'admin.impersonate.approve' : 'admin.impersonate.deny', {
    targetType: 'user',
    targetId: String(request.targetUserId),
    affectedOrgId: request.orgId != null ? String(request.orgId) : undefined,
    details: { requestId },
  });

  // Tell the requester. Not awaited: the decision is recorded and visible on
  // their Access requests page regardless, so a notice hiccup must not fail it.
  void notifyRequesterOfDecision({
    requesterId: String(request.requesterId),
    targetUserId: String(request.targetUserId),
    deciderId: actorId,
    approved: approve,
    breakglass: request.breakglass === true,
  });
  sendSuccess(res, 200, { requestId, status: decided.request.status });
});

/**
 * POST /admin/impersonate/requests/:id/revoke — end a live session early.
 *
 * Consent that cannot be withdrawn is not consent. Revoking flips the record,
 * and the auth middleware resolves every impersonated request by `jti` and
 * requires `consumed` — so the session stops on its next request rather than
 * running out its TTL.
 *
 * Who may: the approver, an admin of the pinned org (including under the
 * ancestor path, where nobody was asked), or the requester ending their own
 * session rather than walking away from a live token.
 */
export const revokeImpersonationSession = withController('Revoke impersonation session', async (req, res) => {
  if (!req.user) return sendError(res, 401, 'Authentication required');
  const requestId = String(req.params.id);

  const request = await ImpersonationRequest.findById(requestId).lean();
  if (!request) return sendError(res, 404, 'Request not found');

  const actorId = req.user.sub;
  const isSubject = String(request.targetUserId) === actorId;
  const isRequester = String(request.requesterId) === actorId;
  const isDecider = request.decidedBy != null && String(request.decidedBy) === actorId;
  const isOrgAdminHere = request.orgId != null && await canAdministerOrg(req, String(request.orgId));
  if (!isSubject && !isRequester && !isDecider && !isOrgAdminHere) {
    return sendError(res, 403, 'Forbidden');
  }

  const revoked = await impersonationService.revoke(requestId, actorId);
  if (!revoked.ok) return sendError(res, 409, 'No live session to end', revoked.code);

  // The platform already refuses the token (its auth reads the session record).
  // Publishing makes every OTHER service refuse it too. If that didn't land, say
  // so — the person ending the session must not be told it's over while the token
  // still works elsewhere.
  const revokedEverywhere = revoked.request.jti
    ? await publishImpersonationSessionRevocation(revoked.request.jti, revoked.request.consumedAt)
    : true;
  if (!revokedEverywhere) {
    logger.warn('Impersonation session ended on the platform only', { requestId });
  }

  audit(req, 'admin.impersonate.revoke', {
    targetType: 'user',
    targetId: String(request.targetUserId),
    affectedOrgId: request.orgId != null ? String(request.orgId) : undefined,
    details: { requestId, revokedEverywhere },
  });
  logger.info('Impersonation session revoked', { requestId, actorId, revokedEverywhere });
  sendSuccess(res, 200, { requestId, status: 'revoked', revokedEverywhere });
});

/**
 * POST /admin/impersonate/requests/:id/redeem — exchange an approved request for
 * its session token.
 *
 * The second half of a consented session: once a challenge makes a request wait,
 * the requester comes back here after it is approved. Unreached while requests
 * are still approved on creation, which redeem inline.
 *
 * Only the REQUESTER may redeem. An approval grants a session to the person who
 * asked for it — not to whoever happens to learn the request id.
 */
export const redeemImpersonationRequest = withController('Redeem impersonation request', async (req, res) => {
  if (!req.user) return sendError(res, 401, 'Authentication required');
  if (req.user.impersonatorId) {
    return sendError(res, 400, 'Cannot impersonate from within an impersonation session');
  }
  const requestId = String(req.params.id);

  const request = await ImpersonationRequest.findById(requestId).lean();
  if (!request) return sendError(res, 404, 'Request not found');
  if (String(request.requesterId) !== req.user.sub) {
    return sendError(res, 403, 'Forbidden: only the requester can redeem this request');
  }

  const target = await User.findById(String(request.targetUserId)).select('+isSuperAdmin');
  if (!target) return sendError(res, 404, 'User not found');
  // Re-checked at redemption, not only at request time: the target may have been
  // made a sysadmin during the approval window.
  if ((target as { isSuperAdmin?: boolean }).isSuperAdmin === true) {
    return sendError(res, 400, 'Cannot impersonate another sysadmin');
  }

  const orgId = request.orgId != null ? String(request.orgId) : undefined;
  const issued = await redeemAndIssue(
    req,
    { id: requestId, approvalReason: request.approvalReason },
    target,
    orgId,
  );
  if (!issued.ok) return sendError(res, 409, 'Impersonation request is no longer redeemable', issued.code);

  sendSuccess(res, 200, {
    accessToken: issued.accessToken,
    expiresIn: issued.expiresIn,
    targetUserId: String(request.targetUserId),
    requestId,
    status: 'consumed',
  });
});

/** Minimum justification length — a one-word reason is not a justification. */
export const BREAKGLASS_JUSTIFICATION_MIN = 20;

/**
 * POST /admin/impersonate/:userId/breakglass — EMERGENCY access over an org's
 * impersonation policy.
 *
 * Sysadmin only: this is the platform operator's escape hatch for incidents,
 * when the tenant cannot or should not be asked. (A parent-org admin never needs
 * it — they already reach their own teams without a challenge.)
 *
 * Deliberately expensive and loud rather than blocked:
 *   - a written justification is required, and shown to the org;
 *   - every org admin is notified at once;
 *   - under an org's `denied` policy, or past the operator's rate cap, a SECOND
 *     sysadmin must approve before any token exists (four-eyes);
 *   - it is audited as `admin.impersonate.breakglass`, never as an ordinary start.
 *
 * A user with no organization is refused here too — there is no org to notify,
 * so emergency access would be exactly the unobserved bypass this is designed not
 * to be.
 */
export const breakglassImpersonation = withController('Break-glass impersonation', async (req, res) => {
  if (!req.user) return sendError(res, 401, 'Authentication required');
  if (!isSystemAdmin(req)) return sendError(res, 403, 'Forbidden: emergency access is sysadmin only');
  if (req.user.impersonatorId) {
    return sendError(res, 400, 'Cannot impersonate from within an impersonation session');
  }

  const requesterId = req.user.sub;
  const targetUserId = String(req.params.userId);
  if (targetUserId === requesterId) return sendError(res, 400, 'Cannot impersonate yourself');

  const justification = typeof req.body?.justification === 'string' ? req.body.justification.trim() : '';
  if (justification.length < BREAKGLASS_JUSTIFICATION_MIN) {
    return sendError(
      res, 400,
      `Emergency access needs a written justification of at least ${BREAKGLASS_JUSTIFICATION_MIN} characters. `
        + 'It is shown to the organization.',
      'BREAKGLASS_JUSTIFICATION_REQUIRED',
    );
  }

  const target = await User.findById(targetUserId).select('+isSuperAdmin');
  if (!target) return sendError(res, 404, 'User not found');
  if ((target as { isSuperAdmin?: boolean }).isSuperAdmin === true) {
    return sendError(res, 400, 'Cannot impersonate another sysadmin');
  }

  const sessionOrgId = (target as { lastActiveOrgId?: unknown }).lastActiveOrgId;
  const orgId = sessionOrgId != null ? String(sessionOrgId) : undefined;
  if (!orgId) {
    return sendError(res, 400, 'Cannot impersonate a user with no organization', 'IMPERSONATION_NO_ORG');
  }

  const policy = await resolveEffectiveImpersonationPolicy(orgId);
  const { request, fourEyes, recentCount } = await impersonationService.createBreakglassRequest({
    requesterId, targetUserId, orgId, justification, policy,
  });

  const notice = await notifyOrgOfBreakglass({
    orgId, requesterId, targetUserId, justification, recentCount, awaitingSecondSysadmin: fourEyes !== null,
  });

  // Audited as break-glass from the moment it is ASKED FOR, not only once it
  // succeeds — including how many admins were actually reached, so a notice that
  // silently failed is visible afterwards.
  audit(req, 'admin.impersonate.breakglass', {
    targetType: 'user',
    targetId: targetUserId,
    affectedOrgId: orgId,
    details: {
      requestId: request.id,
      justification,
      fourEyes,
      recentCount,
      policy: policy.policy,
      policyResolved: policy.resolved,
      notified: notice,
    },
  });

  if (fourEyes) {
    // Nothing is issued yet: a second sysadmin decides via the ordinary decide
    // endpoint, and the requester then redeems.
    return sendSuccess(res, 202, {
      requestId: request.id,
      status: 'pending',
      awaiting: 'second_sysadmin',
      reason: fourEyes,
    });
  }

  const issued = await redeemAndIssue(req, request, target, orgId);
  if (!issued.ok) return sendError(res, 409, 'Emergency request is no longer redeemable', issued.code);

  sendSuccess(res, 200, {
    accessToken: issued.accessToken,
    expiresIn: issued.expiresIn,
    targetUserId,
    requestId: request.id,
    status: 'consumed',
  });
});

const LIST_VIEWS = ['to-decide', 'mine', 'sessions'] as const;
type ListView = typeof LIST_VIEWS[number];

/**
 * GET /admin/impersonate/requests?view=to-decide|mine|sessions
 *
 * What a person can act on. Open to every authenticated user — the impersonated
 * user must be able to see a request to view their own account, and they are
 * usually not an admin. Everything is filtered server-side by the SAME rules as
 * decide and revoke; see `impersonationService.listForCaller`.
 */
export const listImpersonationRequests = withController('List impersonation requests', async (req, res) => {
  if (!req.user) return sendError(res, 401, 'Authentication required');
  const view = String(req.query.view ?? '') as ListView;
  if (!(LIST_VIEWS as readonly string[]).includes(view)) {
    return sendError(res, 400, `view must be one of: ${LIST_VIEWS.join(', ')}`);
  }

  // The orgs this caller holds TENANT admin authority over: their active org and
  // its subtree. Deliberately not widened for sysadmins here — sysadmin reach is
  // applied per view inside listForCaller, where it is correct (break-glass to
  // decide, live sessions to revoke) and nowhere else.
  const activeOrgId = req.user.organizationId;
  const adminOrgIds = isOrgAdmin(req) && activeOrgId ? await expandOrgScope(activeOrgId) : [];

  const requests = await impersonationService.listForCaller(
    { userId: req.user.sub, isSysadmin: isSystemAdmin(req), adminOrgIds },
    view,
  );
  sendSuccess(res, 200, { requests });
});
