// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An organization's impersonation policy — read and update.
 *
 *   GET   /organization/:id/impersonation-policy
 *   PATCH /organization/:id/impersonation-policy
 *
 * The effective policy (strictest across the org and its ancestors) is consulted
 * on every impersonation request: `open` approves on creation, `consent` sends a
 * challenge, `denied` refuses all but sysadmin break-glass.
 *
 * LOOSENING needs an `aal: 2` session: moving to a less strict mode, or letting
 * the impersonated person approve their own challenge, widens who can see the
 * org's data. Tightening stays open to a single-factor admin. Directional, so it
 * is checked here (`refuseWeakSession`) rather than on the route.
 */

import { createLogger, getParam, refuseWeakSession, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { canManageOrgScope, ensureAuthenticated, withController } from '../helpers/controller-helper.js';
import { canSelectDeniedPolicy, MIN_SYSADMINS_FOR_DENIED, resolveEffectiveImpersonationPolicy, resolveImpersonationPolicy } from '../helpers/impersonation-policy.js';
import { isLooseningImpersonation, orgExists, previousResolvedAsDoc, readImpersonationPolicy, withInheritedFromName, writeImpersonationPolicy } from '../services/org-policy-service.js';
import { updateImpersonationPolicySchema, validateBody } from '../utils/validation.js';

const logger = createLogger('org-impersonation-policy');

/**
 * Tenancy for both reads and writes: sysadmin, an admin of this org, or an admin
 * of a parent org managing this team. A parent setting its team's policy is
 * consistent with the model — the policy governs access from OUTSIDE the
 * account, and a team cannot use it to fence off its own parent.
 */
export const getImpersonationPolicy = withController('Get impersonation policy', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canManageOrgScope(req, id))) {
    return sendError(res, 403, 'You can only view the policy of an organization you administer');
  }

  if (!(await orgExists(id))) return sendError(res, 404, 'Organization not found');

  // Both the org's OWN setting and the EFFECTIVE one. A team's policy can be
  // tightened by its parent (strictest wins), so returning only `own` would let
  // an admin set `open` and never learn why it isn't open. Always resolved
  // server-side — a client must never re-derive defaults or inheritance.
  sendSuccess(res, 200, await withInheritedFromName(await resolveEffectiveImpersonationPolicy(id)));
});

export const updateImpersonationPolicy = withController('Update impersonation policy', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canManageOrgScope(req, id))) {
    return sendError(res, 403, 'You can only change the policy of an organization you administer');
  }

  const body = validateBody(updateImpersonationPolicySchema, req.body, res);
  if (!body) return;

  // Refuse the lockout up front. `denied` escalates break-glass to four-eyes —
  // with fewer than two sysadmins there is no second approver, so emergency
  // access would become impossible rather than merely expensive.
  if (body.impersonationPolicy === 'denied' && !(await canSelectDeniedPolicy())) {
    return sendError(
      res,
      409,
      `"denied" requires at least ${MIN_SYSADMINS_FOR_DENIED} sysadmin accounts, `
        + 'because emergency access under it needs a second approver. Choose "consent" instead.',
      'IMPERSONATION_DENIED_NEEDS_SECOND_SYSADMIN',
    );
  }

  const previous = await readImpersonationPolicy(id);
  if (!previous) return sendError(res, 404, 'Organization not found');

  const requested = resolveImpersonationPolicy({ ...previousResolvedAsDoc(previous), ...body });
  if (isLooseningImpersonation(previous, requested) && refuseWeakSession(req, res, { minAssurance: 2 })) return;

  const current = await writeImpersonationPolicy(id, body);
  if (!current) return sendError(res, 404, 'Organization not found');

  // What actually governs now. A team may have just set something its parent
  // overrides; the response says so rather than echoing a setting with no effect.
  const effective = await resolveEffectiveImpersonationPolicy(id);

  // Record both sides. Loosening this policy widens who can see the org's data,
  // so a reviewer needs to see the transition, not just the end state.
  audit(req, 'org.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: { impersonationPolicy: { from: previous, to: current } },
  });
  logger.info('Impersonation policy updated', { orgId: id, by: req.user!.sub, from: previous, to: current });

  const overridden = effective.inheritedFrom !== undefined;
  sendSuccess(
    res,
    200,
    await withInheritedFromName(effective),
    overridden
      ? 'Impersonation policy updated — but a parent organization requires a stricter policy, which applies instead'
      : 'Impersonation policy updated',
  );
});
